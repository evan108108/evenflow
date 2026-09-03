/**
 * Profile actions — public user profiles backed by kind-0 events on 4a,
 * cached in profileCache for chip-speed reads.
 *
 * The substrate is the source of truth: PUT publishes a standard Nostr kind 0
 * through the gateway (KMS-signed, relay fan-out) and only then caches the row
 * locally, so cache and substrate can't fork. Reads are lazy: serve the cached
 * row while it's fresh (15 min), refresh from 4a past that, and degrade to the
 * stale row — warn-logged, never an error — when 4a is unreachable. A pubkey
 * with no kind 0 at all still resolves 200 with empty fields; bulk chip
 * rendering depends on misses being data.
 *
 * EFB-98 split src/routes/profile.ts in two. Bodies moved VERBATIM; the only
 * edits read params/body/query/claims/token off `input`.
 *
 * THREE THINGS THE ROUTE KEEPS, each for a stated reason:
 *
 *  - The RAW READS. `POST /profile/picture`, `PUT /profile/me` and
 *    `GET /profile` are all on a boundary allowlist pinned to
 *    src/routes/profile.ts, and both checkers scan src/routes as text. A read
 *    moved in here would leave those entries describing nothing while the
 *    checker kept exiting 0 — detected debt silently downgraded to declared
 *    (EFB-98 rule 11). The reads are constructed there and consumed here; the
 *    POLICY over what they produce is business logic and lives here (rule 12).
 *
 *  - The 401. These handlers answer `missing-authorization`, where
 *    `requireCaller` answers `authentication-required`. Different string, on
 *    the wire, and a mechanical migration may not change it
 *    (BOUNDARY_DISCIPLINE.md:244). The route keeps its own check verbatim.
 *
 *  - errorResponse, which maps ProfileFailure to status codes — the one part
 *    that genuinely is transport, and whose mapping here is NOT the shared
 *    one (FourAError answers 502 `4a-<reason>`).
 */

import { Clock, Effect } from "effect";

import { AuditLog, Db, DbError, FourA, FourAError } from "../effects";
import { callerPubkey } from "../authz";
import { canonicalizeIdentityRef } from "../lib/identity";
import { ValidationError } from "../lib/errors";
import type { ActionInput, PublicActionInput } from "./types";

export const PROFILE_CACHE_TTL_MS = 15 * 60 * 1000;
export const BULK_MAX = 100;

// Mirror the gateway's caps so bad input fails here with a field-named 400
// instead of a relayed gateway error. Rejections never truncate.
const NAME_MAX = 64;
const DISPLAY_NAME_MAX = 128;
const PICTURE_MAX = 512;
const ABOUT_MAX = 4000;

// Picture uploads (proxied to 4a's POST /v0/blob). Server-side downscale /
// re-encode (512px + JPEG) is a follow-up; v1 trusts the client to send a
// reasonable size under the hard cap.
export const MAX_UPLOAD_BYTES = 256 * 1024;
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export type ProfileFailure = ValidationError | DbError | FourAError;

/** Services the profile actions need. */
export type ProfileServices = Db | FourA | AuditLog;

export interface ProfileShape {
  readonly pubkey: string;
  readonly name: string | null;
  readonly display_name: string | null;
  readonly picture: string | null;
  readonly about: string | null;
  readonly event_id: string | null;
  readonly updated_at_ms: number | null;
  /**
   * Email local-part seeded on session bootstrap (migration 0032). Read by
   * the client's authorLabel as the last friendly fallback before the raw
   * 8-char pubkey prefix — so a member who has never published a kind:0
   * still shows up as "evan.frohlich" rather than "google:1…" across the
   * app. Written ONLY at bootstrap; upsertCache never touches it, so a
   * 4A refresh returning empty fields cannot wipe the fallback.
   */
  readonly login_prefix: string | null;
}

/** What the route's raw image read produces once it has run. */
export interface UploadedImage {
  readonly bytes: Uint8Array;
  readonly imageType: string;
}

const emptyProfile = (pubkey: string): ProfileShape => ({
  pubkey,
  name: null,
  display_name: null,
  picture: null,
  about: null,
  event_id: null,
  updated_at_ms: null,
  login_prefix: null,
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
  login_prefix: (row["login_prefix"] as string | null) ?? null,
});

const upsertCache = (profile: ProfileShape, fetchedAtMs: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    // login_prefix is written by bootstrapSession and NEVER touched here,
    // even on INSERT: if a profile refresh precedes the owner's next
    // bootstrap the row lands with login_prefix=NULL, and their next
    // sign-in fills it in (see seedLoginPrefix in actions/session.ts).
    // That is the whole preserve-on-null discipline migration 0032
    // documents in one place.
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
      // Preserved from the row on this refresh — bootstrapSession is the
      // only writer, and a 4A refresh must not wipe the fallback (see
      // migration 0032 header). Serve the row's value if we had one.
      login_prefix: (row?.["login_prefix"] as string | null) ?? null,
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

/** GET /profile/me. */
export const getMyProfile = (
  input: ActionInput,
): Effect.Effect<unknown, ProfileFailure, ProfileServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const me = yield* resolveProfile(callerPubkey(claims));
    let out = me;
    // Fresh-user display seed: no kind 0 and nothing named yet → show the
    // login-prefix instead of the raw provider:oauth_id. Response-only —
    // never cached, never published — so the substrate stays exactly what
    // the user chose to write.
    if (me.event_id === null && me.display_name === null && me.name === null) {
      out = { ...out, display_name: claims.login.split("@")[0] ?? null };
    }
    // OAuth avatar seed. Previously response-only ("save to keep it"),
    // but that meant every card-side profile lookup returned picture:null
    // for users who signed in with OAuth and never explicitly saved. Now
    // we persist it to profileCache the first time we see it, so bulk
    // lookups from cards / assignee avatars find the picture too. Users
    // can still replace it explicitly. seeded_from is left set so the UI
    // can still surface the "provider avatar" affordance if it wants.
    let seeded_from: "oauth" | null = null;
    if (out.picture === null && claims.picture !== undefined) {
      out = { ...out, picture: claims.picture };
      seeded_from = "oauth";
      const db = yield* Db;
      const nowMs = yield* Clock.currentTimeMillis;
      yield* db.execute(
        "UPDATE profileCache SET picture = ?, updated_at_ms = ?, fetched_at_ms = ? WHERE pubkey = ? AND picture IS NULL",
        [claims.picture, nowMs, nowMs, callerPubkey(claims)],
      );
    }
    return { profile: out, seeded_from };
  });

/**
 * POST /profile/picture — stage a profile picture.
 *
 * Validate, proxy the bytes to 4a's blob store, return the immutable URL.
 * Deliberately does NOT publish a kind 0 — the URL only reaches the substrate
 * when the user Saves (PUT /profile/me), so the UI can preview before anything
 * goes public.
 *
 * THE REFERENCE CASE FOR RULE 12 — the raw read and its validation live in
 * DIFFERENT FILES, and the instinct to keep them together is the trap.
 *
 * `input.body` is the route's un-run read: the multipart-vs-JSON branch that
 * turns a request into `{bytes, imageType}`. It stays in src/routes/profile.ts
 * because it carries the `c.req.formData()` / `c.req.json()` markers this
 * route's boundary-allowlist entry is pinned to (rule 11) — drag it in here
 * and the entry silently stops describing anything.
 *
 * What is NOT transport is the POLICY over the result: which image types are
 * allowed, that zero bytes is not an image, and the size ceiling. Those decide
 * what a profile picture IS, so they are here (rule 4).
 *
 * NOT a rule-10 deferral. The read is yielded FIRST because it always was
 * first — nothing gates above it in the pre-split handler. It arrives as an
 * Effect for the file-placement reason above, not an ordering one; deferring
 * it below anything would flip this route the other way.
 */
export const createProfilePicture = (
  input: ActionInput<Effect.Effect<UploadedImage, ValidationError, never>>,
): Effect.Effect<unknown, ProfileFailure, ProfileServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const { bytes, imageType } = yield* input.body;

    if (!ALLOWED_IMAGE_TYPES.includes(imageType)) {
      return yield* new ValidationError({ reason: "unsupported-image-type" });
    }
    if (bytes.byteLength === 0) {
      return yield* new ValidationError({ reason: "empty-image" });
    }
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return yield* new ValidationError({ reason: "image-too-large" });
    }

    const fourA = yield* FourA;
    const blob = yield* fourA.uploadBlob(input.token, bytes, imageType);

    const audit = yield* AuditLog;
    yield* audit.record({
      event_type: "profile_picture_uploaded",
      actor: claims.login,
      details: { sha256: blob.sha256, bytes: bytes.byteLength, content_type: imageType },
    });
    return { url: blob.url, sha256: blob.sha256 };
  });

/**
 * PUT /profile/me — full replacement of the four kind-0 fields.
 *
 * Publish to 4a first (the substrate is the source of truth), cache only what
 * actually published.
 *
 * `input.body` is the route's un-run raw read, pinned there by this route's
 * boundary-allowlist entry (rule 11). Yielded FIRST, exactly where the read
 * has always sat — nothing gates above it, so this is not a rule-10 deferral.
 */
export const setMyProfile = (
  input: ActionInput<Effect.Effect<Record<string, unknown>, ValidationError, never>>,
): Effect.Effect<unknown, ProfileFailure, ProfileServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const pubkey = callerPubkey(claims);
    const body = yield* input.body;

    const name = yield* readField(body, "name", NAME_MAX);
    const displayName = yield* readField(body, "display_name", DISPLAY_NAME_MAX);
    const picture = yield* readField(body, "picture", PICTURE_MAX);
    if (picture !== undefined && !picture.startsWith("https://")) {
      return yield* new ValidationError({ reason: "picture-not-https" });
    }
    const about = yield* readField(body, "about", ABOUT_MAX);

    const fourA = yield* FourA;
    const published = yield* fourA.publishProfile(input.token, {
      ...(name === undefined ? {} : { name }),
      ...(displayName === undefined ? {} : { display_name: displayName }),
      ...(picture === undefined ? {} : { picture }),
      ...(about === undefined ? {} : { about }),
    });

    const now = yield* Clock.currentTimeMillis;
    // Preserve the bootstrap-seeded login_prefix on this write, same rule
    // as resolveProfile — this handler goes through upsertCache too.
    const db = yield* Db;
    const existing = yield* db.queryFirst<{ login_prefix: string | null }>(
      "SELECT login_prefix FROM profileCache WHERE pubkey = ?",
      [pubkey],
    );
    const updated: ProfileShape = {
      pubkey,
      name: name ?? null,
      display_name: displayName ?? null,
      picture: picture ?? null,
      about: about ?? null,
      event_id: published.event_id,
      updated_at_ms: now,
      login_prefix: existing?.login_prefix ?? null,
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

/**
 * GET /profile?pubkeys=a,b,c — bulk resolve for chip rendering.
 *
 * The raw `pubkeys` query read stays in the route (rule 11 — this route is on
 * the query allowlist); everything below decides what the parameter MEANS,
 * which is rule 12's other half.
 */
export const listProfiles = (
  input: PublicActionInput,
): Effect.Effect<unknown, ProfileFailure, ProfileServices> =>
  Effect.gen(function* () {
    const raw = input.query["pubkeys"];
    if (raw === undefined || raw.trim() === "") {
      return yield* new ValidationError({ reason: "pubkeys" });
    }
    // EFB-51: normalize BEFORE the Set, not after. Dedupe on raw strings
    // would let `049b628c…` and `nostr:049b628c…` survive as two entries
    // that then resolve to one identity — the caller gets the same person
    // twice and the cache is read under a key nothing writes.
    //
    // Unnormalizable input is passed through UNCHANGED rather than
    // rejected, deliberately and unlike the single-pubkey routes. This is
    // the chip-rendering path: today a junk pubkey yields one empty
    // profile, and turning that into a 400 would fail an entire board's
    // avatars over one stale id. Leniency here is a UX decision, not an
    // oversight — see the test that pins it.
    const pubkeys = [
      ...new Set(
        raw
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p !== "")
          .map((p) => canonicalizeIdentityRef(p) ?? p),
      ),
    ];
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

/**
 * GET /profile/:pubkey.
 *
 * EFB-51: the last `:pubkey` route reading the param raw. profileCache is
 * keyed by the canonical ref every write path stores (EFB-38), so passing
 * the URL through unnormalized meant `/profile/049b628c…` and
 * `/profile/npub1qjdk…` both missed the row written as
 * `nostr:049b628c…` — one person, three spellings, two of them invisible.
 * Reading through the same canonicalizer the write paths use is what keeps
 * the cache single-keyed; a second normalization rule here would just be a
 * new way to drift.
 */
export const getProfile = (
  input: PublicActionInput,
): Effect.Effect<unknown, ProfileFailure, ProfileServices> =>
  Effect.gen(function* () {
    // 400 rather than 404: "that is not a pubkey" and "nobody by that
    // pubkey" are different answers, and collapsing them would report a
    // typo as an absent person.
    const ref = canonicalizeIdentityRef(input.params["pubkey"] ?? "");
    if (ref === null) return yield* new ValidationError({ reason: "pubkey" });
    const me = yield* resolveProfile(ref);
    return { profile: me };
  });
