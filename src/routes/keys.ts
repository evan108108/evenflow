// /api/v0/keys — developer API key management (phase 19).
//
// The plaintext key exists exactly once, in the POST response; the list
// endpoint returns metadata only (name, display prefix, timestamps).
// Revocation is a soft flag — the row stays for the audit trail, the
// middleware filters revoked keys at lookup.
//
// JWT-only surface on purpose: a key cannot mint or revoke keys, so a
// leaked key can never escalate to more keys. requireCaller still runs
// (the router mounts behind optionalAuth like everything else); the
// key-token guard is explicit below.

import { Hono } from "hono";
import { path } from "../routes-manifest";
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { AuditLog, Db, DbError, bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import {
  ForbiddenError,
  UnauthorizedError,
  callerPubkey,
  requireCaller,
} from "../authz";
import { API_KEY_NAME_MAX, generateApiKey, hashApiKey, isApiKeyToken } from "../apikeys";

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}

type KeysFailure = ValidationError | NotFoundError | UnauthorizedError | ForbiddenError | DbError;

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<KeysFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "UnauthorizedError":
        return c.json({ error: "unauthorized", reason: f.reason }, 401);
      case "ForbiddenError":
        return c.json({ error: "forbidden", reason: f.reason }, 403);
      case "NotFoundError":
        return c.json({ error: "not-found", reason: f.reason }, 404);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

/** Metadata shape the list/read paths return — never the hash. */
interface KeyView {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly created_at_ms: number;
  readonly last_used_at_ms: number | null;
  readonly revoked_at_ms: number | null;
}

export const makeKeysRouter = (layerFor: LayerFor = bootstrap) => {
  const keys = new Hono<AppHonoEnv>();

  const runJson = async (
    c: Context<AppHonoEnv>,
    program: Effect.Effect<unknown, KeysFailure, Db | AuditLog>,
    okStatus: 200 | 201 = 200,
  ) => {
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, okStatus);
  };

  /** Keys manage keys? No — JWT sessions only. */
  const rejectKeyCallers = (c: Context<AppHonoEnv>) =>
    isApiKeyToken(c.get("token") ?? "")
      ? Effect.fail(new ForbiddenError({ reason: "jwt-required" }))
      : Effect.void;

  // ── POST /keys — mint; the plaintext appears here and never again ───────
  keys.post(path("key.create"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      yield* rejectKeyCallers(c);
      const body = yield* Effect.tryPromise({
        try: () => c.req.json() as Promise<Record<string, unknown>>,
        catch: () => new ValidationError({ reason: "expected-json" }),
      });
      const name = body["name"];
      if (typeof name !== "string" || name.trim() === "" || name.length > API_KEY_NAME_MAX) {
        return yield* new ValidationError({ reason: "name" });
      }

      const { plaintext, prefix } = generateApiKey();
      const key_hash = yield* Effect.promise(() => hashApiKey(plaintext));
      const db = yield* Db;
      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      const id = crypto.randomUUID();
      yield* db.execute(
        "INSERT INTO apiKeys (id, pubkey, name, key_hash, prefix, created_at_ms, last_used_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, callerPubkey(claims), name.trim(), key_hash, prefix, now, null, null],
      );
      yield* audit.record({
        event_type: "api_key_created",
        actor: claims.login,
        details: { key: id, name: name.trim() },
      });
      const key: KeyView = {
        id,
        name: name.trim(),
        prefix,
        created_at_ms: now,
        last_used_at_ms: null,
        revoked_at_ms: null,
      };
      return { key, plaintext };
    });
    return runJson(c, program, 201);
  });

  // ── GET /keys — the caller's keys, newest first, metadata only ──────────
  keys.get(path("key.list"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      yield* rejectKeyCallers(c);
      const db = yield* Db;
      const rows = yield* db.queryAll<KeyView>(
        "SELECT id, name, prefix, created_at_ms, last_used_at_ms, revoked_at_ms FROM apiKeys WHERE pubkey = ? ORDER BY created_at_ms DESC",
        [callerPubkey(claims)],
      );
      return { keys: rows };
    });
    return runJson(c, program);
  });

  // ── DELETE /keys/:id — soft revoke ──────────────────────────────────────
  keys.delete(path("key.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      yield* rejectKeyCallers(c);
      const db = yield* Db;
      const audit = yield* AuditLog;
      const row = yield* db.queryFirst<{ id: string; revoked_at_ms: number | null }>(
        "SELECT id, revoked_at_ms FROM apiKeys WHERE id = ? AND pubkey = ?",
        [c.req.param("id"), callerPubkey(claims)],
      );
      if (row === null) return yield* new NotFoundError({ reason: "key" });
      const now = yield* Clock.currentTimeMillis;
      if (row.revoked_at_ms === null) {
        yield* db.execute("UPDATE apiKeys SET revoked_at_ms = ? WHERE id = ?", [now, row.id]);
        yield* audit.record({
          event_type: "api_key_revoked",
          actor: claims.login,
          details: { key: row.id },
        });
      }
      return { revoked: true };
    });
    return runJson(c, program);
  });

  return keys;
};
