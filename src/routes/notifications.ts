// /api/v0/notifications/config — HTTP shell over src/actions/notifications.ts.
//
// EFB-98: the local runJson is gone (it was one of eight copies); this router
// uses the shared one from src/lib/run-json.ts with the shared errorResponse.
// The body read stays here, unmigrated, exactly where the ratchet sees it.

import { Hono } from "hono";
import { Effect } from "effect";

import { path } from "../routes-manifest";
import { makeRunJson } from "../lib/run-json";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { requireCaller } from "../authz";
import { actionInput } from "../actions/types";
import {
  getNotificationsConfig,
  setNotificationsConfig,
  type NotificationServices,
  type NotificationsFailure,
} from "../actions/notifications";
import { errorResponse, readJsonBody } from "./errors";

export const makeNotificationsRouter = (layerFor: LayerFor = bootstrap) => {
  const notifications = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<NotificationsFailure, NotificationServices>(layerFor, errorResponse);

  // ── GET /notifications/config ───────────────────────────────────────────
  notifications.get(path("notifications.config.get"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* getNotificationsConfig(actionInput(claims, c.req.param(), undefined));
    });
    return runJson(c, program);
  });

  // ── PATCH /notifications/config — partial update, upserts ───────────────
  notifications.patch(path("notifications.config.set"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* readJsonBody(c);
      return yield* setNotificationsConfig(actionInput(claims, c.req.param(), body));
    });
    return runJson(c, program);
  });

  return notifications;
};
