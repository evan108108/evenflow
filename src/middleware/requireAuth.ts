// Auth middleware — two flavors over the same JWT verification:
//
//   requireAuth()  — hard gate: no (valid) token → 401. Pre-16 behavior,
//                    still used for /auth/* surfaces.
//   optionalAuth() — phase-16 gate for /api/v0/*: a PRESENT token must be
//                    valid (invalid → 401 — never silently downgrade an
//                    authenticated caller to anonymous), an ABSENT token
//                    passes through unauthenticated so public boards can be
//                    read without signing in. Routes gate mutations with
//                    requireCaller(claims).
//
// Both set `claims` (verified) and `token` (raw JWT, forwarded to 4a
// publish calls) on the request context when a token verifies.
//
// Phase 19: both flavors ALSO accept `Authorization: Bearer evk_…`
// developer API keys — looked up by prefix, verified by sha256 hash, and
// authenticating as the key's owner (synthesized claims). REST and the
// /mcp surface share this middleware, so keys work on both for free.

import type { MiddlewareHandler } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { Db, Jwt, bootstrap, type JwtError } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import type { Claims } from "../effects";
import {
  API_KEY_DISPLAY_PREFIX_LEN,
  API_KEY_LAST_USED_THROTTLE_MS,
  claimsForApiKey,
  hashApiKey,
  isApiKeyToken,
} from "../apikeys";

const BEARER_PREFIX = "Bearer ";

/** Unknown, revoked, or malformed evk_ token — always the same 401 reason
 *  so probing can't distinguish "revoked" from "never existed". */
class ApiKeyError extends Data.TaggedError("ApiKeyError")<{
  readonly reason: "invalid-api-key";
}> {}

const verifyApiKey = (token: string): Effect.Effect<Claims, ApiKeyError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const candidates = yield* db
      .queryAll<{
        id: string;
        pubkey: string;
        name: string;
        key_hash: string;
        last_used_at_ms: number | null;
      }>(
        "SELECT id, pubkey, name, key_hash, last_used_at_ms FROM apiKeys WHERE prefix = ? AND revoked_at_ms IS NULL",
        [token.slice(0, API_KEY_DISPLAY_PREFIX_LEN)],
      )
      .pipe(Effect.mapError(() => new ApiKeyError({ reason: "invalid-api-key" })));
    const hash = yield* Effect.promise(() => hashApiKey(token));
    const key = candidates.find((k) => k.key_hash === hash);
    if (key === undefined) return yield* new ApiKeyError({ reason: "invalid-api-key" });
    const claims = claimsForApiKey(key.pubkey, key.name);
    if (claims === null) return yield* new ApiKeyError({ reason: "invalid-api-key" });

    // last_used_at_ms bumps at most once a minute per key; a failed bump
    // never fails the request.
    const now = yield* Clock.currentTimeMillis;
    if (key.last_used_at_ms === null || now - key.last_used_at_ms > API_KEY_LAST_USED_THROTTLE_MS) {
      yield* db
        .execute("UPDATE apiKeys SET last_used_at_ms = ? WHERE id = ?", [now, key.id])
        .pipe(Effect.catchAll(() => Effect.void));
    }
    return claims;
  });

const makeAuthMiddleware = (
  layerFor: LayerFor,
  tokenRequired: boolean,
): MiddlewareHandler<AppHonoEnv> =>
  async (c, next) => {
    const header = c.req.header("Authorization");
    if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
      if (tokenRequired) {
        return c.json({ error: "unauthorized", reason: "missing-authorization" }, 401);
      }
      return next();
    }
    const token = header.slice(BEARER_PREFIX.length).trim();

    const verify: Effect.Effect<Claims, JwtError | ApiKeyError, Jwt | Db> = isApiKeyToken(token)
      ? verifyApiKey(token)
      : Effect.flatMap(Jwt, (jwt) => jwt.verify(token));
    const exit = await Effect.runPromiseExit(
      Effect.provide(verify, layerFor(c.env)),
    );

    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      const reason = Option.isSome(failure) ? failure.value.reason : "internal";
      return c.json({ error: "unauthorized", reason }, 401);
    }

    c.set("claims", exit.value);
    c.set("token", token);
    await next();
  };

export const requireAuth = (
  layerFor: LayerFor = bootstrap,
): MiddlewareHandler<AppHonoEnv> => makeAuthMiddleware(layerFor, true);

export const optionalAuth = (
  layerFor: LayerFor = bootstrap,
): MiddlewareHandler<AppHonoEnv> => makeAuthMiddleware(layerFor, false);
