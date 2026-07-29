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

import type { MiddlewareHandler } from "hono";
import { Cause, Effect, Exit, Option } from "effect";
import { Jwt, bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";

const BEARER_PREFIX = "Bearer ";

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

    const verify = Effect.gen(function* () {
      const jwt = yield* Jwt;
      return yield* jwt.verify(token);
    });
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
