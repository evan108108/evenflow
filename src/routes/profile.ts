// /api/v0 profile — public user profiles backed by kind-0 events on 4a,
// cached in profileCache for chip-speed reads.
//
// The substrate is the source of truth: PUT publishes a standard Nostr
// kind 0 through the gateway (KMS-signed, relay fan-out) and only then
// caches the row locally, so cache and substrate can't fork. Reads are
// lazy: serve the cached row while it's fresh (15 min), refresh from 4a
// past that, and degrade to the stale row — warn-logged, never an error —
// when 4a is unreachable. A pubkey with no kind 0 at all still resolves
// 200 with empty fields; bulk chip rendering depends on misses being data.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { AuditLog, Db, DbError, FourA, FourAError, bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { callerPubkey } from "../authz";

export const PROFILE_CACHE_TTL_MS = 15 * 60 * 1000;
export const BULK_MAX = 100;

// Mirror the gateway's caps so bad input fails here with a field-named 400
// instead of a relayed gateway error. Rejections never truncate.
const NAME_MAX = 64;
const DISPLAY_NAME_MAX = 128;
const PICTURE_MAX = 512;
const ABOUT_MAX = 4000;

const BEARER_PREFIX = "Bearer ";

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}

type ProfileFailure = ValidationError | DbError | FourAError;

export interface ProfileShape {
  readonly pubkey: string;
  readonly name: string | null;
  readonly display_name: string | null;
  readonly picture: string | null;
  readonly about: string | null;
  readonly event_id: string | null;
  readonly updated_at_ms: number | null;
}

const emptyProfile = (pubkey: string): ProfileShape => ({
  pubkey,
  name: null,
  display_name: null,
  picture: null,
  about: null,
  event_id: null,
  updated_at_ms: null,
});

type CacheRow = Record<string, unknown>;

const rowToProfile = (row: CacheRow): ProfileShape => ({
  pubkey: String(row["pubkey"]),
  name: (row["name"] as string | null) ?? null,
  display_name: (row["display_name"] as string | null) ?? null,
  picture: (row["picture"] as string | null) ?? null,
  about: (row["about"] as string | null) ?? null,
  event_id: (row["event_id"] as string | null) ?? null,
  updated_at_ms: ((row["updated_at_ms"] as number | null) ?? 0) === 0
    ? null
    : (row["updated_at_ms"] as number),
});

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<ProfileFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "FourAError":
        return c.json({ error: "substrate", reason: `4a-${f.reason}` }, 502);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

const upsertCache = (profile: ProfileShape, fetchedAtMs: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.execute(
      `INSERT INTO profileCache (pubkey, name, display_name, picture, about, event_id, updated_at_ms, fetched_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET name = excluded.name, display_name = excluded.display_name, picture = excluded.picture, about = excluded.about, event_id = excluded.event_id, updated_at_ms = excluded.updated_at_ms, fetched_at_ms = excluded.fetched_at_ms`,
      [
        profile.pubkey,
        profile.name,
        profile.display_name,
        profile.picture,
        profile.about,
        profile.event_id,
        profile.updated_at_ms ?? 0,
        fetchedAtMs,
      ],
    );
  });

/**
 * The lazy-cache read every GET shares: fresh row → serve it; stale/missing
 * → refresh from 4a and cache (misses too — a pubkey with no kind 0 gets an
 * empty row so chip rendering doesn't re-poll the substrate every 15
 * minutes for users who never wrote a profile); 4a failure → warn + stale
 * row if present, else empty.
 */
const resolveProfile = (
  pubkey: string,
): Effect.Effect<ProfileShape, DbError, Db | FourA> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    const row = yield* db.queryFirst<CacheRow>(
      "SELECT * FROM profileCache WHERE pubkey = ?",
      [pubkey],
    );
    if (row !== null && now - (row["fetched_at_ms"] as number) < PROFILE_CACHE_TTL_MS) {
      return rowToProfile(row);
    }

    const fourA = yield* FourA;
    const remote = yield* fourA.fetchProfile(pubkey).pipe(Effect.either);
    if (remote._tag === "Left") {
      console.warn(`[profile] 4a fetch failed for ${pubkey}: ${remote.left.reason}${remote.left.detail === undefined ? "" : ` (${remote.left.detail})`}`);
      return row === null ? emptyProfile(pubkey) : rowToProfile(row);
    }

    const profile: ProfileShape = {
      pubkey,
      name: remote.right.fields.name ?? null,
      display_name: remote.right.fields.display_name ?? null,
      picture: remote.right.fields.picture ?? null,
      about: remote.right.fields.about ?? null,
      event_id: remote.right.event_id,
      updated_at_ms: remote.right.updated_at_ms,
    };
    yield* upsertCache(profile, now);
    return profile;
  });

/** Validate one optional profile field: string under cap, "" normalized to absent. */
const readField = (
  body: Record<string, unknown>,
  field: "name" | "display_name" | "picture" | "about",
  max: number,
): Effect.Effect<string | undefined, ValidationError> =>
  Effect.gen(function* () {
    const value = body[field];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") return yield* new ValidationError({ reason: field });
    if (value.length > max) return yield* new ValidationError({ reason: `${field}-too-long` });
    return value;
  });

export const makeProfileRouter = (layerFor: LayerFor = bootstrap) => {
  const profile = new Hono<AppHonoEnv>();

  const runJson = async (
    c: Context<AppHonoEnv>,
    program: Effect.Effect<unknown, ProfileFailure, Db | FourA | AuditLog>,
  ) => {
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, 200);
  };

  // ── GET /profile/me ─────────────────────────────────────────────────────
  profile.get("/profile/me", async (c) => {
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const me = yield* resolveProfile(callerPubkey(claims));
      // Fresh-user display seed: no kind 0 and nothing named yet → show the
      // login-prefix instead of the raw provider:oauth_id. Response-only —
      // never cached, never published — so the substrate stays exactly what
      // the user chose to write.
      if (me.event_id === null && me.display_name === null && me.name === null) {
        return { profile: { ...me, display_name: claims.login.split("@")[0] ?? null } };
      }
      return { profile: me };
    });
    return runJson(c, program);
  });

  // ── PUT /profile/me ─────────────────────────────────────────────────────
  // Full replacement of the four kind-0 fields: publish to 4a first (the
  // substrate is the source of truth), cache only what actually published.
  profile.put("/profile/me", async (c) => {
    const claims = c.get("claims");
    const token = (c.req.header("Authorization") ?? "").slice(BEARER_PREFIX.length).trim();
    const program = Effect.gen(function* () {
      const pubkey = callerPubkey(claims);
      const body = yield* Effect.tryPromise({
        try: () => c.req.json() as Promise<Record<string, unknown>>,
        catch: () => new ValidationError({ reason: "expected-json" }),
      }).pipe(
        Effect.filterOrFail(
          (b): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b),
          () => new ValidationError({ reason: "expected-json-object" }),
        ),
      );

      const name = yield* readField(body, "name", NAME_MAX);
      const displayName = yield* readField(body, "display_name", DISPLAY_NAME_MAX);
      const picture = yield* readField(body, "picture", PICTURE_MAX);
      if (picture !== undefined && !picture.startsWith("https://")) {
        return yield* new ValidationError({ reason: "picture-not-https" });
      }
      const about = yield* readField(body, "about", ABOUT_MAX);

      const fourA = yield* FourA;
      const published = yield* fourA.publishProfile(token, {
        ...(name === undefined ? {} : { name }),
        ...(displayName === undefined ? {} : { display_name: displayName }),
        ...(picture === undefined ? {} : { picture }),
        ...(about === undefined ? {} : { about }),
      });

      const now = yield* Clock.currentTimeMillis;
      const updated: ProfileShape = {
        pubkey,
        name: name ?? null,
        display_name: displayName ?? null,
        picture: picture ?? null,
        about: about ?? null,
        event_id: published.event_id,
        updated_at_ms: now,
      };
      yield* upsertCache(updated, now);

      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "profile_updated",
        actor: claims.login,
        details: { event_id: published.event_id, hex_pubkey: published.pubkey },
      });
      return { profile: updated };
    });
    return runJson(c, program);
  });

  // ── GET /profile?pubkeys=a,b,c — bulk resolve for chip rendering ────────
  // Registered before /profile/:pubkey so the bare path wins the match.
  profile.get("/profile", async (c) => {
    const raw = c.req.query("pubkeys");
    const program = Effect.gen(function* () {
      if (raw === undefined || raw.trim() === "") {
        return yield* new ValidationError({ reason: "pubkeys" });
      }
      const pubkeys = [...new Set(raw.split(",").map((p) => p.trim()).filter((p) => p !== ""))];
      if (pubkeys.length === 0) return yield* new ValidationError({ reason: "pubkeys" });
      if (pubkeys.length > BULK_MAX) {
        return yield* new ValidationError({ reason: `pubkeys-max-${BULK_MAX}` });
      }
      const profiles = yield* Effect.all(
        pubkeys.map((p) => resolveProfile(p)),
        { concurrency: 8 },
      );
      return { profiles };
    });
    return runJson(c, program);
  });

  // ── GET /profile/:pubkey ────────────────────────────────────────────────
  profile.get("/profile/:pubkey", async (c) => {
    const program = Effect.gen(function* () {
      const me = yield* resolveProfile(c.req.param("pubkey"));
      return { profile: me };
    });
    return runJson(c, program);
  });

  return profile;
};
