// Sprint actions (phase 20) — a sprint is a named batch of backlog issues
// on one board that starts together and completes together.
//
// Lifecycle: planning → active → completed, one-way. Starting moves every
// sprint issue still in the backlog container to active (each move mirrored
// into statusChangeCache, same as the per-issue container endpoints).
// Completing stamps the sprint only — unfinished issues STAY active (the
// Linear model); the sprint just leaves the planning surface.
//
// Membership (issueCache.sprint_id) moves only through attach / detach —
// issue PATCH rejects sprint_id as immutable.
//
// Auth: same posture as issues.ts — reads at "viewer" (anonymous works on
// public boards), every mutation requires a caller at "contributor". An action
// taking `ActionInput` is guaranteed a caller because the route ran
// `requireCaller` and passed the result; one taking `PublicActionInput` can be
// reached anonymously and says so in its signature.
//
// EFB-98 split this file out of src/routes/sprints.ts. The bodies moved
// VERBATIM — every comment, ordering decision and failure reason below is the
// pre-split code, and the only edits read params/body/claims off `input`
// instead of off a Context. The route keeps what is genuinely transport: the
// body parse (so check:boundary keeps seeing parseRouteBody where it always
// has) and the failure-union-to-status-code mapping.

import { Clock, Effect, Schema } from "effect";

import { AuditLog, Audience, BoardEmitter, Db, DbError } from "../effects";
import { emitSecureBoardEvent } from "../audiences";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import {
  ForbiddenError,
  UnauthorizedError,
  callerPubkey,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { ImmutableField, ProvenanceFromCaller, requireAnyOf } from "../lib/route-body";
import { insertStatusChange } from "../lib/status-change";
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
import type { Grant } from "../scopes";
import type { ActionInput, PublicActionInput } from "./types";

const MAX_NAME_LENGTH = 80;
const MAX_GOAL_LENGTH = 200;
const MIN_SPRINT_DAYS = 1;
const MAX_SPRINT_DAYS = 90;

/**
 * The failure union this family answers.
 *
 * The three tagged classes it names used to be declared inside
 * src/routes/sprints.ts. They come from src/lib/errors.ts now: they are domain
 * facts an action raises without knowing anything about HTTP, and the file
 * that maps a tag to a status code is the route's, not this one's.
 */
export type SprintsFailure =
  | ValidationError
  | ConflictError
  | NotFoundError
  | BoardOwnershipError
  | UnauthorizedError
  | ForbiddenError
  | DbError;

/** Services every sprint action needs. */
export type SprintServices = Db | AuditLog | BoardEmitter | Audience;

/**
 * A body whose parse the route deliberately DEFERRED.
 *
 * Every body-bearing sprint route gated before it parsed: `boardScope` runs
 * first on all four, and `complete` also answers 409 for a non-active sprint
 * before it looks at a body. That order is load-bearing. A caller who cannot
 * see the board has always been told 404 whether or not their body was also
 * malformed, and a `POST .../complete` against a planning sprint has always
 * been told 409 — a shell that parsed first would answer 400 in both places.
 * BOUNDARY_DISCIPLINE.md (§"Existing behavior must not change") reserves a
 * status-code change for its own ticket rather than a migration.
 *
 * Effects are lazy, so the route builds `parseRouteBody(c, Schema)` without
 * running it — check:boundary still sees the marker exactly where it always
 * has — and the action yields it at the line the parse used to sit on. The
 * type reads oddly on purpose: it says out loud that the deferral is
 * deliberate, so the next reader does not flatten it back to `input.body`.
 */
export type DeferredBody<A> = Effect.Effect<A, ValidationError>;

/** null = use the board's default_sprint_days. */
const validatePlannedDays = (v: unknown) =>
  v === null ||
  (typeof v === "number" && Number.isInteger(v) && v >= MIN_SPRINT_DAYS && v <= MAX_SPRINT_DAYS)
    ? Effect.succeed(v as number | null)
    : Effect.fail(new ValidationError({ reason: "planned_days" }));

// ── EFB-84 request shapes ─────────────────────────────────────────────────
//
// The four invariants come from parseRouteBody, not from anything here:
// unknown keys 400, wrong types 400, missing-required 400, canonical output.
// See docs/BOUNDARY_DISCIPLINE.md.
//
// Filters return BOOLEANS, not message strings, for the same reason boards.ts
// records: a bare kebab message is read as a reason CODE and would surface as
// `name-<slug>`, where a boolean false falls back to the bare field name —
// which is the string these routes already answer.

/**
 * A sprint name.
 *
 * `.trim() !== ""` is NOT `minLength(1)` — the latter accepts "   ". And the
 * length cap measures the UNTRIMMED string, exactly as `validateName` did:
 * two leading spaces plus 79 characters is 81 and rejected today. Both halves
 * are load-bearing predicate fidelity, not incidental phrasing.
 */
const SprintName = Schema.String.pipe(
  Schema.filter((s) => s.trim() !== "" && s.length <= MAX_NAME_LENGTH),
);

/** null is a real value here — "use the board's default", not "absent". */
const SprintGoal = Schema.NullOr(
  Schema.String.pipe(Schema.filter((s) => s.length <= MAX_GOAL_LENGTH)),
);

const PlannedDays = Schema.NullOr(
  Schema.Int.pipe(Schema.between(MIN_SPRINT_DAYS, MAX_SPRINT_DAYS)),
);

export const PostSprintBody = Schema.Struct({
  name: SprintName,
  goal: Schema.optional(SprintGoal),
  planned_days: Schema.optional(PlannedDays),
});

/** Mutable via PATCH — the list `empty-patch` is computed from. */
const PATCHABLE_SPRINT_FIELDS = ["name", "goal", "planned_days"] as const;

export const PatchSprintBody = Schema.Struct({
  name: Schema.optional(SprintName),
  goal: Schema.optional(SprintGoal),
  /**
   * Deliberately `Unknown`, keeping `validatePlannedDays` in the action.
   *
   * Not an oversight and not laziness — it is the only way to preserve a
   * STATUS CODE. Length is a planning-time decision, so the action answers
   * 409 `sprint-active` for any `planned_days` sent against a started sprint,
   * and it does that check BEFORE validating the value. Typing the field here
   * would move validation ahead of the conflict check, turning
   * `{planned_days: 999}` on an active sprint from 409 into 400.
   *
   * BOUNDARY_DISCIPLINE.md draws exactly this line: previously-SILENT failures
   * become 400, but a migration that changes a status code needs its own
   * ticket. A loud 409 is not a silent failure. Same shape as `issue_prefix`
   * in boards.ts, which stays untyped for the same conflict-before-validate
   * reason.
   */
  planned_days: Schema.optional(Schema.Unknown),
  /**
   * Real sprint columns this route may not write. Declared rather than left to
   * the unknown-key rule so a caller reaching for the wrong endpoint is told
   * `status-immutable` ("real field, wrong endpoint" — start/complete are the
   * endpoints) instead of `status-unknown` ("no such field"), which would send
   * them hunting for a typo.
   *
   * The metric columns (points_*, adds_mid_sprint, substrate_event_id) and the
   * timestamps are deliberately NOT listed: nothing writes them but the server,
   * so a client sending one has not confused an endpoint, and `-unknown` is the
   * honest answer.
   */
  id: ImmutableField,
  board_id: ImmutableField,
  status: ImmutableField,
}).pipe(Schema.filter(requireAnyOf(PATCHABLE_SPRINT_FIELDS)));

/**
 * Body for POST /boards/:slug/sprints/:id/complete — every field optional,
 * and the whole body optional (see the route's `expected-json` catch).
 *
 * STRICT, and that is a deliberate wire change. The handler used to COERCE
 * rather than validate: `carryOver === "drop" ? "drop" : "next_planning"` and
 * `typeof nextSprintId === "string" ? … : null`. So `{"carryOver":"bogus"}`
 * and `{"carryOver":123}` both silently meant next_planning, and
 * `{"nextSprintId":42}` silently meant "auto-pick the oldest planning sprint" —
 * a caller with a typo watched their issues carry over and concluded the drop
 * had happened. Those are previously-silent failures, which is precisely the
 * category BOUNDARY_DISCIPLINE.md says a migration converts to 400.
 *
 * `nextSprintId` keeps NULL as an accepted spelling. Null is not a typo here —
 * it is how a client says "no specific next sprint, pick one", which is what
 * the handler already does with it. Rejecting it would break a shape that
 * works today for no safety gain. `carryOver` gets no such allowance: null is
 * not a natural spelling of a member of a two-value enum.
 *
 * `Schema.String`, not `NonEmptyString`, matching MembershipBody below: an
 * empty id reaches the lookup and answers 404 `sprint` today, and turning that
 * into a 400 is the status-code change this ticket does not get to make.
 */
export const CompleteSprintBody = Schema.Struct({
  carryOver: Schema.optional(Schema.Literal("next_planning", "drop")),
  nextSprintId: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * Body for attach / detach.
 *
 * `Schema.String`, deliberately NOT `NonEmptyString`. An empty id currently
 * reaches the lookup and answers 404 `issue`; tightening it here would turn
 * that into a 400, and BOUNDARY_DISCIPLINE.md asks that a migration change
 * no status code without its own ticket. Whether an empty reference should
 * fail as shape rather than as a lookup miss is a real question — it is just
 * not this ticket's to answer.
 */
export const MembershipBody = Schema.Struct({ issue_id: Schema.String });

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

/**
 * Resolve the addressed board and prove the caller's role on it.
 *
 * Org-scoped mounts contribute org_slug via the mount prefix (see the
 * identical note in issues.ts), which is why `orgSlug` is a field on the input
 * rather than something read out of a URL here.
 */
const boardScope = (
  input: {
    readonly orgSlug: string | null;
    readonly params: Readonly<Record<string, string>>;
    readonly grants: readonly Grant[] | null;
  },
  pubkey: string | null,
  minRole: string,
) =>
  resolveBoardScope(
    {
      org_slug: input.orgSlug ?? undefined,
      slug: input.params["slug"] ?? "",
    },
    pubkey,
    minRole, input.grants,);

/** The caller's pubkey, or null when the request is anonymous. */
const pubkeyOf = (claims: PublicActionInput["claims"]): string | null =>
  claims === null ? null : callerPubkey(claims);

// ── GET /boards/:slug/sprints — every sprint on the board ───────────────
export const listSprints = (
  input: PublicActionInput,
): Effect.Effect<{ sprints: SprintShape[] }, SprintsFailure, SprintServices> =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, pubkeyOf(input.claims), "viewer");
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

// ── POST /boards/:slug/sprints — create, always planning-status ─────────
export const createSprint = (
  input: ActionInput<DeferredBody<typeof PostSprintBody.Type>>,
): Effect.Effect<{ sprint: SprintShape }, SprintsFailure, SprintServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const { board } = yield* boardScope(input, callerPubkey(claims), "contributor");
    // AFTER the board gate, deliberately — see DeferredBody. A caller who
    // cannot see this board gets its 404/403, not a 400 about their body.
    const body = yield* input.body;
    const name = body.name;
    const goal = body.goal ?? null;
    const planned_days = body.planned_days ?? null;

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
      // Publish is fired off the request path (EFB-24) — not landed yet.
      substrate_event_id: null,
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
    yield* emitSecureBoardEvent(
      board.id,
      {
        kind: "sprint.created",
        board_id: board.id,
        sprint_id: sprint.id,
        at_ms: now,
        payload: { sprint },
      },
      null,
    );
    return { sprint };
  });

// ── PATCH /boards/:slug/sprints/:id — rename, set goal ──────────────────
export const updateSprint = (
  input: ActionInput<DeferredBody<typeof PatchSprintBody.Type>>,
): Effect.Effect<unknown, SprintsFailure, SprintServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const { board } = yield* boardScope(input, callerPubkey(claims), "contributor");
    // AFTER the board gate and BEFORE fetchSprint, which is where the parse has
    // always sat — see DeferredBody. Both neighbours matter: an invisible board
    // still answers 404 rather than 400, and `empty-patch` still comes off the
    // schema's struct-level filter before the sprint is fetched. Same reason,
    // same status, and the ordering is invisible: an empty body answered 400
    // before reaching fetchSprint under the old code too.
    const body = yield* input.body;
    const current = yield* fetchSprint(board.id, input.params["id"] ?? "");
    const name = body.name === undefined ? current.name : body.name;
    const goal = body.goal === undefined ? current.goal : body.goal;
    // Length is a planning-time decision: once started, the countdown is
    // already running against it; once completed, it's history. Checked
    // BEFORE the value is validated, which is why `planned_days` is still
    // `Unknown` at the schema — see the note on PatchSprintBody.
    if (body.planned_days !== undefined && current.status !== "planning") {
      return yield* new ConflictError({ reason: `sprint-${current.status}` });
    }
    const planned_days =
      body.planned_days === undefined
        ? current.planned_days
        : yield* validatePlannedDays(body.planned_days);

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
    const sprint = { ...current, name, goal, planned_days };
    yield* emitSecureBoardEvent(
      board.id,
      {
        kind: "sprint.updated",
        board_id: board.id,
        sprint_id: current.id,
        at_ms: yield* Clock.currentTimeMillis,
        payload: { sprint },
      },
      null,
    );
    return { sprint };
  });

// ── POST /boards/:slug/sprints/:id/start ────────────────────────────────
// The one-shot kickoff: every sprint issue still in the backlog container
// moves to active (statusChangeCache row + board event per issue, same
// vocabulary as the per-issue container endpoints), then the sprint
// stamps started_at_ms and turns active.
export const startSprint = (
  input: ActionInput,
): Effect.Effect<unknown, SprintsFailure, SprintServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const pubkey = callerPubkey(claims);
    const { board } = yield* boardScope(input, pubkey, "contributor");
    const current = yield* fetchSprint(board.id, input.params["id"] ?? "");
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
      // EFB-91: through the shared writer, and the returned id is the point.
      // This callsite used to mint the uuid inline and drop it, which is the
      // pre-EFB-33 shape lib/status-change.ts was written to delete — an id
      // that never leaves the INSERT leaves the publish path with nothing to
      // sign against, so the 30553 never fired for a sprint start.
      const statusChangeId = yield* insertStatusChange({
        issue_id: issue.id,
        board_id: board.id,
        actor_pubkey: pubkey,
        from_status: null,
        to_status: null,
        from_container: "backlog",
        to_container: "active",
        container_at_completion: null,
        occurred_at_ms: now,
      });
      yield* emitSecureBoardEvent(
        board.id,
        {
          kind: "issue.container_changed",
          board_id: board.id,
          issue_id: issue.id,
          at_ms: now,
          status_change_id: statusChangeId,
          payload: {
            issue: { ...issue, container: "active", updated_at_ms: now },
            from_container: "backlog",
            to_container: "active",
          },
        },
        // Starting a sprint is user-initiated — `requireCaller` ran in the
        // route, so the Claims are genuinely in scope and `route.caller` is an
        // honest assertion. `null` here would have published every sprint-driven
        // move as `audit.system`.
        ProvenanceFromCaller(input.claims),
      );
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
      yield* emitSecureBoardEvent(
        board.id,
        {
          kind: "issue.updated",
          board_id: board.id,
          issue_id: issue.id,
          at_ms: now,
          payload: { issue: { ...issue, sprint_id: current.id, updated_at_ms: now } },
        },
        null,
      );
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
    const sprint = {
      ...current,
      status: "active" as const,
      started_at_ms: now,
      points_committed_start: pointsCommitted,
    };
    yield* emitSecureBoardEvent(
      board.id,
      {
        kind: "sprint.started",
        board_id: board.id,
        sprint_id: current.id,
        at_ms: now,
        payload: { sprint },
      },
      null,
    );
    return {
      sprint,
      issues_moved: rows.length,
      issues_swept_in: sweptIn,
    };
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
export const completeSprint = (
  input: ActionInput<DeferredBody<typeof CompleteSprintBody.Type>>,
): Effect.Effect<unknown, SprintsFailure, SprintServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const { board } = yield* boardScope(input, callerPubkey(claims), "contributor");
    const current = yield* fetchSprint(board.id, input.params["id"] ?? "");
    if (current.status !== "active") {
      return yield* new ConflictError({ reason: `sprint-${current.status}` });
    }
    // AFTER the board gate, the sprint lookup and the 409 — see DeferredBody.
    // A complete against a planning or completed sprint answers 409, not a 400
    // about a body this handler never got far enough to want. The route builds
    // the parse with its `expected-json` catch, which is what keeps the body
    // optional here: `POST .../complete` with no body at all is the common
    // case, and only that one reason is swallowed — a body that IS present and
    // malformed still 400s.
    const body = yield* input.body;
    const carryOver: "next_planning" | "drop" = body.carryOver ?? "next_planning";
    const requestedNext = body.nextSprintId ?? null;

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
      yield* emitSecureBoardEvent(
        board.id,
        {
          kind: "issue.updated",
          board_id: board.id,
          issue_id: issue.id,
          at_ms: now,
          payload: { issue: { ...issue, sprint_id: carriedTo, updated_at_ms: now } },
        },
        null,
      );
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
    const sprint = {
      ...current,
      status: "completed" as const,
      completed_at_ms: now,
      points_completed: pointsCompleted,
      points_carried: pointsCarried,
    };
    yield* emitSecureBoardEvent(
      board.id,
      {
        kind: "sprint.completed",
        board_id: board.id,
        sprint_id: current.id,
        at_ms: now,
        payload: { sprint },
      },
      null,
    );
    return {
      sprint,
      carried_to_sprint_id: nextSprintId,
      dropped_count: carryOver === "next_planning" && nextSprintId === null
        ? memberRows.filter((r) => !isDoneStatus(boardShape.columns, parseIssueRow(r).status)).length
        : 0,
    };
  });

// ── GET /boards/:slug/sprints/:id/archive ────────────────────────────────
// Snapshot of every issue that was ever in this sprint (from the audit
// trail), grouped by outcome. Works for any sprint status; a
// planning/active sprint shows its members with removed_at_ms=null all
// in the "open" bucket, since they haven't been completed or carried yet.
export const listSprintArchivedIssues = (
  input: PublicActionInput,
): Effect.Effect<unknown, SprintsFailure, SprintServices> =>
  Effect.gen(function* () {
    const pubkey = pubkeyOf(input.claims);
    const { board } = yield* boardScope(input, pubkey, "viewer");
    const current = yield* fetchSprint(board.id, input.params["id"] ?? "");

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

const requestedDays = (query: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const raw = query["days"];
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

export const sprintTide = (
  input: PublicActionInput,
): Effect.Effect<unknown, SprintsFailure, SprintServices> =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, pubkeyOf(input.claims), "viewer");
    const sprint = yield* fetchSprint(board.id, input.params["id"] ?? "");
    const days = yield* requestedDays(input.query);
    const boardShape = yield* fetchBoardShape(board.id);
    const now = yield* Clock.currentTimeMillis;
    const tideInput = yield* loadSprintTideInput(
      sprint.id,
      boardShape.columns,
      sprint.completed_at_ms,
      dayRange(utcDayStart(now), days),
    );
    return yield* tideResponse(
      { board_id: board.id, sprint_id: sprint.id },
      tideInput,
      sprint.created_at_ms,
    );
  });

export const boardTide = (
  input: PublicActionInput,
): Effect.Effect<unknown, SprintsFailure, SprintServices> =>
  Effect.gen(function* () {
    const { board } = yield* boardScope(input, pubkeyOf(input.claims), "viewer");
    const days = yield* requestedDays(input.query);
    const boardShape = yield* fetchBoardShape(board.id);
    const now = yield* Clock.currentTimeMillis;
    const tideInput = yield* loadKanbanTideInput(
      board.id,
      boardShape.columns,
      boardShape.done_window_days,
      dayRange(utcDayStart(now), days),
    );
    return yield* tideResponse(
      { board_id: board.id, sprint_id: null },
      tideInput,
      boardShape.created_at_ms,
    );
  });

// ── attach / detach — the only writers of issueCache.sprint_id ──────────
// Also writes the sprintMembership audit trail: attach inserts a fresh
// open row (added_at_ms=now, removed_at_ms=null); detach stamps the
// existing open row's removed_at_ms. History survives across future
// reassignments of the single-value sprint_id.
//
// EFB-98: THE ROUTE THIS TICKET EXISTS FOR.
//
// These were POST .../sprints/:id/add-issue and .../remove-issue. A caller
// guessing the RESTful spelling — POST .../sprint/:id/issues — got a 404,
// did not check the status, and reported tickets attached that were not.
//
// Now attaching is a POST to the membership COLLECTION and detaching is a
// DELETE on the addressable member, so the method carries the intent and the
// issue id sits where an addressable thing belongs: in the path for DELETE,
// in the body for POST (there is nothing to address until it is attached).
const changeMembership = (
  input: ActionInput<unknown>,
  issueId: Effect.Effect<string, ValidationError>,
  attach: boolean,
  apply: (sprint: SprintShape, issueId: string) => { sprint_id: string | null },
): Effect.Effect<unknown, SprintsFailure, SprintServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const { board } = yield* boardScope(input, callerPubkey(claims), "contributor");
    // AFTER the board gate and BEFORE the sprint lookup, which is where the
    // attach side's parse has always sat — see DeferredBody. On the detach
    // side this is a pure read of the path and cannot fail; keeping both on
    // one line keeps the two spellings in the same place in the order.
    const issue_id = yield* issueId;
    const current = yield* fetchSprint(board.id, input.params["id"] ?? "");
    if (current.status === "completed") {
      return yield* new ConflictError({ reason: "sprint-completed" });
    }

    const db = yield* Db;
    const row = yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ? AND board_id = ?", [
      issue_id,
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
    // EFB-91: null unless the add promoted the issue out of the backlog —
    // the only branch here that appends a statusChangeCache row at all.
    let statusChangeId: string | null = null;
    if (attach) {
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
          statusChangeId = yield* insertStatusChange({
            issue_id: issue.id,
            board_id: board.id,
            actor_pubkey: callerPubkey(claims),
            from_status: null,
            to_status: null,
            from_container: "backlog",
            to_container: "active",
            container_at_completion: null,
            occurred_at_ms: now,
          });
          promotedContainer = "active";
        }
      }
    } else {
      // Stamp only the still-open row for this (sprint, issue). A no-op
      // if there's no open row (issue was already detached or the
      // sprint was created before membership audit existed and the pair
      // never got backfilled — the update just affects zero rows).
      yield* db.execute(
        "UPDATE sprintMembership SET removed_at_ms = ? WHERE sprint_id = ? AND issue_id = ? AND removed_at_ms IS NULL",
        [now, current.id, issue.id],
      );
    }
    const audit = yield* AuditLog;
    yield* audit.record({
      event_type: attach ? "sprint_issue_added" : "sprint_issue_removed",
      actor: claims.login,
      details: { board: board.slug, sprint: current.id, issue: issue.id },
    });
    const updated = {
      ...issue,
      sprint_id,
      container: promotedContainer ?? issue.container,
      updated_at_ms: now,
    };
    yield* emitSecureBoardEvent(
      board.id,
      {
        kind: promotedContainer !== null ? "issue.container_changed" : "issue.updated",
        board_id: board.id,
        issue_id: issue.id,
        at_ms: now,
        // Absent on the plain-update branch, and absence is the correct
        // state there rather than a missing field: nothing was appended to
        // statusChangeCache, so there is no status change to describe.
        ...(statusChangeId === null ? {} : { status_change_id: statusChangeId }),
        payload:
          promotedContainer !== null
            ? { issue: updated, from_container: "backlog", to_container: "active" }
            : { issue: updated },
      },
      // Named only on the branch that publishes a 30553, matching the
      // issues.ts precedent for the same shape. `issue.updated` never reads
      // the actor (only the comment family does), so naming one there would
      // change no bytes while implying this emit attributes something.
      statusChangeId === null ? null : ProvenanceFromCaller(input.claims),
    );
    return { issue: updated };
  });

/**
 * POST /board/:slug/sprint/:id/issues — attach an issue to the sprint.
 *
 * The issue id arrives in the BODY: there is nothing addressable until the
 * membership exists.
 */
export const attachSprintIssue = (
  input: ActionInput<DeferredBody<typeof MembershipBody.Type>>,
): Effect.Effect<unknown, SprintsFailure, SprintServices> =>
  changeMembership(
    input,
    Effect.map(input.body, (body) => body.issue_id),
    true,
    (sprint) => ({ sprint_id: sprint.id }),
  );

/**
 * DELETE /board/:slug/sprint/:id/issue/:issue_id — detach an issue.
 *
 * DELETE addresses the member in the path and carries no body, so only the
 * attach side parses one.
 *
 * Both params are read defensively — `input.params["id"] ?? ""` above and
 * `["issue_id"] ?? ""` here. The handler this came from was registered against
 * TWO paths, and Hono derives parameter types from a single literal, so there
 * was no type that said "whichever of these two matched"; the shared action
 * inherits the same situation, since it is reached from two route
 * registrations whose params differ. An empty id falls through to the same 404
 * a wrong id gets, which is the answer either way.
 */
export const detachSprintIssue = (
  input: ActionInput,
): Effect.Effect<unknown, SprintsFailure, SprintServices> =>
  changeMembership(
    input,
    Effect.succeed(input.params["issue_id"] ?? ""),
    false,
    () => ({ sprint_id: null }),
  );

// ── DELETE /boards/:slug/sprints/:id ─────────────────────────────────────
// Planning sprints only. Clears sprint_id on every member issue, deletes
// membership rows (a planning sprint that never started has no history
// worth keeping), then deletes the sprint. Active/completed sprints must
// be completed first — deleting them would destroy the audit trail that
// velocity and sprint archives depend on.
export const deleteSprint = (
  input: ActionInput,
): Effect.Effect<unknown, SprintsFailure, SprintServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const { board } = yield* boardScope(input, callerPubkey(claims), "contributor");
    const current = yield* fetchSprint(board.id, input.params["id"] ?? "");
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
      yield* emitSecureBoardEvent(
        board.id,
        {
          kind: "issue.updated",
          board_id: board.id,
          issue_id: issue.id,
          at_ms: now,
          payload: { issue: updated },
        },
        null,
      );
    }
    // Emitted after the member issues so a client applies the detachments
    // before the sprint disappears. The board row still exists, so unlike
    // a board delete this tombstone can reach the substrate.
    yield* emitSecureBoardEvent(
      board.id,
      {
        kind: "sprint.deleted",
        board_id: board.id,
        sprint_id: current.id,
        at_ms: now,
        payload: { sprint: current, deleted: true },
      },
      null,
    );
    return { deleted: true, member_count: memberRows.length };
  });
