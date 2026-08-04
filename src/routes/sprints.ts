// /api/v0 sprints — HTTP shell over src/actions/sprints.ts.
//
// EFB-98 split this file in two. Everything that decides what a sprint IS —
// the lifecycle, the membership audit trail, the points snapshots — moved to
// the action module; what stays here is transport: pull the params off the
// request, parse the body, run requireCaller, call the action, map a failure
// to a status code.
//
// The body is still parsed HERE, deliberately. check:boundary scans route
// files for the parseRouteBody marker, so moving the parse into the action
// would make the boundary ratchet blind to it — the exact class of blind spot
// EFB-98 exists to close. The same goes for the `?days=` read on the two tide
// routes: it is on the query allowlist, and an entry has to stay backed by a
// read this file can be seen to make.
//
// Every body-bearing route here hands the parse over UN-RUN. All four gated
// before they parsed — `boardScope` on all of them, plus a 409 on complete —
// and that order decides which status code a doubly-wrong request gets.
// Effects are lazy, so `parseRouteBody(c, Schema)` is built here and yielded
// inside the action at the line the parse used to occupy. See the DeferredBody
// note in src/actions/sprints.ts for why this is not the odd flourish it looks
// like.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Effect, Option, Schema } from "effect";

import { path } from "../routes-manifest";
import { parseRouteBody } from "../lib/route-body";
import { makeRunJson } from "../lib/run-json";
import { bootstrap, type Claims } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { grantsOf } from "../http";
import { requireCaller } from "../authz";
import { actionInput } from "../actions/types";
import {
  CompleteSprintBody,
  MembershipBody,
  PatchSprintBody,
  PostSprintBody,
  attachSprintIssue,
  boardTide,
  completeSprint,
  createSprint,
  deleteSprint,
  detachSprintIssue,
  listSprintArchivedIssues,
  listSprints,
  sprintTide,
  startSprint,
  updateSprint,
  type SprintServices,
  type SprintsFailure,
} from "../actions/sprints";

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<SprintsFailure>) => {
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

export const makeSprintsRouter = (layerFor: LayerFor = bootstrap) => {
  const sprints = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<SprintsFailure, SprintServices>(layerFor, errorResponse);

  // Org-scoped mounts contribute org_slug via the mount prefix (see the
  // identical note in issues.ts), so it is read off the request here and
  // handed to the action as a field rather than inferred from a URL there.
  const orgSlugOf = (c: Context<AppHonoEnv>): string | null =>
    (c.req.param() as Record<string, string | undefined>)["org_slug"] ?? null;

  sprints.get(path("sprint.list"), async (c) =>
    runJson(
      c,
      listSprints(
        actionInput<undefined, Claims | null>(c.get("claims") ?? null, c.req.param(), undefined, {
          grants: grantsOf(c),
          orgSlug: orgSlugOf(c),
        }),
      ),
    ),
  );

  sprints.post(path("sprint.create"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* createSprint(
        actionInput(claims, c.req.param(), parseRouteBody(c, PostSprintBody), {
          grants: grantsOf(c),
          orgSlug: orgSlugOf(c),
        }),
      );
    });
    return runJson(c, program, 201);
  });

  sprints.patch(path("sprint.update"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* updateSprint(
        actionInput(claims, c.req.param(), parseRouteBody(c, PatchSprintBody), {
          grants: grantsOf(c),
          orgSlug: orgSlugOf(c),
        }),
      );
    });
    return runJson(c, program);
  });

  sprints.post(path("sprint.start"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* startSprint(
        actionInput(claims, c.req.param(), undefined, { grants: grantsOf(c), orgSlug: orgSlugOf(c) }),
      );
    });
    return runJson(c, program);
  });

  sprints.post(path("sprint.complete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      // The body is OPTIONAL on this route — `POST .../complete` with no body
      // at all is the common case — and parseRouteBody raises the identical
      // `expected-json` reason the raw reader did, so the catch that made the
      // body optional carries over unchanged. Only that one reason is
      // swallowed: a body that IS present and malformed still 400s.
      //
      // Built, not run: the action yields it after its 409, which is where the
      // parse has always sat.
      const body = parseRouteBody(c, CompleteSprintBody).pipe(
        Effect.catchTag("ValidationError", (e) =>
          e.reason === "expected-json"
            ? Effect.succeed({} as Schema.Schema.Type<typeof CompleteSprintBody>)
            : Effect.fail(e),
        ),
      );
      return yield* completeSprint(
        actionInput(claims, c.req.param(), body, { grants: grantsOf(c), orgSlug: orgSlugOf(c) }),
      );
    });
    return runJson(c, program);
  });

  sprints.get(path("sprint.archivedIssues.list"), async (c) =>
    runJson(
      c,
      listSprintArchivedIssues(
        actionInput<undefined, Claims | null>(c.get("claims") ?? null, c.req.param(), undefined, {
          grants: grantsOf(c),
          orgSlug: orgSlugOf(c),
        }),
      ),
    ),
  );

  // `?days=` is read here rather than in the action, and `c.req.query()` hands
  // the whole query string over in one piece. Both tide routes sit on the
  // query allowlist (scripts/boundary-query-allowlist.json); EFB-87 re-audits
  // every entry against detection, so the read has to stay somewhere the
  // scanner looks — which is this file.
  sprints.get(path("sprint.tide"), async (c) =>
    runJson(
      c,
      sprintTide(
        actionInput<undefined, Claims | null>(c.get("claims") ?? null, c.req.param(), undefined, {
          grants: grantsOf(c),
          query: c.req.query(),
          orgSlug: orgSlugOf(c),
        }),
      ),
    ),
  );

  sprints.get(path("board.tide"), async (c) =>
    runJson(
      c,
      boardTide(
        actionInput<undefined, Claims | null>(c.get("claims") ?? null, c.req.param(), undefined, {
          grants: grantsOf(c),
          query: c.req.query(),
          orgSlug: orgSlugOf(c),
        }),
      ),
    ),
  );

  // The attach/detach pair — the routes EFB-98 exists for. Attaching is a POST
  // to the membership COLLECTION and detaching is a DELETE on the addressable
  // member, so the method carries the intent and the issue id sits where an
  // addressable thing belongs: in the path for DELETE, in the body for POST.
  //
  // EFB-17: migrated off the raw body reader. The hand-rolled
  // `typeof issue_id !== "string"` guard is now MembershipBody, and rejecting
  // an unrecognized key comes free with it. Both forms still answer `issue_id`
  // for a missing or non-string value.
  //
  // (The raw reader is deliberately not named here: check:boundary matches its
  // markers against raw file text, comments included, so writing that
  // identifier in prose classifies this route as half-migrated. It fails
  // closed — a loud `mixed` error, not a silent pass — but it is why this
  // sentence is phrased around the name.)
  //
  // DELETE addresses the member in the path and carries no body, so only the
  // attach side parses one. The action the two share reads both params
  // defensively; the note on `detachSprintIssue` says why.
  sprints.post(path("sprint.issues.attach"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* attachSprintIssue(
        actionInput(claims, c.req.param(), parseRouteBody(c, MembershipBody), {
          grants: grantsOf(c),
          orgSlug: orgSlugOf(c),
        }),
      );
    });
    return runJson(c, program);
  });

  sprints.delete(path("sprint.issue.detach"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* detachSprintIssue(
        actionInput(claims, c.req.param(), undefined, { grants: grantsOf(c), orgSlug: orgSlugOf(c) }),
      );
    });
    return runJson(c, program);
  });

  sprints.delete(path("sprint.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* deleteSprint(
        actionInput(claims, c.req.param(), undefined, { grants: grantsOf(c), orgSlug: orgSlugOf(c) }),
      );
    });
    return runJson(c, program);
  });

  return sprints;
};
