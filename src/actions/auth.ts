/**
 * Session + identity actions.
 *
 * The OAuth flow itself lives on 4a's AS (api.4a4.ai/auth/*): it talks to
 * Google/GitHub and mints the HS256 JWT. We never store the raw JWT, only its
 * sha256 hex (sessionCache.jwt_hash).
 *
 * WHAT IS NOT HERE, AND WHY. `/auth/oauth/start` and `/auth/callback` stay in
 * the route in full. They mint a PKCE verifier into a cookie, compare a state
 * cookie, and answer with 302 redirects carrying the JWT in a URL fragment.
 * Cookies and redirects fail the doctrine test — none of it would exist if we
 * weren't serving HTTP — so extracting them would move transport into a
 * module whose whole point is not having any.
 *
 * EFB-98: the three Effect programs below moved VERBATIM.
 */

import { Clock, Effect } from "effect";

import { AuditLog, Db, DbError, FourA, Jwt, hashToken, type Claims } from "../effects";
import type { ActionInput } from "./types";

/** Services the auth actions need. */
export type AuthServices = Db | AuditLog | FourA | Jwt;

/**
 * GET /auth/whoami — verified identity plus the caller's KMS-derived hex
 * pubkey from the gateway's /v0/whoami (the same derivation every publish
 * signs with).
 *
 * Resolution failure is audited, not fatal — pubkey null. On success the
 * sessionCache row is upgraded in place, closing out the pubkey '' sentinel
 * rows the KmsClient-stub era wrote. Nothing here can fail, which is why the
 * pre-split route ran it with `runPromise` rather than `runPromiseExit`.
 */
export const whoami = (
  input: ActionInput,
): Effect.Effect<{ claims: Claims; pubkey: string | null }, DbError, AuthServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const token = input.token;
    const fourA = yield* FourA;
    const audit = yield* AuditLog;
    const pubkey = yield* fourA.whoami(token).pipe(
      Effect.map((r) => r.pubkey),
      Effect.catchAll((err) =>
        audit
          .record({
            event_type: "pubkey_resolve_failed",
            actor: claims.login,
            details: { reason: err.reason },
          })
          .pipe(Effect.as(null)),
      ),
    );
    if (pubkey !== null) {
      const db = yield* Db;
      const hash = yield* hashToken(token);
      yield* db.execute(
        "UPDATE sessionCache SET pubkey = ? WHERE jwt_hash = ?",
        [pubkey, hash],
      );
    }
    return { claims, pubkey };
  });

/**
 * POST /auth/session — exchange a 4a-minted JWT for a cached session row.
 *
 * Takes the JWT directly rather than an ActionInput: this is the one action in
 * the family with no verified caller yet — verifying the token IS the work —
 * so there are no claims to carry.
 */
export const createSessionFromJwt = (jwt: string) =>
  Effect.gen(function* () {
    const jwtService = yield* Jwt;
    const claims = yield* jwtService.verify(jwt);
    const db = yield* Db;
    const audit = yield* AuditLog;
    const hash = yield* hashToken(jwt);
    const now = yield* Clock.currentTimeMillis;
    // Resolve the caller's hex pubkey at session creation so the row is
    // born complete. Non-fatal: a gateway hiccup falls back to the ''
    // sentinel, and /auth/whoami repairs the row on its next call.
    const fourA = yield* FourA;
    const pubkey = yield* fourA.whoami(jwt).pipe(
      Effect.map((r) => r.pubkey),
      Effect.catchAll(() => Effect.succeed("")),
    );
    yield* db.execute(
      "INSERT OR REPLACE INTO sessionCache (jwt_hash, pubkey, provider, oauth_id, expires_at_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?)",
      [hash, pubkey, claims.provider, claims.oauth_id, claims.exp * 1000, now],
    );
    yield* audit.record({
      event_type: "session_created",
      actor: claims.login,
      details: { provider: claims.provider },
    });
    return { session_hash: hash };
  });

/** DELETE /auth/session — drop the caller's session row. */
export const deleteSession = (input: ActionInput) =>
  Effect.gen(function* () {
    const claims = input.claims;
    const db = yield* Db;
    const audit = yield* AuditLog;
    const hash = yield* hashToken(input.token);
    yield* db.execute("DELETE FROM sessionCache WHERE jwt_hash = ?", [hash]);
    yield* audit.record({ event_type: "session_deleted", actor: claims.login });
    return { deleted: true };
  });
