// GitHub integration routes (phase 21) — HTTP shell over src/actions/github.ts.
//
// EFB-98 split this file in two. Everything that decides what a delivery MEANS
// moved to the action module; what stays here is transport: pull the params and
// headers off the request, read the body, run requireCaller, call an action,
// map a failure to a status code.
//
// Two very different surfaces are mounted here:
//
//   1. The INBOUND WEBHOOK — POST /api/v0/webhooks/github/:board_id. Public by
//      design; HMAC over the raw body is the only gate. It runs behind
//      optionalAuth (mounted under /api/v0) but never reads claims. The URL is
//      an EXTERNAL CONTRACT — GitHub itself posts to it, at an address already
//      saved in every connected repo's settings — so it is declared in the
//      manifest and neither renamed nor rebuilt by hand here.
//
//   2. The BOARD CONFIG surface — connect/rotate/disconnect, rule CRUD, the
//      test panel, and the activity log. All admin-gated inside the actions
//      through resolveBoardScope, same as every other board-settings route.
//
// The raw body reads below stay in THIS file deliberately: five routes here are
// named against `src/routes/github.ts` in `scripts/boundary-allowlist.json` and
// the activity log is named in the query allowlist, and both scanners resolve
// routes under `src/routes` only. A read that moved into the action module
// would leave its allowlist entry describing a route that no longer performs
// it — still looking like a guard, guarding nothing.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Effect, Exit, Option } from "effect";

import { path } from "../routes-manifest";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { requireCaller } from "../authz";
import { ValidationError } from "../lib/errors";
import { makeRunJson } from "../lib/run-json";
import { actionInput } from "../actions/types";
import type { Claims } from "../effects";
import { DEFAULT_EXTERNAL_STATES } from "../github/external-state";
import {
  deleteGithubConfig,
  getGithubConfig,
  listGithubAudit,
  receiveWebhook,
  setGithubConfig,
  setGithubRules,
  setGithubSecret,
  testGithubConnection,
  type GithubFailure,
  type GithubServices,
} from "../actions/github";

/** Bodies larger than this are refused unread — GitHub's own cap is 25MB. */
const MAX_BODY_BYTES = 1_000_000;

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<GithubFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "UnauthorizedError":
        return c.json({ error: "unauthorized", reason: f.reason }, 401);
      case "ForbiddenError":
        return c.json({ error: "forbidden", reason: f.reason }, 403);
      case "NotFoundError":
      case "BoardOwnershipError":
        return c.json({ error: "not-found", reason: f.reason }, 404);
      case "ConflictError":
        return c.json({ error: "conflict", reason: f.reason }, 409);
      case "ConfigError":
        // The server is missing EVENFLOW_WEBHOOK_SECRET — an operator
        // problem, not the caller's. Say so plainly instead of a bare 500.
        return c.json({ error: "server-misconfigured", reason: f.reason }, 503);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

const readJsonBody = (c: Context<AppHonoEnv>) =>
  Effect.tryPromise({
    try: () => c.req.json() as Promise<Record<string, unknown>>,
    catch: () => new ValidationError({ reason: "expected-json" }),
  }).pipe(
    Effect.filterOrFail(
      (b): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b),
      () => new ValidationError({ reason: "expected-json-object" }),
    ),
  );

export const makeGithubRouter = (layerFor: LayerFor = bootstrap) => {
  const app = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<GithubFailure, GithubServices>(layerFor, errorResponse);

  const orgSlug = (c: Context<AppHonoEnv>) => c.req.param("org_slug") ?? null;

  // ── inbound webhook ─────────────────────────────────────────────────────
  //
  // Not run through `runJson`, and that is not an oversight. This handler's
  // 404s and 400s are ANSWERS the action decided on rather than failures to be
  // mapped — an unknown board and a board with no secret are deliberately
  // indistinguishable, and everything verified answers 2xx even when it matched
  // no ticket, because GitHub retries non-2xx forever. So the action returns an
  // outcome carrying its own status and this shell just renders it.
  app.post(path("github.webhook.receive"), async (c) => {
    const eventType = c.req.header("x-github-event") ?? "unknown";
    const deliveryId = c.req.header("x-github-delivery") ?? null;
    const signature = c.req.header("x-hub-signature-256") ?? null;

    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return c.json({ error: "body-too-large" }, 413);
    }

    // The RAW body is what GitHub signed — re-serializing parsed JSON
    // changes whitespace and key order and would fail every signature. Read
    // EAGERLY, unlike the deferred reads below: the length refusal has to
    // happen before any Effect exists, and nothing fallible precedes it.
    const rawBody = await c.req.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return c.json({ error: "body-too-large" }, 413);
    }

    const program = receiveWebhook(
      actionInput<{ eventType: string; deliveryId: string | null; signature: string | null; rawBody: string }, Claims | null>(
        c.get("claims") ?? null,
        c.req.param(),
        { eventType, deliveryId, signature, rawBody },
        { orgSlug: orgSlug(c) },
      ),
      c.env.EVENFLOW_WEBHOOK_SECRET,
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(program as Effect.Effect<{ status: number; body: Record<string, unknown> }, never, never>, layerFor(c.env)),
    );
    if (Exit.isSuccess(exit)) {
      return c.json(exit.value.body, exit.value.status as 200);
    }
    return c.json({ error: "internal" }, 500);
  });

  // ── config surface (admin) ──────────────────────────────────────────────

  app.get(path("github.config.get"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* getGithubConfig(
        actionInput(claims, c.req.param(), undefined, { orgSlug: orgSlug(c) }),
      );
    });
    return runJson(c, program);
  });

  // The body reader is built here but NOT awaited (EFB-98 rule 10): the
  // pre-split handler proved board admin BEFORE reading the body, so the action
  // yields this one line below its gate and an unauthorized caller still gets
  // 401/403/404 rather than a 400 about a body they could not have sent.
  app.put(path("github.config.set"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* setGithubConfig(
        actionInput(claims, c.req.param(), readJsonBody(c), { orgSlug: orgSlug(c) }),
      );
    });
    return runJson(c, program);
  });

  app.post(path("github.secret.set"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* setGithubSecret(
        actionInput(claims, c.req.param(), undefined, { orgSlug: orgSlug(c) }),
        c.env.EVENFLOW_WEBHOOK_SECRET,
      );
    });
    return runJson(c, program, 201);
  });

  app.delete(path("github.config.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* deleteGithubConfig(
        actionInput(claims, c.req.param(), undefined, { orgSlug: orgSlug(c) }),
      );
    });
    return runJson(c, program);
  });

  // ── rules CRUD ──────────────────────────────────────────────────────────

  app.put(path("github.rules.set"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* setGithubRules(
        actionInput(claims, c.req.param(), readJsonBody(c), { orgSlug: orgSlug(c) }),
      );
    });
    return runJson(c, program);
  });

  // ── test panel ──────────────────────────────────────────────────────────

  app.post(path("github.connection.test"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* testGithubConnection(
        actionInput(claims, c.req.param(), readJsonBody(c), { orgSlug: orgSlug(c) }),
      );
    });
    return runJson(c, program);
  });

  // ── activity log ────────────────────────────────────────────────────────

  app.get(path("github.audit.list"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* listGithubAudit(
        actionInput(claims, c.req.param(), undefined, {
          query: c.req.query(),
          orgSlug: orgSlug(c),
        }),
      );
    });
    return runJson(c, program);
  });

  return app;
};

export { DEFAULT_EXTERNAL_STATES };
