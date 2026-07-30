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
import { parseBoardRow, parseIssueRow, parseSprintRow, type BoardShape, type SprintShape } from "../shapes";
import { isDoneStatus } from "../columns";
import {
  DEFAULT_TIDE_DAYS,
  MAX_TIDE_DAYS,
  computeTide,
  dayRange,
  tideDirection,
  utcDayStart,
  type TideInput,
} from "../lib/tide/compute";
import { loadKanbanTideInput, loadSprintTideInput } from "../lib/tide/facts";
import { rollForwardNow, type TideSubject } from "../lib/tide/snapshot";
import { publishTide } from "../lib/tide/publish";

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
      const sprints = rows.map(parseSprintRow);
      // Backfill for sprints started under phase 21a (before the start
      // handler snapshotted points_committed_start): if the field is null on
      // an active sprint, derive it from current members and persist it so
      // the next read is a cheap SELECT again. Completed sprints without the
      // snapshot get the derivation as read-only (their real committed set
      // is gone).
      const patched: SprintShape[] = [];
      for (const s of sprints) {
        if (s.points_committed_start !== null) {
          patched.push(s);
          continue;
        }
        const members = yield* db.queryAll(
          "SELECT estimate FROM issueCache WHERE sprint_id = ?",
          [s.id],
        );
        const derived = members.reduce(
          (sum: number, r) => sum + ((r as { estimate: number | null }).estimate ?? 0),
          0,
        );
        if (s.status === "active") {
          yield* db.execute(
            "UPDATE sprintCache SET points_committed_start = ? WHERE id = ?",
            [derived, s.id],
          );
        }
        patched.push({ ...s, points_committed_start: derived });
      }
      return { sprints: patched };
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
        // Metrics land at start/complete time; a fresh sprint carries the
        // same values the 0018 columns default to.
        points_committed_start: null,
        points_completed: null,
        points_carried: null,
        adds_mid_sprint: 0,
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

      // Backlog members promote to active — same behavior as before.
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

      // Phase 21 remodel — starting a sprint IS a commitment to what's
      // in-flight. Any container=active issue not already in a done column
      // and not already assigned to this sprint auto-joins the sprint (its
      // sprint_id rewrites, membership audit updates). Anything the user
      // deliberately wants OUT of this sprint they can drag off after start.
      const boardRow = yield* db.queryFirst("SELECT * FROM boardCache WHERE id = ?", [board.id]);
      if (boardRow === null) return yield* new NotFoundError({ reason: "board" });
      const boardShape = parseBoardRow(boardRow);
      const activeRows = yield* db.queryAll(
        "SELECT * FROM issueCache WHERE board_id = ? AND container = 'active'",
        [board.id],
      );
      let sweptIn = 0;
      for (const row of activeRows) {
        const issue = parseIssueRow(row);
        if (issue.sprint_id === current.id) continue;
        if (isDoneStatus(boardShape.columns, issue.status)) continue;
        // Close any open membership on the issue's previous sprint (if any).
        if (issue.sprint_id !== null) {
          yield* db.execute(
            "UPDATE sprintMembership SET removed_at_ms = ? WHERE sprint_id = ? AND issue_id = ? AND removed_at_ms IS NULL",
            [now, issue.sprint_id, issue.id],
          );
        }
        yield* db.execute(
          "UPDATE issueCache SET sprint_id = ?, updated_at_ms = ? WHERE id = ?",
          [current.id, now, issue.id],
        );
        yield* db.execute(
          "INSERT INTO sprintMembership (id, sprint_id, issue_id, added_at_ms) VALUES (?, ?, ?, ?)",
          [crypto.randomUUID(), current.id, issue.id, now],
        );
        yield* emitSecureBoardEvent(board.id, {
          kind: "issue.updated",
          board_id: board.id,
          issue_id: issue.id,
          at_ms: now,
          payload: { issue: { ...issue, sprint_id: current.id, updated_at_ms: now } },
        });
        sweptIn += 1;
      }

      // Snapshot the committed points at start — sum over all current
      // members (the backlog ones just promoted, sprint pre-planned ones,
      // and the just-swept active ones).
      const allMembers = yield* db.queryAll(
        "SELECT estimate FROM issueCache WHERE sprint_id = ?",
        [current.id],
      );
      const pointsCommitted = allMembers.reduce(
        (sum: number, r) => sum + ((r as { estimate: number | null }).estimate ?? 0),
        0,
      );
      yield* db.execute(
        "UPDATE sprintCache SET status = 'active', started_at_ms = ?, points_committed_start = ? WHERE id = ?",
        [now, pointsCommitted, current.id],
      );
      yield* audit.record({
        event_type: "sprint_started",
        actor: claims.login,
        details: {
          board: board.slug,
          sprint: current.id,
          issues_moved: rows.length,
          issues_swept_in: sweptIn,
          points_committed_start: pointsCommitted,
        },
      });
      return {
        sprint: {
          ...current,
          status: "active" as const,
          started_at_ms: now,
          points_committed_start: pointsCommitted,
        },
        issues_moved: rows.length,
        issues_swept_in: sweptIn,
      };
    });
    return runJson(c, program);
  });

  // ── POST /boards/:slug/sprints/:id/complete ─────────────────────────────
  // Body: { carryOver?: "next_planning" | "drop", nextSprintId?: string }.
  //   - "next_planning" (default): move non-Done members' sprint_id to
  //     nextSprintId. If nextSprintId is omitted, auto-pick the oldest
  //     planning sprint on the same board; if none exists, fall through
  //     to "drop" (records that in the audit trail).
  //   - "drop": clear sprint_id on non-Done members. They go back to the
  //     Backlog view's Unassigned pile.
  // Done members keep their sprint_id — that's how their audit row records
  // "was_completed_in_sprint = true" — so the sprint archive can list them
  // forever. Points_completed / points_carried get snapshotted on the
  // sprint row here so the archive endpoint is a cheap read.
  sprints.post("/boards/:slug/sprints/:id/complete", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { board } = yield* boardScope(c, callerPubkey(claims), "contributor");
      const current = yield* fetchSprint(board.id, c.req.param("id"));
      if (current.status !== "active") {
        return yield* new ConflictError({ reason: `sprint-${current.status}` });
      }
      const body = yield* readJsonBody(c).pipe(
        Effect.catchTag("ValidationError", (e) =>
          e.reason === "expected-json" ? Effect.succeed({} as Record<string, unknown>) : Effect.fail(e),
        ),
      );
      const carryOver: "next_planning" | "drop" =
        body["carryOver"] === "drop" ? "drop" : "next_planning";
      const requestedNext =
        typeof body["nextSprintId"] === "string" ? (body["nextSprintId"] as string) : null;

      const db = yield* Db;
      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;

      // Resolve the destination sprint for carry-over. If the caller named
      // one, it MUST be a planning sprint on this board; if they didn't,
      // we pick the oldest planning sprint (created_at_ms ASC) — closest
      // to "the next one" a user would expect.
      let nextSprintId: string | null = null;
      if (carryOver === "next_planning") {
        if (requestedNext !== null) {
          const next = yield* fetchSprint(board.id, requestedNext);
          if (next.status !== "planning") {
            return yield* new ValidationError({ reason: "next-sprint-not-planning" });
          }
          if (next.id === current.id) {
            return yield* new ValidationError({ reason: "next-sprint-is-self" });
          }
          nextSprintId = next.id;
        } else {
          const auto = yield* db.queryFirst(
            "SELECT id FROM sprintCache WHERE board_id = ? AND status = 'planning' AND id != ? ORDER BY created_at_ms ASC LIMIT 1",
            [board.id, current.id],
          );
          nextSprintId = auto === null ? null : (auto as { id: string }).id;
        }
      }

      // Board columns are needed to classify each member's column category.
      const boardRow = yield* db.queryFirst("SELECT * FROM boardCache WHERE id = ?", [board.id]);
      if (boardRow === null) return yield* new NotFoundError({ reason: "board" });
      const boardShape: BoardShape = parseBoardRow(boardRow);

      const memberRows = yield* db.queryAll(
        "SELECT * FROM issueCache WHERE sprint_id = ?",
        [current.id],
      );

      let pointsCompleted = 0;
      let pointsCarried = 0;
      for (const row of memberRows) {
        const issue = parseIssueRow(row);
        const isDone = isDoneStatus(boardShape.columns, issue.status);
        const pts = issue.estimate ?? 0;
        if (isDone) {
          pointsCompleted += pts;
          // Mark the open membership row as completed-in-sprint. Leave
          // sprint_id alone so the archive can enumerate the row later.
          yield* db.execute(
            "UPDATE sprintMembership SET removed_at_ms = ?, was_completed_in_sprint = 1 WHERE sprint_id = ? AND issue_id = ? AND removed_at_ms IS NULL",
            [now, current.id, issue.id],
          );
          continue;
        }
        pointsCarried += pts;
        // Non-Done: either carry to next planning sprint (if we resolved one)
        // or drop. carriedTo captures BOTH the branch and the destination.
        const carriedTo = nextSprintId; // null when dropping (or nothing to carry into)
        yield* db.execute(
          "UPDATE sprintMembership SET removed_at_ms = ?, carried_to_sprint_id = ? WHERE sprint_id = ? AND issue_id = ? AND removed_at_ms IS NULL",
          [now, carriedTo, current.id, issue.id],
        );
        yield* db.execute(
          "UPDATE issueCache SET sprint_id = ?, updated_at_ms = ? WHERE id = ?",
          [carriedTo, now, issue.id],
        );
        if (carriedTo !== null) {
          yield* db.execute(
            "INSERT INTO sprintMembership (id, sprint_id, issue_id, added_at_ms) VALUES (?, ?, ?, ?)",
            [crypto.randomUUID(), carriedTo, issue.id, now],
          );
        }
        yield* emitSecureBoardEvent(board.id, {
          kind: "issue.updated",
          board_id: board.id,
          issue_id: issue.id,
          at_ms: now,
          payload: { issue: { ...issue, sprint_id: carriedTo, updated_at_ms: now } },
        });
      }

      yield* db.execute(
        "UPDATE sprintCache SET status = 'completed', completed_at_ms = ?, points_completed = ?, points_carried = ? WHERE id = ?",
        [now, pointsCompleted, pointsCarried, current.id],
      );
      yield* audit.record({
        event_type: "sprint_completed",
        actor: claims.login,
        details: {
          board: board.slug,
          sprint: current.id,
          points_completed: pointsCompleted,
          points_carried: pointsCarried,
          carry_over: carryOver,
          carry_to_sprint: nextSprintId,
        },
      });
      return {
        sprint: {
          ...current,
          status: "completed" as const,
          completed_at_ms: now,
          points_completed: pointsCompleted,
          points_carried: pointsCarried,
        },
        carried_to_sprint_id: nextSprintId,
        dropped_count: carryOver === "next_planning" && nextSprintId === null
          ? memberRows.filter((r) => !isDoneStatus(boardShape.columns, parseIssueRow(r).status)).length
          : 0,
      };
    });
    return runJson(c, program);
  });

  // ── GET /boards/:slug/sprints/:id/archive ────────────────────────────────
  // Snapshot of every issue that was ever in this sprint (from the audit
  // trail), grouped by outcome. Works for any sprint status; a
  // planning/active sprint shows its members with removed_at_ms=null all
  // in the "open" bucket, since they haven't been completed or carried yet.
  sprints.get("/boards/:slug/sprints/:id/archive", async (c) => {
    const program = Effect.gen(function* () {
      const claims = c.get("claims");
      const pubkey = callerPubkeyOrNull(claims);
      const { board } = yield* boardScope(c, pubkey, "viewer");
      const current = yield* fetchSprint(board.id, c.req.param("id"));

      const db = yield* Db;
      // JOIN membership to issue so we can pass through the display fields
      // in one round-trip.
      const rows = yield* db.queryAll(
        "SELECT m.*, i.title, i.short_id, i.status, i.column_id, i.estimate, i.assignee_pubkey, i.priority FROM sprintMembership m LEFT JOIN issueCache i ON i.id = m.issue_id WHERE m.sprint_id = ? ORDER BY m.added_at_ms ASC",
        [current.id],
      );
      const completed: unknown[] = [];
      const carried: unknown[] = [];
      const dropped: unknown[] = [];
      const open: unknown[] = [];
      for (const r of rows as Array<Record<string, unknown>>) {
        const entry = {
          membership_id: r["id"],
          issue_id: r["issue_id"],
          added_at_ms: r["added_at_ms"],
          removed_at_ms: r["removed_at_ms"],
          was_completed_in_sprint: r["was_completed_in_sprint"] === 1,
          carried_to_sprint_id: r["carried_to_sprint_id"],
          title: r["title"],
          short_id: r["short_id"],
          status: r["status"],
          estimate: r["estimate"],
          assignee_pubkey: r["assignee_pubkey"],
          priority: r["priority"],
        };
        if (r["was_completed_in_sprint"] === 1) completed.push(entry);
        else if (r["removed_at_ms"] === null) open.push(entry);
        else if (r["carried_to_sprint_id"] !== null) carried.push(entry);
        else dropped.push(entry);
      }
      return {
        sprint: current,
        completed_in_sprint: completed,
        carried_over: carried,
        dropped: dropped,
        open: open,
      };
    });
    return runJson(c, program);
  });

  // ── GET /boards/:slug/sprints/:id/tide + GET /boards/:slug/tide ─────────
  // Points remaining over the last N days: the sparkline behind TideBadge.
  //
  // Every day in the window is replayed live from audit rows, so the numbers
  // are right even where no snapshot was ever written (a substrate outage, or
  // days predating migration 0021). The snapshot table is the durable +
  // published record, not the source of the answer.
  //
  // Reads are the lazy roll-forward trigger: the first visit of a new day
  // closes out yesterday. Quiet boards get the same treatment from the cron.
  const tideResponse = (
    subject: TideSubject,
    input: TideInput,
    subjectStartedAtMs: number,
  ): Effect.Effect<unknown, DbError, Db | Audience | BoardEmitter> =>
    Effect.gen(function* () {
      const readings = computeTide(input);
      const closed = yield* rollForwardNow(subject, readings, subjectStartedAtMs);
      // A day that just closed is published once. Best-effort by design: the
      // reading above is already correct whether or not 4a takes it.
      if (closed !== null) {
        const now = yield* Clock.currentTimeMillis;
        yield* publishTide({
          subject,
          snapshot_id: closed.snapshot_id,
          reading: closed.reading,
          at_ms: now,
        });
      }
      return {
        days: readings,
        today: readings[readings.length - 1] ?? null,
        direction: tideDirection(readings),
      };
    });

  const requestedDays = (c: Context<AppHonoEnv>) =>
    Effect.gen(function* () {
      const raw = c.req.query("days");
      if (raw === undefined) return DEFAULT_TIDE_DAYS;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TIDE_DAYS) {
        return yield* new ValidationError({ reason: "days" });
      }
      return parsed;
    });

  /** Board row with columns parsed — done-ness is a column category, not a name. */
  const fetchBoardShape = (boardId: string) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const row = yield* db.queryFirst("SELECT * FROM boardCache WHERE id = ?", [boardId]);
      if (row === null) return yield* new NotFoundError({ reason: "board" });
      return parseBoardRow(row);
    });

  sprints.get("/boards/:slug/sprints/:id/tide", async (c) => {
    const program = Effect.gen(function* () {
      const { board } = yield* boardScope(c, callerPubkeyOrNull(c.get("claims")), "viewer");
      const sprint = yield* fetchSprint(board.id, c.req.param("id"));
      const days = yield* requestedDays(c);
      const boardShape = yield* fetchBoardShape(board.id);
      const now = yield* Clock.currentTimeMillis;
      const input = yield* loadSprintTideInput(
        sprint.id,
        boardShape.columns,
        sprint.completed_at_ms,
        dayRange(utcDayStart(now), days),
      );
      return yield* tideResponse(
        { board_id: board.id, sprint_id: sprint.id },
        input,
        sprint.created_at_ms,
      );
    });
    return runJson(c, program);
  });

  sprints.get("/boards/:slug/tide", async (c) => {
    const program = Effect.gen(function* () {
      const { board } = yield* boardScope(c, callerPubkeyOrNull(c.get("claims")), "viewer");
      const days = yield* requestedDays(c);
      const boardShape = yield* fetchBoardShape(board.id);
      const now = yield* Clock.currentTimeMillis;
      const input = yield* loadKanbanTideInput(
        board.id,
        boardShape.columns,
        boardShape.done_window_days,
        dayRange(utcDayStart(now), days),
      );
      return yield* tideResponse(
        { board_id: board.id, sprint_id: null },
        input,
        boardShape.created_at_ms,
      );
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
        let promotedContainer: "active" | null = null;
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
            // Symmetric with start-sprint sweep: an issue added mid-sprint to
            // the ACTIVE sprint auto-promotes to container=active so it lands
            // on the Kanban immediately. Iced issues stay iced — icing was an
            // explicit "not now"; scooping them here would surprise the user.
            if (issue.container === "backlog") {
              yield* db.execute(
                "UPDATE issueCache SET container = ? WHERE id = ?",
                ["active", issue.id],
              );
              yield* db.execute(
                "INSERT INTO statusChangeCache (id, issue_id, board_id, actor_pubkey, from_status, to_status, from_container, to_container, container_at_completion, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [crypto.randomUUID(), issue.id, board.id, callerPubkey(claims), null, null, "backlog", "active", null, now],
              );
              promotedContainer = "active";
            }
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
        const updated = {
          ...issue,
          sprint_id,
          container: promotedContainer ?? issue.container,
          updated_at_ms: now,
        };
        yield* emitSecureBoardEvent(board.id, {
          kind: promotedContainer !== null ? "issue.container_changed" : "issue.updated",
          board_id: board.id,
          issue_id: issue.id,
          at_ms: now,
          payload:
            promotedContainer !== null
              ? { issue: updated, from_container: "backlog", to_container: "active" }
              : { issue: updated },
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
