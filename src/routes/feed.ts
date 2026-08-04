// /api/v0 feed — HTTP shell over src/actions/feed.ts, plus the per-board SSE
// stream proxied from the BoardDO fanout.
//
// The two JSON feeds are ordinary actions. The stream is not: it answers with
// a piped `Response` carrying the DO's body and SSE headers, which cannot go
// through runJson because runJson ends in c.json. So only its authorization
// moved — the action answers "may this caller subscribe, and to which board",
// and the proxy stays here where the Response is built.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Effect, Exit, Option } from "effect";

import { path } from "../routes-manifest";
import { makeRunJson } from "../lib/run-json";
import { bootstrap, type Claims } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { grantsOf } from "../http";
import { SSE_HEADERS } from "../durable-objects/BoardDO";
import { actionInput } from "../actions/types";
import {
  authorizeBoardStream,
  boardActivity,
  issueActivity,
  type FeedFailure,
  type FeedServices,
} from "../actions/feed";

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<FeedFailure>) => {
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
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

export const makeFeedRouter = (layerFor: LayerFor = bootstrap) => {
  const feed = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<FeedFailure, FeedServices>(layerFor, errorResponse);

  // The org-scoped mount (/api/v0/orgs/:org_slug) contributes org_slug via
  // the mount prefix — Hono exposes it at runtime, but the per-route typed
  // param() only knows keys from the route literal itself.
  const orgSlugOf = (c: Context<AppHonoEnv>): string | null =>
    (c.req.param() as Record<string, string | undefined>)["org_slug"] ?? null;

  // The query read is spelled out in each handler rather than tucked into the
  // helper below. Both of these routes are pinned on the query allowlist as
  // unmigrated debt, and the re-audit fails an allowlisted route whose file
  // shows no query read — which it did, loudly, when this lived in `publicInput`
  // and the scanner could not resolve through it. Rule 11: the read stays where
  // the checker can see it.
  const publicInput = (
    c: Context<AppHonoEnv>,
    query: Readonly<Record<string, string | undefined>>,
  ) =>
    actionInput<undefined, Claims | null>(c.get("claims") ?? null, c.req.param(), undefined, {
      grants: grantsOf(c),
      query,
      orgSlug: orgSlugOf(c),
    });

  // ── GET /boards/:slug/activity — newest-first feed with keyset ──────────
  feed.get(path("feed.board.activity"), async (c) =>
    runJson(c, boardActivity(publicInput(c, c.req.query()))),
  );

  // ── GET /issues/:id/activity — one issue's recent audit rows ────────────
  feed.get(path("feed.issue.activity"), async (c) =>
    runJson(c, issueActivity(publicInput(c, c.req.query()))),
  );

  // ── GET /boards/:slug/stream — SSE, proxied from the board's DO ─────────
  feed.get(path("feed.board.stream"), async (c) => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(authorizeBoardStream(publicInput(c, {})), layerFor(c.env)),
    );
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);

    const ns = c.env.BOARD;
    if (ns === undefined) return c.json({ error: "internal", reason: "no-board-binding" }, 500);
    const stub = ns.get(ns.idFromName(exit.value.board.id));
    const doResponse = await stub.fetch("https://board-do/subscribe");
    return new Response(doResponse.body, { status: doResponse.status, headers: SSE_HEADERS });
  });

  return feed;
};
