// /api/v0 issues — HTTP shell over src/actions/issues.ts.
//
// EFB-98 split this file in two. Everything that decides what an issue IS —
// issue CRUD, status transitions, container moves, and the statusChangeCache
// mirroring that feeds the activity feed — moved to the action module. What
// stays here is transport: pull the params off the request, parse the body or
// the query string, run requireCaller, call the action, map a failure to a
// status code.
//
// The body and the query are still parsed HERE, deliberately. check:boundary
// and check:boundary-query both scan `src/routes` as TEXT, so moving either
// parse into the action would make those ratchets blind to it — the exact
// class of blind spot EFB-98 exists to close. Both schemas live in the action
// module with the logic that consumes them, and this file imports them back.
//
// Auth (phase 16): mounted under /api/v0 AND /api/v0/orgs/:org_slug behind
// optionalAuth. Reads run at "viewer" (anonymous works on public boards);
// writes require a caller at "contributor".

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Effect, Option } from "effect";

import { path } from "../routes-manifest";
import { parseRouteBody, parseRouteQuery } from "../lib/route-body";
import { makeRunJson } from "../lib/run-json";
import { bootstrap, type Claims } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { requireCaller } from "../authz";
import { actionInput } from "../actions/types";
import {
  ContainerBody,
  ListIssuesQuery,
  PatchIssueBody,
  PatchReorderBody,
  PostIssueBody,
  PostMoveToBoardBody,
  PostTransitionBody,
  createIssue,
  deleteIssue,
  getIssue,
  listIssues,
  setIssueBoard,
  setIssueContainer,
  setIssuePosition,
  transitionIssue,
  updateIssue,
  type IssueServices,
  type IssuesFailure,
} from "../actions/issues";

// EFB-78 moved POSITION_STEP itself to src/lib/position.ts, which the github
// execute path also needs and which cannot import from a route. Re-exported
// here so the existing importer (routes/imports.ts) is untouched — EFB-98's
// tail migration repoints it at lib/position and this line goes with it.
export { POSITION_STEP } from "../lib/position";

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<IssuesFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      // EFB-71 — a GET carries no body, so telling its caller the BODY was
      // invalid sent them to look at something they never wrote.
      case "QueryValidationError":
        return c.json({ error: "invalid-query", reason: f.reason }, 400);
      case "UnauthorizedError":
        return c.json({ error: "unauthorized", reason: f.reason }, 401);
      case "ForbiddenError":
        return c.json({ error: "forbidden", reason: f.reason }, 403);
      case "NotFoundError":
      case "BoardOwnershipError":
        return c.json({ error: "not-found", reason: f.reason }, 404);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

export const makeIssuesRouter = (layerFor: LayerFor = bootstrap) => {
  const issues = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<IssuesFailure, IssueServices>(layerFor, errorResponse);

  // The org-scoped mount (/api/v0/orgs/:org_slug) contributes org_slug via
  // the mount prefix — Hono exposes it at runtime, but the per-route typed
  // param() only knows keys from the route literal itself.
  // ── POST /board/:slug/issues — create ───────────────────────────────────
  //
  // The parse is DEFERRED (EFB-98 rule 10): `parseRouteBody` is constructed
  // here — so check:boundary still sees the marker in a route file, and the
  // schema still gates the shape — but it is handed to the action UN-YIELDED
  // and run there, below resolveBoardScope. This handler has always resolved
  // the board before reading the body, so a malformed body aimed at an
  // invisible board answers 404, not 400. Yielding it here would flip that.
  issues.post(path("issue.create"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* createIssue(
        actionInput(claims, c.req.param(), parseRouteBody(c, PostIssueBody), {
          orgSlug: c.req.param("org_slug") ?? null,
        }),
      );
    });
    return runJson(c, program, 201);
  });

  // ── GET /board/:slug/issues — list with composable filters + keyset ─────
  //
  // The query is parsed here and travels as the action's `body`: it is the
  // decoded request input, and ListIssuesQuery is the schema that decodes it.
  issues.get(path("issue.list"), async (c) => {
    const program = Effect.gen(function* () {
      // NOT named `query`, and the name is load-bearing. check-boundary-query's
      // withHelpers pass collects every `name(` in a handler as a possible
      // same-file helper; the raw query read in the GET /issue/:id handler
      // below yields the identifier `query`, which would resolve to THIS
      // declaration and pull parseRouteQuery into that handler's
      // classification — reporting it as half-migrated when it reads no schema
      // at all. Not handing the scanner an identifier to trip over is this
      // file's part; the collision itself is the scanner's, and is written up
      // in the EFB-98 tail notes for worker-3.
      const query = yield* parseRouteQuery(c, ListIssuesQuery);
      return yield* listIssues(
        actionInput<typeof ListIssuesQuery.Type, Claims | null>(
          c.get("claims") ?? null,
          c.req.param(),
          query,
          { orgSlug: c.req.param("org_slug") ?? null },
        ),
      );
    });
    return runJson(c, program);
  });

  // ── GET /issue/:id ─────────────────────────────────────────────────────
  issues.get(path("issue.get"), async (c) =>
    runJson(
      c,
      getIssue(
        actionInput<undefined, Claims | null>(
          c.get("claims") ?? null,
          c.req.param(),
          undefined,
          { query: c.req.query(), orgSlug: c.req.param("org_slug") ?? null },
        ),
      ),
    ),
  );

  // ── PATCH /issue/:id — partial update (container excluded) ─────────────
  issues.patch(path("issue.update"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* parseRouteBody(c, PatchIssueBody);
      return yield* updateIssue(
        actionInput(claims, c.req.param(), body, { orgSlug: c.req.param("org_slug") ?? null }),
      );
    });
    return runJson(c, program);
  });

  // ── DELETE /issue/:id ──────────────────────────────────────────────────
  issues.delete(path("issue.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* deleteIssue(
        actionInput(claims, c.req.param(), undefined, { orgSlug: c.req.param("org_slug") ?? null }),
      );
    });
    return runJson(c, program);
  });

  // ── POST /issue/:id/transition — the drag-drop endpoint ────────────────
  issues.post(path("issue.transition"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* parseRouteBody(c, PostTransitionBody);
      return yield* transitionIssue(
        actionInput(claims, c.req.param(), body, { orgSlug: c.req.param("org_slug") ?? null }),
      );
    });
    return runJson(c, program);
  });

  // ── PUT /issue/:id/board — cross-board move ────────────────────────────
  //
  // Parsed BEFORE the action fetches the issue, holding the old order: a
  // malformed body on an issue that doesn't exist is a 400 about the body,
  // not a 404 about the issue. The ordering is a property of this shell —
  // parse, then call — which is why the action can state it and not enforce it.
  issues.put(path("issue.board.set"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* parseRouteBody(c, PostMoveToBoardBody);
      return yield* setIssueBoard(
        actionInput(claims, c.req.param(), body, { orgSlug: c.req.param("org_slug") ?? null }),
      );
    });
    return runJson(c, program);
  });

  // ── PUT /issue/:id/position — intra-column fractional positioning ──────
  issues.put(path("issue.position.set"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* parseRouteBody(c, PatchReorderBody);
      return yield* setIssuePosition(
        actionInput(claims, c.req.param(), body, { orgSlug: c.req.param("org_slug") ?? null }),
      );
    });
    return runJson(c, program);
  });

  // ── POST /issue/:id/container — idempotent container move ──────────────
  issues.post(path("issue.container.set"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* parseRouteBody(c, ContainerBody);
      return yield* setIssueContainer(
        actionInput(claims, c.req.param(), body, { orgSlug: c.req.param("org_slug") ?? null }),
      );
    });
    return runJson(c, program);
  });

  return issues;
};
