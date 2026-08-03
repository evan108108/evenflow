// /api/v0 comments — HTTP shell over src/actions/comments.ts.
//
// EFB-98 split this file in two. Everything that decides what a comment IS
// moved to the action module; what stays here is transport: pull the params
// off the request, parse the body, run requireCaller, call the action, map a
// failure to a status code.
//
// The body is still parsed HERE, deliberately. check:boundary scans route
// files for the parseRouteBody marker, so moving the parse into the action
// would make the boundary ratchet blind to it — the exact class of blind spot
// EFB-98 exists to close.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Effect, Option } from "effect";

import { path } from "../routes-manifest";
import { parseRouteBody } from "../lib/route-body";
import { makeRunJson } from "../lib/run-json";
import { bootstrap, type Claims } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { requireCaller } from "../authz";
import { actionInput } from "../actions/types";
import {
  PostCommentBody,
  createComment,
  deleteComment,
  listComments,
  type CommentServices,
  type CommentsFailure,
} from "../actions/comments";

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<CommentsFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "UnauthorizedError":
        return c.json({ error: "unauthorized", reason: f.reason }, 401);
      case "NotFoundError":
      case "BoardOwnershipError":
        return c.json({ error: "not-found", reason: f.reason }, 404);
      case "ForbiddenError":
        return c.json({ error: "forbidden", reason: f.reason }, 403);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

export const makeCommentsRouter = (layerFor: LayerFor = bootstrap) => {
  const comments = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<CommentsFailure, CommentServices>(layerFor, errorResponse);

  comments.post(path("comment.create"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* parseRouteBody(c, PostCommentBody);
      return yield* createComment(
        actionInput(claims, c.req.param(), body, { orgSlug: c.req.param("org_slug") ?? null }),
      );
    });
    return runJson(c, program, 201);
  });

  comments.get(path("comment.list"), async (c) =>
    runJson(
      c,
      listComments(
        actionInput<undefined, Claims | null>(
          c.get("claims") ?? null,
          c.req.param(),
          undefined,
          { query: c.req.query(), orgSlug: c.req.param("org_slug") ?? null },
        ),
      ),
    ),
  );

  comments.delete(path("comment.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* deleteComment(
        actionInput(claims, c.req.param(), undefined, { orgSlug: c.req.param("org_slug") ?? null }),
      );
    });
    return runJson(c, program);
  });

  return comments;
};
