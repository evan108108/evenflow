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
import { OWNER_SCOPE, grantRefusal } from "../scopes";
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
  /**
   * EFB-100 — the JSON scopes array as stored, or NULL for a key minted
   * before scoping existed. NULL and '["owner"]' grant the same thing today;
   * they are kept distinct so the legacy set stays countable. The UI renders
   * NULL as "full access (legacy)" and the explicit array as chips.
   */
  readonly scopes: string | null;
  /** EFB-99 — when this key was rotated away from. NULL = never rotated. */
  readonly rotated_at_ms: number | null;
  /**
   * The successor key's id. The client resolves it to a display prefix
   * against the list it already holds — the successor is always the caller's
   * own key, so it is always in the same response and no join is needed.
   */
  readonly rotated_to_id: string | null;
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

    // EFB-100 — what this key may do. Absent means the caller asked for no
    // narrowing, which is stored as the EXPLICIT owner grant rather than as
    // NULL: NULL is reserved for rows that predate scoping, so it stays a
    // closed set that only migration 0030 can produce and that
    // `SELECT COUNT(*) ... WHERE scopes IS NULL` can drive to zero. A mint
    // path that wrote NULL would quietly reopen a fail-open default.
    const requested = body["scopes"];
    if (requested !== undefined && !Array.isArray(requested)) {
      return yield* new ValidationError({ reason: "scopes must be an array of scope strings" });
    }
    const scopes: readonly string[] =
      requested === undefined ? [OWNER_SCOPE] : (requested as readonly unknown[]).map(String);
    for (const scope of scopes) {
      const refusal = grantRefusal(scope);
      // Prose, not a slug — `reasonFor` reads a bare kebab string as a reason
      // CODE, and the refusal for the keys domain has to be readable: someone
      // asking for it is trying to do something the API will never allow, and
      // deserves to be told why rather than handed `scopes-invalid`.
      if (refusal !== null) return yield* new ValidationError({ reason: refusal });
    }

    const { plaintext, prefix } = generateApiKey();
    const key_hash = yield* Effect.promise(() => hashApiKey(plaintext));
    const db = yield* Db;
    const audit = yield* AuditLog;
    const now = yield* Clock.currentTimeMillis;
    const id = crypto.randomUUID();
    yield* db.execute(
      "INSERT INTO apiKeys (id, pubkey, name, key_hash, prefix, created_at_ms, last_used_at_ms, revoked_at_ms, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, callerPubkey(claims), name.trim(), key_hash, prefix, now, null, null, JSON.stringify(scopes)],
    );
    yield* audit.record({
      event_type: "api_key_created",
      actor: claims.login,
      // The scopes are in the audit row because "what was this key allowed to
      // do?" is a question asked AFTER something has gone wrong, by which
      // point the row may have been revoked or rotated away.
      details: { key: id, name: name.trim(), scopes },
    });
    const key: KeyView = {
      id,
      name: name.trim(),
      prefix,
      created_at_ms: now,
      last_used_at_ms: null,
      revoked_at_ms: null,
      scopes: JSON.stringify(scopes),
      rotated_at_ms: null,
      rotated_to_id: null,
    };
    return { key, plaintext };
  });

/**
 * POST /key/:id/rotate — mint a replacement secret for an existing key.
 *
 * The point is to change a secret WITHOUT a gap. The old row keeps
 * authenticating for `API_KEY_ROTATION_GRACE_MS` so callers can redeploy, then
 * the auth path refuses it and revokes it — see verifyApiKey in
 * src/middleware/requireAuth.ts, which is where expiry is DECIDED. Nothing
 * here is load-bearing for that decision; this action only records the fact.
 *
 * JWT-ONLY, AND THIS IS THE LOAD-BEARING GUARD. `rejectKeyCallers` runs FIRST,
 * before the row is even looked up, exactly as it does in deleteKey. Rotation
 * MINTS a key, so a rotate reachable by an evk_ caller would make a leaked key
 * PERMANENT: the attacker rotates, receives a fresh plaintext, and the owner
 * revoking the key they know about accomplishes nothing — they revoked the
 * parent and never saw the child. That is worse than plain escalation because
 * the new row looks like a legitimate rotation by the owner, so it removes
 * detection along with defence. Every mint-or-rotate operation on this surface
 * is JWT-only; operations that act on a key without minting one may be
 * key-callable.
 *
 * The NAME IS INHERITED and there is no request body. `claimsForApiKey`
 * synthesizes `login` as `key:<name>`, so letting a rotation rename would
 * silently re-label the audit actor mid-incident — every row after the
 * rotation would attribute to a different string than every row before it.
 * Renaming is a PATCH concern, not a rotation one.
 */
export const rotateKey = (
  input: ActionInput,
): Effect.Effect<unknown, KeysFailure, KeyServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    yield* rejectKeyCallers(input.token);
    const db = yield* Db;
    const audit = yield* AuditLog;
    const row = yield* db.queryFirst<{
      id: string;
      name: string;
      revoked_at_ms: number | null;
      rotated_at_ms: number | null;
      scopes: string | null;
    }>(
      "SELECT id, name, revoked_at_ms, rotated_at_ms, scopes FROM apiKeys WHERE id = ? AND pubkey = ?",
      [input.params["id"] ?? "", callerPubkey(claims)],
    );
    // Scoped by pubkey, so another owner's key is indistinguishable from one
    // that does not exist — same non-disclosure posture as deleteKey.
    if (row === null) return yield* new NotFoundError({ reason: "key" });
    // A revoked key has no live secret to replace, and rotating one would mint
    // a working credential out of a dead one.
    if (row.revoked_at_ms !== null) {
      return yield* new ValidationError({ reason: "already-revoked" });
    }
    // Single-valued successor. Without this a key forks into two live
    // children and "replaced by" stops being a fact you can render.
    if (row.rotated_at_ms !== null) {
      return yield* new ValidationError({ reason: "already-rotated" });
    }

    const { plaintext, prefix } = generateApiKey();
    const key_hash = yield* Effect.promise(() => hashApiKey(plaintext));
    const now = yield* Clock.currentTimeMillis;
    const id = crypto.randomUUID();
    // Same pubkey, same name: the successor authenticates as the same owner
    // with the same synthesized claims. That equivalence IS the feature.
    //
    // EFB-100 — AND THE SAME SCOPES, VERBATIM. Rotation replaces a secret; it
    // is not a chance to acquire authority. Omitting this column would write
    // NULL on the successor, and NULL means "minted before scoping" — i.e.
    // FULL OWNER AUTHORITY. Rotating a `board:*:read` key would then hand back
    // a key that can do anything, silently, through a flow whose entire
    // promise is that nothing changes but the secret. The successor is capped
    // by its parent, always.
    yield* db.execute(
      "INSERT INTO apiKeys (id, pubkey, name, key_hash, prefix, created_at_ms, last_used_at_ms, revoked_at_ms, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, callerPubkey(claims), row.name, key_hash, prefix, now, null, null, row.scopes],
    );
    // The predecessor is marked AFTER its successor exists, so a failure
    // between the two leaves a live key rather than an orphaned rotation
    // pointing at nothing.
    yield* db.execute("UPDATE apiKeys SET rotated_at_ms = ?, rotated_to_id = ? WHERE id = ?", [
      now,
      id,
      row.id,
    ]);
    yield* audit.record({
      event_type: "api_key_rotated",
      actor: claims.login,
      details: { key: row.id, replaced_by: id, name: row.name },
    });
    const key: KeyView = {
      id,
      name: row.name,
      prefix,
      created_at_ms: now,
      last_used_at_ms: null,
      revoked_at_ms: null,
      scopes: row.scopes,
      rotated_at_ms: null,
      rotated_to_id: null,
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
      "SELECT id, name, prefix, created_at_ms, last_used_at_ms, revoked_at_ms, rotated_at_ms, rotated_to_id, scopes FROM apiKeys WHERE pubkey = ? ORDER BY created_at_ms DESC",
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
