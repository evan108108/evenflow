/**
 * Developer API key actions (phase 19).
 *
 * The plaintext key exists exactly once, in `createKey`'s return value; the
 * list path returns metadata only (name, display prefix, timestamps).
 * Revocation is a soft flag — the row stays for the audit trail, the
 * middleware filters revoked keys at lookup.
 *
 * JWT-only surface on purpose: a key cannot mint or revoke keys, so a leaked
 * key can never escalate to more keys. That guard is `rejectKeyCallers`
 * below, and it reads `input.token` — the caller's raw bearer, which is what
 * decides whether this request arrived on a JWT or on a key.
 *
 * EFB-98: bodies moved VERBATIM from src/routes/keys.ts; the only edits read
 * claims/token/params off an input record instead of off a Context.
 */

import { Clock, Effect } from "effect";

import { AuditLog, Db, DbError } from "../effects";
import { ForbiddenError, UnauthorizedError, callerPubkey } from "../authz";
import { NotFoundError, ValidationError } from "../lib/errors";
import { API_KEY_NAME_MAX, generateApiKey, hashApiKey, isApiKeyToken } from "../apikeys";
import type { ActionInput } from "./types";

export type KeysFailure =
  | ValidationError
  | NotFoundError
  | UnauthorizedError
  | ForbiddenError
  | DbError;

/** Services every key action needs. */
export type KeyServices = Db | AuditLog;

/** Metadata shape the list/read paths return — never the hash. */
export interface KeyView {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly created_at_ms: number;
  readonly last_used_at_ms: number | null;
  readonly revoked_at_ms: number | null;
}

/**
 * Keys manage keys? No — JWT sessions only.
 *
 * Was a router-scoped closure reading `c.get("token")`; it now reads the same
 * value off the input record, which is the only edit.
 */
const rejectKeyCallers = (token: string) =>
  isApiKeyToken(token)
    ? Effect.fail(new ForbiddenError({ reason: "jwt-required" }))
    : Effect.void;

/**
 * POST /keys — mint; the plaintext appears here and never again.
 *
 * RULE 10, AND THE REASON THIS SIGNATURE LOOKS ODD. The body arrives as an
 * UNRUN Effect, and it is run below, AFTER `rejectKeyCallers`. That is the
 * pre-split order: a caller presenting an API key rather than a JWT is told
 * `403 jwt-required` even when the body it sent was also malformed. Parsing on
 * the way in — the shape every other action in this family uses — would answer
 * `400 expected-json` to that request instead, turning "you may not use this
 * endpoint at all" into "fix your JSON". No test pinned the order; the one
 * below does now.
 *
 * The raw read itself stays in the route, where the boundary ratchet has
 * always seen it. What is deferred is only WHEN it runs.
 */
export const createKey = (
  input: ActionInput<Effect.Effect<Record<string, unknown>, ValidationError>>,
): Effect.Effect<unknown, KeysFailure, KeyServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    yield* rejectKeyCallers(input.token);
    const body = yield* input.body;
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

/** GET /keys — the caller's keys, newest first, metadata only. */
export const listKeys = (
  input: ActionInput,
): Effect.Effect<unknown, KeysFailure, KeyServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    yield* rejectKeyCallers(input.token);
    const db = yield* Db;
    const rows = yield* db.queryAll<KeyView>(
      "SELECT id, name, prefix, created_at_ms, last_used_at_ms, revoked_at_ms FROM apiKeys WHERE pubkey = ? ORDER BY created_at_ms DESC",
      [callerPubkey(claims)],
    );
    return { keys: rows };
  });

/** DELETE /keys/:id — soft revoke. */
export const deleteKey = (
  input: ActionInput,
): Effect.Effect<unknown, KeysFailure, KeyServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    yield* rejectKeyCallers(input.token);
    const db = yield* Db;
    const audit = yield* AuditLog;
    const row = yield* db.queryFirst<{ id: string; revoked_at_ms: number | null }>(
      "SELECT id, revoked_at_ms FROM apiKeys WHERE id = ? AND pubkey = ?",
      [input.params["id"] ?? "", callerPubkey(claims)],
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
