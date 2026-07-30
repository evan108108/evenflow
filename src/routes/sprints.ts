// /api/v0 sprints (phase 20) — a sprint is a named batch of backlog issues
// on one board that starts together and completes together.
//
// Lifecycle: planning → active → completed, one-way. Starting moves every
// sprint issue still in the backlog container to active (each move mirrored
// into statusChangeCache, same as the per-issue container endpoints).
// Completing stamps the sprint only — unfinished issues STAY active (the
// Linear model); the sprint just leaves the planning surface.
//
// Membership (issueCache.sprint_id) moves only through add-issue /
// remove-issue — issue PATCH rejects sprint_id as immutable.
//
// Auth: same posture as issues.ts — reads at "viewer" (anonymous works on
// public boards), every mutation requires a caller at "contributor".

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { AuditLog, Audience, BoardEmitter, Db, DbError, bootstrap } from "../effects";
import { emitSecureBoardEvent } from "../audiences";
import type { AppHonoEnv, LayerFor } from "../http";
import {
  ForbiddenError,
  UnauthorizedError,
  callerPubkey,
  callerPubkeyOrNull,
  requireCaller,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { parseIssueRow, parseSprintRow, type SprintShape } from "../shapes";

const MAX_NAME_LENGTH = 80;
const MAX_GOAL_LENGTH = 200;
const MIN_SPRINT_DAYS = 1;
const MAX_SPRINT_DAYS = 90;

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly reason: string;
}> {}
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}

type SprintsFailure =
  | ValidationError
  | ConflictError
  | NotFoundError
  | BoardOwnershipError
  | UnauthorizedError
  | ForbiddenError
  | DbError;

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

const validateName = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" && v.length <= MAX_NAME_LENGTH
    ? Effect.succeed(v)
    : Effect.fail(new ValidationError({ reason: "name" }));

const validateGoal = (v: unknown) =>
  v === null || (typeof v === "string" && v.length <= MAX_GOAL_LENGTH)
    ? Effect.succeed(v as string | null)
    : Effect.fail(new ValidationError({ reason: "goal" }));

/** null = use the board's default_sprint_days. */
const validatePlannedDays = (v: unknown) =>
  v === null ||
  (typeof v === "number" && Number.isInteger(v) && v >= MIN_SPRINT_DAYS && v <= MAX_SPRINT_DAYS)
    ? Effect.succeed(v as number | null)
    : Effect.fail(new ValidationError({ reason: "planned_days" }));

/** Fetch a sprint scoped to its board — an id on another board is a 404. */
const fetchSprint = (boardId: string, sprintId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst("SELECT * FROM sprintCache WHERE id = ? AND board_id = ?", [
      sprintId,
      boardId,
    ]);
    if (row === null) return yield* new NotFoundError({ reason: "sprint" });
    return parseSprintRow(row);
  });

export const makeSprintsRouter = (layerFor: LayerFor = bootstrap) => {
  const sprints = new Hono<AppHonoEnv>();

  // Org-scoped mounts contribute org_slug via the mount prefix (see the
  // identical note in issues.ts).
  const orgSlugOf = (c: Context<AppHonoEnv>): string | undefined =>
    (c.req.param() as Record<string, string | undefined>)["org_slug"];

  const boardScope = (c: Context<AppHonoEnv>, pubkey: string | null, minRole: string) =>
    resolveBoardScope(
      {
        org_slug: orgSlugOf(c),
        slug: (c.req.param() as Record<string, string | undefined>)["slug"] ?? "",
      },
      pubkey,
      minRole,
    );

  const runJson = async (
    c: Context<AppHonoEnv>,
    program: Effect.Effect<unknown, SprintsFailure, Db | AuditLog | BoardEmitter | Audience>,
    okStatus: 200 | 201 = 200,
  ) => {
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, okStatus);
  };

  // ── GET /boards/:slug/sprints — every sprint on the board ───────────────
  sprints.get("/boards/:slug/sprints", async (c) => {
    const program = Effect.gen(function* () {
      const { board } = yield* boardScope(c, callerPubkeyOrNull(c.get("claims")), "viewer");
      const db = yield* Db;
      const rows = yield* db.queryAll(
        "SELECT * FROM sprintCache WHERE board_id = ? ORDER BY created_at_ms ASC, id ASC",
        [board.id],
      );
      return { sprints: rows.map(parseSprintRow) };
    });
    return runJson(c, program);
  });

  // ── POST /boards/:slug/sprints — create, always planning-status ─────────
  sprints.post("/boards/:slug/sprints", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { board } = yield* boardScope(c, callerPubkey(claims), "contributor");
      const body = yield* readJsonBody(c);
      const name = yield* validateName(body["name"]);
      const goal = body["goal"] === undefined ? null : yield* validateGoal(body["goal"]);
      const planned_days =
        body["planned_days"] === undefined ? null : yield* validatePlannedDays(body["planned_days"]);

      const db = yield* Db;
      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      const sprint: SprintShape = {
        id: crypto.randomUUID(),
        board_id: board.id,
        name,
        goal,
        status: "planning",
        planned_days,
        started_at_ms: null,
        completed_at_ms: null,
        created_at_ms: now,
      };
      yield* db.execute(
        "INSERT INTO sprintCache (id, board_id, name, goal, status, planned_days, started_at_ms, completed_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [sprint.id, board.id, name, goal, "planning", planned_days, null, null, now],
      );
      yield* audit.record({
        event_type: "sprint_created",
        actor: claims.login,
        details: { board: board.slug, sprint: sprint.id },
      });
      return { sprint };
    });
    return runJson(c, program, 201);
  });

  // ── PATCH /boards/:slug/sprints/:id — rename, set goal ──────────────────
  sprints.patch("/boards/:slug/sprints/:id", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { board } = yield* boardScope(c, callerPubkey(claims), "contributor");
      const body = yield* readJsonBody(c);
      if (body["name"] === undefined && body["goal"] === undefined && body["planned_days"] === undefined) {
        return yield* new ValidationError({ reason: "empty-patch" });
      }
      const current = yield* fetchSprint(board.id, c.req.param("id"));
      const name = body["name"] === undefined ? current.name : yield* validateName(body["name"]);
      const goal = body["goal"] === undefined ? current.goal : yield* validateGoal(body["goal"]);
      // Length is a planning-time decision: once started, the countdown is
      // already running against it; once completed, it's history.
      if (body["planned_days"] !== undefined && current.status !== "planning") {
        return yield* new ConflictError({ reason: `sprint-${current.status}` });
      }
      const planned_days =
        body["planned_days"] === undefined
          ? current.planned_days
          : yield* validatePlannedDays(body["planned_days"]);

      const db = yield* Db;
      const audit = yield* AuditLog;
      yield* db.execute("UPDATE sprintCache SET name = ?, goal = ?, planned_days = ? WHERE id = ?", [
        name,
        goal,
        planned_days,
        current.id,
      ]);
      yield* audit.record({
        event_type: "sprint_updated",
        actor: claims.login,
        details: { board: board.slug, sprint: current.id },
      });
      return { sprint: { ...current, name, goal, planned_days } };
    });
    return runJson(c, program);
  });

  // ── POST /boards/:slug/sprints/:id/start ────────────────────────────────
  // The one-shot kickoff: every sprint issue still in the backlog container
  // moves to active (statusChangeCache row + board event per issue, same
  // vocabulary as the per-issue container endpoints), then the sprint
  // stamps started_at_ms and turns active.
  sprints.post("/boards/:slug/sprints/:id/start", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const { board } = yield* boardScope(c, pubkey, "contributor");
      const current = yield* fetchSprint(board.id, c.req.param("id"));
      if (current.status !== "planning") {
        return yield* new ConflictError({ reason: `sprint-${current.status}` });
      }

      const db = yield* Db;
      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;

      const rows = yield* db.queryAll(
        "SELECT * FROM issueCache WHERE board_id = ? AND sprint_id = ? AND container = 'backlog'",
        [board.id, current.id],
      );
      for (const row of rows) {
        const issue = parseIssueRow(row);
        yield* db.execute("UPDATE issueCache SET container = ?, updated_at_ms = ? WHERE id = ?", [
          "active",
          now,
          issue.id,
        ]);
        yield* db.execute(
          "INSERT INTO statusChangeCache (id, issue_id, board_id, actor_pubkey, from_status, to_status, from_container, to_container, container_at_completion, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [crypto.randomUUID(), issue.id, board.id, pubkey, null, null, "backlog", "active", null, now],
        );
        yield* emitSecureBoardEvent(board.id, {
          kind: "issue.container_changed",
          board_id: board.id,
          issue_id: issue.id,
          at_ms: now,
          payload: {
            issue: { ...issue, container: "active", updated_at_ms: now },
            from_container: "backlog",
            to_container: "active",
          },
        });
      }

      yield* db.execute("UPDATE sprintCache SET status = 'active', started_at_ms = ? WHERE id = ?", [
        now,
        current.id,
      ]);
      yield* audit.record({
        event_type: "sprint_started",
        actor: claims.login,
        details: { board: board.slug, sprint: current.id, issues_moved: rows.length },
      });
      return { sprint: { ...current, status: "active", started_at_ms: now }, issues_moved: rows.length };
    });
    return runJson(c, program);
  });

  // ── POST /boards/:slug/sprints/:id/complete ─────────────────────────────
  // Stamps the sprint only. Unfinished issues stay active on purpose.
  sprints.post("/boards/:slug/sprints/:id/complete", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { board } = yield* boardScope(c, callerPubkey(claims), "contributor");
      const current = yield* fetchSprint(board.id, c.req.param("id"));
      if (current.status !== "active") {
        return yield* new ConflictError({ reason: `sprint-${current.status}` });
      }

      const db = yield* Db;
      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      yield* db.execute(
        "UPDATE sprintCache SET status = 'completed', completed_at_ms = ? WHERE id = ?",
        [now, current.id],
      );
      yield* audit.record({
        event_type: "sprint_completed",
        actor: claims.login,
        details: { board: board.slug, sprint: current.id },
      });
      return { sprint: { ...current, status: "completed", completed_at_ms: now } };
    });
    return runJson(c, program);
  });

  // ── add-issue / remove-issue — the only writers of issueCache.sprint_id ─
  // Also writes the sprintMembership audit trail: add-issue inserts a fresh
  // open row (added_at_ms=now, removed_at_ms=null); remove-issue stamps the
  // existing open row's removed_at_ms. History survives across future
  // reassignments of the single-value sprint_id.
  const membershipEndpoint = (
    verb: "add-issue" | "remove-issue",
    apply: (sprint: SprintShape, issueId: string) => { sprint_id: string | null },
  ) => {
    sprints.post(`/boards/:slug/sprints/:id/${verb}`, async (c) => {
      const program = Effect.gen(function* () {
        const claims = yield* requireCaller(c.get("claims"));
        const { board } = yield* boardScope(c, callerPubkey(claims), "contributor");
        const body = yield* readJsonBody(c);
        if (typeof body["issue_id"] !== "string") {
          return yield* new ValidationError({ reason: "issue_id" });
        }
        const current = yield* fetchSprint(board.id, c.req.param("id"));
        if (current.status === "completed") {
          return yield* new ConflictError({ reason: "sprint-completed" });
        }

        const db = yield* Db;
        const row = yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ? AND board_id = ?", [
          body["issue_id"],
          board.id,
        ]);
        if (row === null) return yield* new NotFoundError({ reason: "issue" });
        const issue = parseIssueRow(row);

        const { sprint_id } = apply(current, issue.id);
        const now = yield* Clock.currentTimeMillis;
        yield* db.execute("UPDATE issueCache SET sprint_id = ?, updated_at_ms = ? WHERE id = ?", [
          sprint_id,
          now,
          issue.id,
        ]);
        if (verb === "add-issue") {
          yield* db.execute(
            "INSERT INTO sprintMembership (id, sprint_id, issue_id, added_at_ms) VALUES (?, ?, ?, ?)",
            [crypto.randomUUID(), current.id, issue.id, now],
          );
          if (current.status === "active") {
            yield* db.execute(
              "UPDATE sprintCache SET adds_mid_sprint = adds_mid_sprint + 1 WHERE id = ?",
              [current.id],
            );
          }
        } else {
          // Stamp only the still-open row for this (sprint, issue). A no-op
          // if there's no open row (issue was already remove-issue'd or the
          // sprint was created before membership audit existed and the pair
          // never got backfilled — the update just affects zero rows).
          yield* db.execute(
            "UPDATE sprintMembership SET removed_at_ms = ? WHERE sprint_id = ? AND issue_id = ? AND removed_at_ms IS NULL",
            [now, current.id, issue.id],
          );
        }
        const audit = yield* AuditLog;
        yield* audit.record({
          event_type: verb === "add-issue" ? "sprint_issue_added" : "sprint_issue_removed",
          actor: claims.login,
          details: { board: board.slug, sprint: current.id, issue: issue.id },
        });
        const updated = { ...issue, sprint_id, updated_at_ms: now };
        yield* emitSecureBoardEvent(board.id, {
          kind: "issue.updated",
          board_id: board.id,
          issue_id: issue.id,
          at_ms: now,
          payload: { issue: updated },
        });
        return { issue: updated };
      });
      return runJson(c, program);
    });
  };
  membershipEndpoint("add-issue", (sprint) => ({ sprint_id: sprint.id }));
  membershipEndpoint("remove-issue", () => ({ sprint_id: null }));

  // ── DELETE /boards/:slug/sprints/:id ─────────────────────────────────────
  // Planning sprints only. Clears sprint_id on every member issue, deletes
  // membership rows (a planning sprint that never started has no history
  // worth keeping), then deletes the sprint. Active/completed sprints must
  // be completed first — deleting them would destroy the audit trail that
  // velocity and sprint archives depend on.
  sprints.delete("/boards/:slug/sprints/:id", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { board } = yield* boardScope(c, callerPubkey(claims), "contributor");
      const current = yield* fetchSprint(board.id, c.req.param("id"));
      if (current.status !== "planning") {
        return yield* new ConflictError({ reason: `sprint-${current.status}` });
      }

      const db = yield* Db;
      const now = yield* Clock.currentTimeMillis;
      // Members get their sprint_id cleared and an updated_at bump so
      // subscribers (SSE) refresh. Do it BEFORE deleting the sprint so we
      // can enumerate them, then broadcast one issue.updated per member.
      const memberRows = yield* db.queryAll(
        "SELECT * FROM issueCache WHERE sprint_id = ?",
        [current.id],
      );
      yield* db.execute(
        "UPDATE issueCache SET sprint_id = NULL, updated_at_ms = ? WHERE sprint_id = ?",
        [now, current.id],
      );
      // sprintMembership rows are FK'd ON DELETE CASCADE; deleting the
      // sprint takes them out too. Explicit for the audit log's benefit.
      yield* db.execute("DELETE FROM sprintMembership WHERE sprint_id = ?", [current.id]);
      yield* db.execute("DELETE FROM sprintCache WHERE id = ?", [current.id]);

      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "sprint_deleted",
        actor: claims.login,
        details: { board: board.slug, sprint: current.id, member_count: memberRows.length },
      });
      for (const row of memberRows) {
        const issue = parseIssueRow(row);
        const updated = { ...issue, sprint_id: null, updated_at_ms: now };
        yield* emitSecureBoardEvent(board.id, {
          kind: "issue.updated",
          board_id: board.id,
          issue_id: issue.id,
          at_ms: now,
          payload: { issue: updated },
        });
      }
      return { deleted: true, member_count: memberRows.length };
    });
    return runJson(c, program);
  });

  return sprints;
};
