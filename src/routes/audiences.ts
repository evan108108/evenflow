// /api/v0 private-board key grants (phase 16.5) — HTTP shell over
// src/actions/audiences.ts.
//
// GET  …/board/:slug/key-grant       — the caller's current-epoch grant
//                                      for THIS session's registered key.
// POST …/board/:slug/request-regrant — self-service re-issue after a
//                                      fresh login (new session keypair)
//                                      or an epoch rotation.
//
// Neither route reads a body, so there is no parse here and nothing for
// check:boundary to see. What stays is transport: params, the bearer,
// requireCaller, runJson.

import { Hono } from "hono";
import { path } from "../routes-manifest";
import { Effect } from "effect";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { requireCaller } from "../authz";
import { errorResponse } from "./errors";
import { makeRunJson } from "../lib/run-json";
import { actionInput } from "../actions/types";
import {
  createRegrantRequest,
  getKeyGrant,
  type AudienceServices,
  type AudiencesFailure,
} from "../actions/audiences";

export const makeAudiencesRouter = (layerFor: LayerFor = bootstrap) => {
  const audiences = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<AudiencesFailure, AudienceServices>(layerFor, errorResponse);

  audiences.get(path("audience.keyGrant.get"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* getKeyGrant(
        actionInput(claims, c.req.param(), undefined, {
          token: c.get("token") ?? "",
          orgSlug: c.req.param("org_slug") ?? null,
        }),
      );
    });
    return runJson(c, program);
  });

  audiences.post(path("audience.regrantRequest.create"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* createRegrantRequest(
        actionInput(claims, c.req.param(), undefined, {
          token: c.get("token") ?? "",
          orgSlug: c.req.param("org_slug") ?? null,
        }),
      );
    });
    return runJson(c, program, 201);
  });

  return audiences;
};
