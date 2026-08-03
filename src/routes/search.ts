// /api/v0 search — HTTP shell over src/actions/search.ts.
//
// EFB-98 split this file in two. The board gate, the FTS5 query building and
// the hydration moved to the action module — including the two arguments the
// old header made at length, which live with the code they constrain. What
// stays here is transport: parse the body, call the action, map a failure to
// a status code.
//
// The body is still parsed HERE, deliberately. check:boundary scans route
// files for the parseRouteBody marker, so moving the parse into the action
// would make the boundary ratchet blind to it.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Effect, Option } from "effect";

import { path } from "../routes-manifest";
import { parseRouteBody } from "../lib/route-body";
import { makeRunJson } from "../lib/run-json";
import { bootstrap, type Claims } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { actionInput } from "../actions/types";
import {
  SearchBody,
  searchBoard,
  type DeferredSearchBody,
  type SearchFailure,
  type SearchServices,
} from "../actions/search";

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<SearchFailure>) => {
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
      case "BoardOwnershipError":
        return c.json({ error: "not-found", reason: f.reason }, 404);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

export const makeSearchRouter = (layerFor: LayerFor = bootstrap) => {
  const search = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<SearchFailure, SearchServices>(layerFor, errorResponse);

  // The org-scoped mount (/api/v0/orgs/:org_slug) contributes org_slug via
  // the mount prefix — Hono exposes it at runtime, but the per-route typed
  // param() only knows keys from the route literal itself.
  const orgSlugOf = (c: Context<AppHonoEnv>): string | null =>
    (c.req.param() as Record<string, string | undefined>)["org_slug"] ?? null;

  // ── POST /boards/:slug/search ──────────────────────────────────────────
  //
  // POST rather than GET because the query is a body, not a path component:
  // search text routinely contains `/`, `#`, `?` and `&`, and a body keeps
  // the terms out of access logs and browser history. `parseRouteBody`
  // per Boundary Discipline (EFB-54).
  //
  // Anonymous-reachable, so the action takes a PublicActionInput: a public
  // board is searchable without signing in, and the board gate inside is what
  // decides that.
  //
  // The parse is handed over UN-RUN. This route gated before it parsed, and
  // the action yields the body at that same line — see DeferredSearchBody.
  // parseRouteBody is still physically here, which is what check:boundary
  // scans for.
  search.post(path("search.board"), async (c) =>
    runJson(
      c,
      searchBoard(
        actionInput<DeferredSearchBody, Claims | null>(
          c.get("claims") ?? null,
          c.req.param(),
          parseRouteBody(c, SearchBody),
          { orgSlug: orgSlugOf(c) },
        ),
      ),
    ),
  );

  return search;
};
