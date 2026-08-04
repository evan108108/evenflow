// /api/v0/session — HTTP shell over src/actions/session.ts.
//
// Both body reads stay here. `bootstrap`'s is deliberately swallowing: a
// malformed body is not an error on this path, it just means no claim hint,
// so the route hands the action `null` rather than a failed parse. That is
// the pre-split behaviour and it is why this one needs no deferral — there is
// no error for a gate to have won against.

import { Hono } from "hono";
import { Effect } from "effect";

import { path } from "../routes-manifest";
import { makeRunJson } from "../lib/run-json";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { grantsOf } from "../http";
import { requireCaller } from "../authz";
import { actionInput } from "../actions/types";
import {
  bootstrapSession,
  registerSessionKey,
  type SessionFailure,
  type SessionServices,
} from "../actions/session";
import { errorResponse, readJsonBody } from "./errors";

export const makeSessionRouter = (layerFor: LayerFor = bootstrap) => {
  const session = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<SessionFailure, SessionServices>(layerFor, errorResponse);

  session.post(path("session.bootstrap"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* Effect.tryPromise({
        try: () => c.req.json() as Promise<Record<string, unknown>>,
        catch: () => null,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));
      return yield* bootstrapSession(
        actionInput(claims, c.req.param(), body, { grants: grantsOf(c), token: c.get("token") ?? "" }),
      );
    });
    return runJson(c, program);
  });

  // ── POST /session/register-key — per-session client keypair (16.5) ──────
  session.post(path("session.key.register"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* readJsonBody(c);
      return yield* registerSessionKey(
        actionInput(claims, c.req.param(), body, { grants: grantsOf(c), token: c.get("token") ?? "" }),
      );
    });
    return runJson(c, program, 201);
  });

  return session;
};
