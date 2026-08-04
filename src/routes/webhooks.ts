// EFB-13 — outbound webhook subscription CRUD. HTTP shell over
// src/actions/webhooks.ts.
//
// EFB-98 split this file in two. Everything that decides what a subscription
// IS moved to the action module; what stays here is transport: pull the params
// off the request, parse the body, run requireCaller, call the action, map a
// failure to a status code.
//
// The body is still parsed HERE, deliberately. check:boundary scans route
// files for the parseRouteBody marker, so moving the parse into the action
// would make the boundary ratchet blind to it — the exact class of blind spot
// EFB-98 exists to close. `scripts/boundary-allowlist.json` is closed to new
// entries and nothing here is added to it. See docs/BOUNDARY_DISCIPLINE.md.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Effect, Option } from "effect";

import { path } from "../routes-manifest";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { grantsOf } from "../http";
import { requireCaller } from "../authz";
import { parseRouteBody } from "../lib/route-body";
import { makeRunJson } from "../lib/run-json";
import { actionInput } from "../actions/types";
import {
  PatchSubscriptionBody,
  PostSubscriptionBody,
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  updateWebhook,
  type WebhookFailure,
  type WebhookServices,
} from "../actions/webhooks";

/**
 * Note the wire shape: a bare `{ reason }`, with no `error` field. That is
 * what this family has always answered and what its tests pin — it is
 * deliberately NOT the `{ error, reason }` shape the comments/github families
 * use.
 */
const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<WebhookFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    const reason = f.reason ?? "error";
    if (f._tag === "UnauthorizedError") return c.json({ reason }, 401);
    if (f._tag === "ForbiddenError" || f._tag === "PredicateForbiddenError") {
      return c.json({ reason }, 403);
    }
    if (f._tag === "NotFoundError" || f._tag === "BoardOwnershipError") {
      return c.json({ reason }, 404);
    }
    if (f._tag === "ValidationError") return c.json({ reason }, 400);
  }
  // DbError and ConfigError land here as well as any defect — this family has
  // always answered a bare 500 for a missing webhook secret rather than the
  // 503 github.ts answers, and that difference is preserved rather than tidied.
  return c.json({ reason: "internal" }, 500);
};

export const makeWebhooksRouter = (layerFor: LayerFor = bootstrap) => {
  const app = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<WebhookFailure, WebhookServices>(layerFor, errorResponse);

  const orgSlug = (c: Context<AppHonoEnv>) => c.req.param("org_slug") ?? null;

  // ── list ────────────────────────────────────────────────────────────────
  app.get(path("webhook.list"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* listWebhooks(
        actionInput(claims, c.req.param(), undefined, { grants: grantsOf(c), orgSlug: orgSlug(c) }),
      );
    });
    return runJson(c, program);
  });

  // ── create ──────────────────────────────────────────────────────────────
  //
  // The `parseRouteBody` call is built here but NOT awaited (EFB-98 rule 10):
  // the pre-split handler proved board admin BEFORE reading the body, so the
  // action yields this Effect one line below its gate and the ordering — and
  // therefore the status code an unauthorized caller sees — is unchanged.
  app.post(path("webhook.create"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* createWebhook(
        actionInput(claims, c.req.param(), parseRouteBody(c, PostSubscriptionBody), {
          grants: grantsOf(c),
          orgSlug: orgSlug(c),
        }),
        c.env.EVENFLOW_WEBHOOK_SECRET,
      );
    });
    return runJson(c, program, 201);
  });

  // ── update ──────────────────────────────────────────────────────────────
  app.patch(path("webhook.update"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* updateWebhook(
        actionInput(claims, c.req.param(), parseRouteBody(c, PatchSubscriptionBody), {
          grants: grantsOf(c),
          orgSlug: orgSlug(c),
        }),
      );
    });
    return runJson(c, program);
  });

  // ── delete ──────────────────────────────────────────────────────────────
  app.delete(path("webhook.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* deleteWebhook(
        actionInput(claims, c.req.param(), undefined, { grants: grantsOf(c), orgSlug: orgSlug(c) }),
      );
    });
    return runJson(c, program);
  });

  // ── delivery log ────────────────────────────────────────────────────────
  app.get(path("webhook.deliveries.list"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* listWebhookDeliveries(
        actionInput(claims, c.req.param(), undefined, { grants: grantsOf(c), orgSlug: orgSlug(c) }),
      );
    });
    return runJson(c, program);
  });

  return app;
};
