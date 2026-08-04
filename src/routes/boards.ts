// /api/v0/boards — HTTP shell over src/actions/boards.ts.
//
// EFB-98 split this file in two. Everything that decides what a board IS moved
// to the action module — the schemas, the field validators, the failure union,
// the persistence and the event emission. What stays here is transport: pull
// the params off the request, parse the body, run requireCaller, call the
// action, map a failure to a status code.
//
// Mounted twice by index.ts: at /api/v0 (legacy compat — no org_slug param,
// boards resolve against the caller's own/visible set) and at
// /api/v0/orgs/:org_slug (canonical — boards resolve inside that org). The
// branch on that parameter is business logic, so `org_slug` is read HERE and
// passed in as `input.orgSlug` rather than being reached for inside the
// action. `?? null` is deliberate and load-bearing: `board.create` branches on
// the parameter's PRESENCE, so the bare mount has to arrive as null rather
// than as "".
//
// The body is still parsed HERE, deliberately. check:boundary scans route
// files for the parseRouteBody marker, so moving the parse into the action
// would make the boundary ratchet blind to it — the exact class of blind spot
// EFB-98 exists to close. The schemas live with the logic that consumes them
// and this file imports them back.
//
// Auth: /api/v0/* runs behind optionalAuth — reads allow anonymous on
// public boards; every mutation calls requireCaller first.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Effect, Option } from "effect";

import { path } from "../routes-manifest";
import { parseRouteBody } from "../lib/route-body";
import { makeRunJson } from "../lib/run-json";
import { bootstrap, type Claims } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { grantsOf } from "../http";
import { requireCaller } from "../authz";
import { actionInput } from "../actions/types";
import {
  PatchBoardBody,
  PostBoardBody,
  boardVelocity,
  createBoard,
  deleteBoard,
  getBoard,
  listBoards,
  setBoardArchived,
  updateBoard,
  type BoardServices,
  type BoardsFailure,
} from "../actions/boards";

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<BoardsFailure>) => {
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
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

/** The org this request is scoped to — null on the bare (non-org) mount. */
const orgSlugOf = (c: Context<AppHonoEnv>) => c.req.param("org_slug") ?? null;

export const makeBoardsRouter = (layerFor: LayerFor = bootstrap) => {
  const boards = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<BoardsFailure, BoardServices>(layerFor, errorResponse);

  // ── POST /boards — create (in :org_slug when present, else personal) ────
  boards.post(path("board.create"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* parseRouteBody(c, PostBoardBody);
      return yield* createBoard(
        actionInput(claims, c.req.param(), body, {
          grants: grantsOf(c),
          orgSlug: orgSlugOf(c),
          token: c.get("token") ?? "",
        }),
      );
    });
    return runJson(c, program, 201);
  });

  // ── GET /boards — every board the caller can see, newest-updated first ──
  boards.get(path("board.list"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* listBoards(
        actionInput(claims, c.req.param(), undefined, {
          grants: grantsOf(c),
          query: c.req.query(),
          orgSlug: orgSlugOf(c),
        }),
      );
    });
    return runJson(c, program);
  });

  // ── GET /boards/:slug — fetch one visible board ─────────────────────────
  boards.get(path("board.get"), async (c) =>
    runJson(
      c,
      getBoard(
        actionInput<undefined, Claims | null>(c.get("claims") ?? null, c.req.param(), undefined, {
          grants: grantsOf(c),
          orgSlug: orgSlugOf(c),
        }),
      ),
    ),
  );

  // ── GET /boards/:slug/velocity ──────────────────────────────────────────
  boards.get(path("board.velocity"), async (c) =>
    runJson(
      c,
      boardVelocity(
        actionInput<undefined, Claims | null>(c.get("claims") ?? null, c.req.param(), undefined, {
          grants: grantsOf(c),
          query: c.req.query(),
          orgSlug: orgSlugOf(c),
        }),
      ),
    ),
  );

  // ── PATCH /boards/:slug — partial update of mutable fields (admin) ──────
  boards.patch(path("board.update"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* parseRouteBody(c, PatchBoardBody);
      return yield* updateBoard(
        actionInput(claims, c.req.param(), body, { grants: grantsOf(c), orgSlug: orgSlugOf(c) }),
      );
    });
    return runJson(c, program);
  });

  // ── POST/DELETE /boards/:slug/archived — hide from / restore to lists ───
  // EFB-98: archiving is a state, so it gets the CRUD pair on one path rather
  // than a second verb URL. POST sets it, DELETE clears it; `unarchive` is gone.
  const archiveHandler = (archive: boolean) => async (c: Context<AppHonoEnv>) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* setBoardArchived(archive)(
        actionInput(claims, c.req.param(), undefined, { grants: grantsOf(c), orgSlug: orgSlugOf(c) }),
      );
    });
    return runJson(c, program);
  };
  boards.post(path("board.archive.set"), archiveHandler(true));
  boards.delete(path("board.archive.clear"), archiveHandler(false));

  // ── DELETE /boards/:slug — remove a board (admin) ───────────────────────
  boards.delete(path("board.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* deleteBoard(
        actionInput(claims, c.req.param(), undefined, { grants: grantsOf(c), orgSlug: orgSlugOf(c) }),
      );
    });
    return runJson(c, program);
  });

  return boards;
};
