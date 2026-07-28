// requireAuth — Hono middleware factory gating routes on a valid 4a JWT.
//
// Reads `Authorization: Bearer <jwt>`, verifies via the Jwt service (an
// Effect program run against the per-request environment), and attaches the
// verified claims to the request context. Failures answer 401 with a typed
// body: { error: "unauthorized", reason: <JwtError reason | "missing-authorization"> }.

import type { MiddlewareHandler } from "hono";
import { Cause, Effect, Exit, Option } from "effect";
import { Jwt, bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";

const BEARER_PREFIX = "Bearer ";

export const requireAuth = (
  layerFor: LayerFor = bootstrap,
): MiddlewareHandler<AppHonoEnv> =>
  async (c, next) => {
    const header = c.req.header("Authorization");
    if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
      return c.json({ error: "unauthorized", reason: "missing-authorization" }, 401);
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
    await next();
  };
