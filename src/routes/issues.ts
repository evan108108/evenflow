// /api/v0 issues — issue CRUD, status transitions, and container moves
// against issueCache, with every state change mirrored into
// statusChangeCache (the activity-feed source).
//
// Same MVP posture as boards.ts: D1 rows directly, uuid ids, 4a event
// publishing (kind 30551/30553) lands in the event-publisher phase.
//
// Container (icebox/backlog/active) is orthogonal to status and only moves
// through the three dedicated endpoints — PATCH deliberately rejects it.
//
// Auth (phase 16): mounted under /api/v0 AND /api/v0/orgs/:org_slug behind
// optionalAuth. Reads run at "viewer" (anonymous works on public boards);
// writes require a caller at "contributor".

import { Hono } from "hono";
import { path } from "../routes-manifest";
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option, Schema } from "effect";
import { AuditLog, Audience, BoardEmitter, Db, DbError, bootstrap } from "../effects";
import { emitSecureBoardEvent } from "../audiences";
// canonicalizeIdentityRef is gone from this file with EFB-85: every assignee
// now arrives canonical from IdentityRefFromInput, and re-normalizing a value
// the schema already normalized is the invariant-4 anti-pattern.
import { isRosterMember } from "../lib/identity";
import { POSITION_STEP, topOfColumnPosition, topOfContainerPosition } from "../lib/position";
import {
  IdentityRefFromInput,
  ImmutableField,
  NonEmptyString,
  ProvenanceFromCaller,
  QueryString,
  parseRouteBody,
  parseRouteQuery,
  requireAnyOf,
} from "../lib/route-body";
import { QueryValidationError } from "./errors";
import type { AppHonoEnv, LayerFor } from "../http";
import {
  ForbiddenError,
  UnauthorizedError,
  authorizeBoardById,
  callerPubkey,
  callerPubkeyOrNull,
  notVisible,
  requireCaller,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import {
  CONTAINERS,
  parseAttachmentRow,
  parseCommentRow,
  parseIssueRow,
  type BoardShape,
  type Container,
  type IssueShape,
} from "../shapes";
import { insertStatusChange, type StatusChangeWrite } from "../lib/status-change";
import {
  DEFAULT_ISSUE_TYPE,
  ISSUE_TYPES,
  columnById,
  columnByName,
  enabledColumns,
  type Column,
} from "../columns";
import { BODY_FORMATS, isImageContentType } from "../attachments";
import {
  cursorOf,
  cursorPredicate,
  decodeCursor,
  encodeCursor,
  orderByFor,
  type StreamKind,
} from "../issue-cursor";
import { asShortId, derivePrefix, uniquePrefix } from "../slug";

const DEFAULT_LIMIT = 20;
// Cap for ?include=comments — a deeper thread reads via the comments API.
const INCLUDE_COMMENTS_LIMIT = 200;
const MAX_LIMIT = 100;

// Fractional intra-column positioning (phase 18d, Trello-shape). Append =
// max+STEP, insert = neighbor midpoint; when the midpoint degenerates
// (neighbors closer than MIN_GAP, or a neighbor is a positionless legacy
// row) the whole column rebalances to whole STEPs in display order.
// Mirrored at web/src/lib/order.ts — keep the two in lockstep.
//
// EFB-78 moved the constant itself to src/lib/position.ts, which the github
// execute path also needs and which cannot import from a route. Re-exported
// here so existing importers (routes/imports.ts) are untouched.
export { POSITION_STEP };
const MIN_POSITION_GAP = 1e-6;

// How far the duplicate-of cycle walk follows a chain before giving up and
// rejecting (EFB-30). A real chain is one or two links — this is a backstop
// for already-corrupt data, sized so the walk provably terminates rather than
// sized to any expected depth.
const DUPLICATE_CHAIN_MAX_HOPS = 10;

/**
 * EFB-71 — every query param `GET /boards/:slug/issues` accepts.
 *
 * Module scope and pure, per the EFB-54 rule: a schema that needs no Db and no
 * Context is a schema that unit-tests without either. The VALUES are only
 * shape-checked here — `limit`'s ceiling, `container`'s vocabulary,
 * `column_id`'s existence on this board and `after`'s stream agreement are all
 * policy or database questions, and they stay in the handler as named steps
 * where they already were.
 */
const ListIssuesQuery = Schema.Struct({
  status: QueryString,
  container: QueryString,
  assignee: QueryString,
  label: QueryString,
  column_id: QueryString,
  sprint_id: QueryString,
  q: QueryString,
  limit: QueryString,
  after: QueryString,
});

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}

type IssuesFailure =
  | ValidationError
  | QueryValidationError
  | NotFoundError
  | BoardOwnershipError
  | UnauthorizedError
  | ForbiddenError
  | DbError;

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

// ── field validators ──────────────────────────────────────────────────────
//
// EFB-85 emptied most of this section. What survives is the two checks a
// schema structurally cannot make: both need the board's columns, which is
// state `parseRouteBody` has no access to by design. The local `readJsonBody`
// went with them — every body in this file now comes through the one door.

const validateContainer = (v: unknown) =>
  typeof v === "string" && (CONTAINERS as ReadonlyArray<string>).includes(v)
    ? Effect.succeed(v as Container)
    : Effect.fail(new ValidationError({ reason: "container" }));

/** Resolve a status NAME to one of the board's columns (identity + mirror). */
const validateStatus = (columns: ReadonlyArray<Column>, v: unknown) => {
  const column = typeof v === "string" ? columnByName(columns, v) : undefined;
  return column !== undefined
    ? Effect.succeed(column)
    : Effect.fail(new ValidationError({ reason: "status-not-a-column" }));
};

/** Where new issues land when no status is given: first enabled column. */
const defaultColumn = (board: BoardShape): Column | undefined =>
  enabledColumns(board.columns)[0] ?? board.columns[0];

/** The column an issue sits in — column_id is identity, name the fallback. */
const issueColumn = (board: BoardShape, issue: IssueShape): Column | undefined =>
  (issue.column_id === null ? undefined : columnById(board.columns, issue.column_id)) ??
  columnByName(board.columns, issue.status);

/** Done-ness is the column's CATEGORY, never the literal name "Done". */
const inDone = (board: BoardShape, issue: IssueShape): boolean =>
  issueColumn(board, issue)?.category === "done";

// ── EFB-54: PATCH /issues/:id body schema (the reference migration) ───────
//
// The four invariants come from parseRouteBody, not from anything below:
// unknown keys 400, wrong types 400, missing-required 400, canonical output.
// See docs/BOUNDARY_DISCIPLINE.md.
//
// Fields listed as `ImmutableField` are real columns that this route may not
// write. They are declared rather than left to the unknown-key rule so the
// caller is told `sprint_id-immutable` ("real field, wrong endpoint") instead
// of `sprint_id-unknown` ("no such field") — a distinction existing tests pin,
// and the more useful of the two answers. column_id is immutable here on
// purpose: status (name) is the PATCH vocabulary, /transition is the
// column_id-first mover, and position moves only through /reorder, which knows
// the neighbour midpoint math.
const PATCHABLE = [
  "title",
  "body",
  "body_format",
  "type",
  "status",
  "assignee_pubkey",
  "priority",
  "estimate",
  "labels",
  // EFB-98: folded in from POST /issues/:id/duplicate-of. Listed here as well
  // as in the struct, or `{"duplicate_of_issue_id": …}` alone would answer
  // `empty-patch` — a body that says something being told it says nothing.
  "duplicate_of_issue_id",
] as const;

const PatchIssueBody = Schema.Struct({
  title: Schema.optional(
    Schema.String.pipe(Schema.filter((s) => s.trim() !== "")),
  ),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  body_format: Schema.optional(Schema.Literal(...BODY_FORMATS)),
  type: Schema.optional(Schema.Literal(...ISSUE_TYPES)),
  // Deliberately `Unknown`, not `String`. A status is a NAME that has to resolve
  // against THIS board's columns, which is board state the schema cannot see —
  // so the whole check, type included, stays in validateStatus and keeps
  // answering `status-not-a-column`. Splitting it would report `status` for a
  // non-string and `status-not-a-column` for an unknown name: two reasons for
  // one broken field, and a changed error string for a case already tested.
  status: Schema.optional(Schema.Unknown),
  assignee_pubkey: Schema.optional(Schema.NullOr(IdentityRefFromInput)),
  priority: Schema.optional(Schema.NullOr(Schema.Int)),
  estimate: Schema.optional(Schema.NullOr(Schema.Int)),
  labels: Schema.optional(Schema.Array(Schema.String)),
  // EFB-98: was POST /issues/:id/duplicate-of, a verb-shaped route for what is
  // a field on the issue with exactly the same authorization as every other
  // field here (contributor on this board).
  //
  // `NonEmptyString`, carried over from the old route's body: "" is a shape
  // error answering `duplicate_of_issue_id`, not a lookup that misses and
  // answers `duplicate-target-not-found`. Optional here where it was required
  // there, which is the one difference PATCH semantics demand — absent means
  // "leave the link alone", `null` clears it. Everything else about the target
  // (does it exist, is it on THIS board, would it close a cycle) needs the
  // database and so stays in resolveDuplicateTarget as named steps.
  duplicate_of_issue_id: Schema.optional(Schema.NullOr(NonEmptyString)),
  id: ImmutableField,
  board_id: ImmutableField,
  created_at_ms: ImmutableField,
  github_links: ImmutableField,
  container: ImmutableField,
  column_id: ImmutableField,
  completed_at_ms: ImmutableField,
  updated_at_ms: ImmutableField,
  position: ImmutableField,
  sprint_id: ImmutableField,
}).pipe(Schema.filter(requireAnyOf(PATCHABLE)));

/**
 * EFB-85 — POST /boards/:slug/issues, the create body.
 *
 * The PATCH schema's sibling, and deliberately close to it: same field
 * vocabulary, same two deferrals (`status` and the roster half of
 * `assignee_pubkey`), same reason strings. Where the two differ, the
 * difference is create-specific and noted.
 *
 * `title` is REQUIRED here and optional on PATCH, and it carries the trim
 * filter rather than `NonEmptyString`. That is not cosmetic: `Schema.minLength(1)`
 * ACCEPTS `"   "`, while the hand-rolled `validateTitle` this replaces rejected
 * it via `v.trim() !== ""`. Reaching for the obvious primitive would have
 * silently loosened the contract — the same trap EFB-61 hit on comments.
 *
 * Defaults stay in the HANDLER, not in the schema. `Schema.optional` with a
 * default would make the schema answer "what is a new issue" — but two of the
 * six defaults (`status` → the board's first enabled column, `container` →
 * backlog only because the column isn't done) need board state, so a schema
 * that defaulted the other four would split one decision across two files.
 */
const PostIssueBody = Schema.Struct({
  title: Schema.String.pipe(Schema.filter((s) => s.trim() !== "")),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  body_format: Schema.optional(Schema.Literal(...BODY_FORMATS)),
  type: Schema.optional(Schema.Literal(...ISSUE_TYPES)),
  // `Unknown` for the same reason PatchIssueBody uses it: a status is a NAME
  // resolved against THIS board's columns, which the schema cannot see. The
  // whole check stays in validateStatus and keeps answering
  // `status-not-a-column` for a non-string as well as an unknown name.
  status: Schema.optional(Schema.Unknown),
  container: Schema.optional(Schema.Literal(...CONTAINERS)),
  assignee_pubkey: Schema.optional(Schema.NullOr(IdentityRefFromInput)),
  priority: Schema.optional(Schema.NullOr(Schema.Int)),
  estimate: Schema.optional(Schema.NullOr(Schema.Int)),
  labels: Schema.optional(Schema.Array(Schema.String)),
  // Two real fields a client plausibly sends to the WRONG endpoint, declared
  // so they answer `-immutable` ("real field, wrong endpoint") instead of
  // `-unknown` ("no such field"), exactly as PATCH does. A sprint is joined
  // through the sprint's own add-issue endpoint; a column is chosen by
  // `status` on create and moved by /transition afterwards.
  //
  // The purely server-assigned fields — id, short_id, board_id, position,
  // github_links, completed_at_ms, duplicate_of_issue_id — are deliberately
  // NOT listed. They fall to the unknown-key rule, which is the true answer
  // for them: they are not inputs to a create at any endpoint, so there is no
  // "right endpoint" for `-immutable` to point at.
  sprint_id: ImmutableField,
  column_id: ImmutableField,
});

/**
 * POST /issues/:id/transition.
 *
 * Three spellings of one destination, and the precedence between them is
 * behavior this schema must not quietly change:
 *
 *   `column_id` — stable across renames, and the branch the handler takes
 *     whenever the key is PRESENT, including `column_id: null`. It is a
 *     `!== undefined` test, not a truthiness one, so a null there answers
 *     `column_id` rather than falling back to a name. `Schema.String`
 *     reproduces that: null and 3 both fail the field, both report `column_id`.
 *   `to` / `to_status` — the legacy name-match and its pre-phase-17 spelling,
 *     combined in the handler with `??`. Nullish coalescing means `to: null`
 *     falls THROUGH to `to_status`, which is why both stay `Unknown` and the
 *     handler keeps the `??`: pushing either into the schema would decide the
 *     precedence at a different layer than the one that has always decided it.
 *
 * Sending none of the three still reaches `validateStatus(columns, undefined)`
 * and still answers `status-not-a-column` — a required-field rule here would
 * have changed that string, and this is a migration, not a redesign.
 */
const PostTransitionBody = Schema.Struct({
  column_id: Schema.optional(Schema.String),
  to: Schema.optional(Schema.Unknown),
  to_status: Schema.optional(Schema.Unknown),
});

/**
 * POST /issues/:id/move-to-board.
 *
 * Shape is one required non-empty string. Everything that makes the move
 * interesting — is the target the source board, does it exist, is the caller a
 * contributor on it, does it have an enabled column — needs the database and
 * the resolved issue, so it stays in the handler answering `target-is-source`,
 * `target-board`, and `target-columns`.
 *
 * `NonEmptyString` rather than the trim filter, on purpose and unlike `title`:
 * the old guard was `=== ""`, so `"   "` was ACCEPTED and fell through to a
 * board lookup that 404s. Tightening it to a 400 would be a different answer
 * to the same request, which the migration rule says needs its own ticket.
 */
const PostMoveToBoardBody = Schema.Struct({
  target_board_id: NonEmptyString,
});

/**
 * PATCH /issues/:id/reorder.
 *
 * The two visible neighbours around the drop slot. Both optional, both
 * nullable — omitting one is how a drop at a column edge is spelled, and the
 * old handler treated an explicit `null` as the same statement.
 *
 * `Schema.String`, NOT `NonEmptyString`: `""` is currently a well-formed
 * neighbour id that fails the LOOKUP, answering `neighbors`. Under
 * `NonEmptyString` it would answer `before_issue_id` instead — a changed error
 * string, which is the one thing a migration may not do quietly.
 *
 * No `requireAnyOf`: it tests PRESENCE, and `{"before_issue_id": null}` is
 * present-but-empty. The both-null check stays in the handler, where it also
 * covers the explicit-null spelling and keeps answering `neighbors`.
 */
const PatchReorderBody = Schema.Struct({
  before_issue_id: Schema.optional(Schema.NullOr(Schema.String)),
  after_issue_id: Schema.optional(Schema.NullOr(Schema.String)),
});


/**
 * The half of the old `validateAssignee` that a schema cannot do.
 *
 * Canonicalization moved into `IdentityRefFromInput`, so by the time this runs
 * the value is already the one accepted spelling. What remains needs the
 * database and a board id the route resolves after parsing: is this person on
 * THIS board's roster? That is authorization, not shape — EFB-38's second half,
 * kept as a named step rather than smuggled into the schema.
 *
 * EFB-85 made this the ONLY assignee path: the create route used to run its own
 * `validateAssignee`, which did canonicalization and roster in one function.
 * Both routes now split it the same way, which is what makes the roster rule
 * impossible to apply on one endpoint and forget on the other.
 *
 * The EFB-41 note that lived on the deleted helper still holds, and its two
 * halves now live in two places: `npub1…` decodes in `canonicalizeIdentityRef`,
 * so a bech32 assignee is legitimate and a bad-checksum one falls out of
 * `IdentityRefFromInput` as `assignee_pubkey`. A WELL-FORMED npub for somebody
 * who isn't on the board still has to reach `not-a-member` — here — because the
 * shape gate never was what made that safe.
 */
const assertRosterMember = (
  ref: string | null,
  board: BoardShape,
): Effect.Effect<string | null, ValidationError, Db> =>
  Effect.gen(function* () {
    if (ref === null) return null;
    if (!(yield* isRosterMember("boardMemberCache", board.id, ref))) {
      return yield* new ValidationError({ reason: "not-a-member" });
    }
    return ref;
  }).pipe(
    // Same posture as before: a failed roster read is our outage, not the
    // caller's mistake, so it dies as a 500 rather than becoming a 400.
    Effect.catchTag("DbError", (e) => Effect.die(e)),
  );

// ── shared lookups + writes ───────────────────────────────────────────────

/**
 * Fetch an issue plus its board, AND prove the caller holds `minRole` on
 * that board. The ref is either a short id (FLOW-42, case-insensitive) or a
 * UUID — SSE payloads and pre-migration bookmarks still speak UUID.
 *
 * For an AUTHENTICATED caller, a missing issue and an invisible board are
 * both 404 "issue" — existence must not leak; a visible board with an
 * under-role caller is 403. For an ANONYMOUS one, both are 401 instead
 * (EFB-76): this route is reachable without a token so public boards can be
 * read, and answering 404 told tokenless callers "look elsewhere" when the
 * true answer was "send auth". The 401 covers the nonexistent case too, on
 * purpose — see the `notVisible` docs in authz.ts.
 */
const fetchIssue = (ref: string, pubkey: string | null, minRole: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const shortId = asShortId(ref);
    const row =
      shortId === null
        ? yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ?", [ref])
        : yield* db.queryFirst("SELECT * FROM issueCache WHERE short_id = ?", [shortId]);
    if (row === null) return yield* notVisible(pubkey, new NotFoundError({ reason: "issue" }));
    const issue = parseIssueRow(row);
    const { board } = yield* authorizeBoardById(issue.board_id, pubkey, minRole).pipe(
      Effect.mapError((e) =>
        e._tag === "BoardOwnershipError" ? new NotFoundError({ reason: "issue" }) : e,
      ),
    );
    return { issue, board };
  });

// StatusChangeWrite + insertStatusChange moved to src/lib/status-change.ts
// (EFB-56). They were duplicated here and in src/github/execute.ts, and the
// two copies had drifted: this one returned the row id, that one discarded it,
// which is why github-driven transitions never reached the substrate. See that
// file's header for why one writer is the fix rather than two publish calls.

/**
 * Write the status-change audit row and RETURN ITS ID (EFB-33).
 *
 * The id used to be generated inline and thrown away, which is precisely why
 * EFB-24 could not publish a 30553: the substrate event keys on this row (it
 * is the `d` tag), so with the id discarded there was nothing to sign
 * against. Returning it is the whole unlock — callers thread it onto the
 * board event, and the publish path stamps `statusChangeCache` with it.
 */
// (implementation now lives in src/lib/status-change.ts — imported above)

/** completed_at_ms follows the done-category edge: set on arrival, cleared on exit. */
const nextCompletedAt = (
  current: IssueShape,
  wasDone: boolean,
  toDone: boolean,
  now: number,
): number | null => {
  if (toDone && !wasDone) return now;
  if (!toDone) return null;
  return current.completed_at_ms;
};

/**
 * Apply a status change (shared by PATCH and /transition): update the row
 * (column_id identity + status name mirror), maintain completed_at_ms,
 * write the audit row. No-op when unchanged — though a legacy row missing
 * its column_id still writes once, to heal the reference.
 *
 * EFB-33: returns `{ issue, statusChangeId }`, where statusChangeId is NULL
 * whenever no audit row was written. That is a normal outcome, not a fault —
 * this function moves a column whenever the column IDENTITY changes, but only
 * records a status change when the status NAME does. The legacy-heal case in
 * the paragraph above is exactly that: same name, missing column_id, so the
 * row updates and nothing is appended to statusChangeCache. Callers must
 * treat null as "there is no row to publish", never as a missing id.
 */
const applyStatusChange = (
  issue: IssueShape,
  to: Column,
  board: BoardShape,
  actor: string,
): Effect.Effect<{ issue: IssueShape; statusChangeId: string | null }, DbError, Db> =>
  Effect.gen(function* () {
    if (to.id === issue.column_id && to.name === issue.status) {
      return { issue, statusChangeId: null };
    }
    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    const toDone = to.category === "done";
    const completed = nextCompletedAt(issue, inDone(board, issue), toDone, now);
    // EFB-78: an arriving issue goes to the TOP of its new column. Carrying the
    // old position over is what put a just-shipped ticket halfway down Done.
    const position = yield* topOfColumnPosition({
      boardId: issue.board_id,
      columnId: to.id,
      issueId: issue.id,
    });
    yield* db.execute(
      "UPDATE issueCache SET status = ?, column_id = ?, position = ?, updated_at_ms = ?, completed_at_ms = ? WHERE id = ?",
      [to.name, to.id, position, now, completed, issue.id],
    );
    const statusChangeId =
      to.name !== issue.status
        ? yield* insertStatusChange({
            issue_id: issue.id,
            board_id: issue.board_id,
            actor_pubkey: actor,
            from_status: issue.status,
            to_status: to.name,
            from_container: null,
            to_container: null,
            container_at_completion: toDone ? issue.container : null,
            occurred_at_ms: now,
          })
        : null;
    return {
      issue: {
        ...issue,
        status: to.name,
        column_id: to.id,
        position,
        updated_at_ms: now,
        completed_at_ms: completed,
      },
      statusChangeId,
    };
  });

/**
 * Move an issue between containers. Idempotent: same-container is a no-op.
 *
 * EFB-33: same `{ issue, statusChangeId }` shape as applyStatusChange. Here
 * the null case is only the idempotent early return — once past it the insert
 * is unconditional — but the shape is shared so both wrappers read the same
 * way at their call sites.
 */
const applyContainerMove = (
  issue: IssueShape,
  to: Container,
  actor: string,
): Effect.Effect<{ issue: IssueShape; statusChangeId: string | null }, DbError, Db> =>
  Effect.gen(function* () {
    if (to === issue.container) return { issue, statusChangeId: null };
    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    // EFB-78: same rule as a column move — arriving in a container puts you at
    // the top of it, so backlog → active surfaces what was just pulled in.
    const position = yield* topOfContainerPosition({
      boardId: issue.board_id,
      container: to,
      issueId: issue.id,
    });
    yield* db.execute(
      "UPDATE issueCache SET container = ?, position = ?, updated_at_ms = ? WHERE id = ?",
      [to, position, now, issue.id],
    );
    const statusChangeId = yield* insertStatusChange({
      issue_id: issue.id,
      board_id: issue.board_id,
      actor_pubkey: actor,
      from_status: null,
      to_status: null,
      from_container: issue.container,
      to_container: to,
      container_at_completion: null,
      occurred_at_ms: now,
    });
    return { issue: { ...issue, container: to, position, updated_at_ms: now }, statusChangeId };
  });

/**
 * Would pointing `sourceId` at `targetId` close a duplicate-of loop?
 *
 * Walks the target's chain — B, then whatever B duplicates, and so on — and
 * answers true if it reaches the source. Self-reference (A → A) is the
 * zero-hop case and needs no separate test.
 *
 * FAILS CLOSED at DUPLICATE_CHAIN_MAX_HOPS: a chain longer than the cap is
 * reported as circular rather than followed further. The cap is a backstop
 * against already-corrupt data, not a limit anyone should reach, and between
 * "reject a legitimate 11-link chain" and "walk a corrupt ring forever" the
 * first is the cheaper mistake.
 */
const closesDuplicateLoop = (
  sourceId: string,
  targetId: string,
): Effect.Effect<boolean, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    let cursor: string | null = targetId;
    for (let hops = 0; hops < DUPLICATE_CHAIN_MAX_HOPS; hops += 1) {
      if (cursor === null) return false;
      if (cursor === sourceId) return true;
      // Explicitly annotated: `cursor` is assigned from this row, and without
      // the annotation TS reads the generator's yield as depending on `cursor`
      // in turn, and gives up with "implicitly has type any" (TS7022).
      const row: { duplicate_of_issue_id: string | null } | null =
        yield* db.queryFirst<{ duplicate_of_issue_id: string | null }>(
          "SELECT duplicate_of_issue_id FROM issueCache WHERE id = ?",
          [cursor],
        );
      cursor = row === null ? null : row.duplicate_of_issue_id;
    }
    return cursor !== null;
  });

export const makeIssuesRouter = (layerFor: LayerFor = bootstrap) => {
  const issues = new Hono<AppHonoEnv>();

  // The org-scoped mount (/api/v0/orgs/:org_slug) contributes org_slug via
  // the mount prefix — Hono exposes it at runtime, but the per-route typed
  // param() only knows keys from the route literal itself.
  const orgSlugOf = (c: Context<AppHonoEnv>): string | undefined =>
    (c.req.param() as Record<string, string | undefined>)["org_slug"];

  const runJson = async (
    c: Context<AppHonoEnv>,
    program: Effect.Effect<unknown, IssuesFailure, Db | AuditLog | BoardEmitter | Audience>,
    okStatus: 200 | 201 = 200,
  ) => {
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, okStatus);
  };

  // ── POST /boards/:slug/issues — create ──────────────────────────────────
  issues.post(path("issue.create"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const { board } = yield* resolveBoardScope(
        { org_slug: orgSlugOf(c), slug: c.req.param("slug") },
        pubkey,
        "contributor",
      );
      // EFB-85. Ten hand-rolled field checks became PostIssueBody; what they
      // never did — reject a key we don't recognize — comes free. A create
      // carrying `assignee` or `sprint_id` used to return 201 with the field
      // dropped on the floor, which is EFB-53's bug wearing a different verb.
      const body = yield* parseRouteBody(c, PostIssueBody);

      const title = body.title;
      const issueBody = body.body ?? null;
      const body_format = body.body_format ?? "markdown";
      const type = body.type ?? DEFAULT_ISSUE_TYPE;
      // status and assignee are the two the schema deliberately does not
      // finish — which columns this board has, and who is on its roster, are
      // both board state. Same split as PATCH.
      const column =
        body.status === undefined
          ? defaultColumn(board)
          : yield* validateStatus(board.columns, body.status);
      if (column === undefined) return yield* new ValidationError({ reason: "status-not-a-column" });
      const container = body.container ?? "backlog";
      const assignee =
        body.assignee_pubkey === undefined
          ? null
          : yield* assertRosterMember(body.assignee_pubkey, board);
      const priority = body.priority ?? null;
      const estimate = body.estimate ?? null;
      const labels = body.labels === undefined ? [] : [...body.labels];

      const db = yield* Db;
      const audit = yield* AuditLog;

      // Board prefix: POST /boards always sets one; boards that predate
      // migration 0003's backfill self-heal on first issue create.
      let prefix = board.issue_prefix;
      if (prefix === null) {
        const taken = yield* db.queryAll<{ issue_prefix: string }>(
          "SELECT issue_prefix FROM boardCache WHERE issue_prefix IS NOT NULL",
        );
        prefix = uniquePrefix(derivePrefix(board.title), new Set(taken.map((r) => r.issue_prefix)));
        yield* db.execute(
          "UPDATE boardCache SET issue_prefix = ? WHERE id = ? AND issue_prefix IS NULL",
          [prefix, board.id],
        );
      }
      // Atomic claim — a single UPDATE ... RETURNING is D1's concurrency
      // primitive here, so racing creates can never read the same number.
      const claimed = yield* db.queryFirst<{ n: number }>(
        "UPDATE boardCache SET next_issue_number = next_issue_number + 1 WHERE id = ? RETURNING next_issue_number - 1 AS n",
        [board.id],
      );
      if (claimed === null) return yield* new NotFoundError({ reason: "board" });
      const short_id = `${prefix}-${claimed.n}`;

      const now = yield* Clock.currentTimeMillis;
      const id = crypto.randomUUID();
      const createdDone = column.category === "done";
      // New issues land at the end of the positioned order. Board-wide max
      // keeps it one query; within any single column the row is still last.
      const maxPos = yield* db.queryFirst<{ m: number | null }>(
        "SELECT MAX(position) AS m FROM issueCache WHERE board_id = ?",
        [board.id],
      );
      const position = (maxPos?.m ?? 0) + POSITION_STEP;
      const issue: IssueShape = {
        id,
        short_id,
        board_id: board.id,
        title,
        body: issueBody,
        body_format,
        type,
        status: column.name,
        column_id: column.id,
        container,
        assignee_pubkey: assignee,
        priority,
        estimate,
        labels,
        github_links: [],
        position,
        sprint_id: null,
        // Phase 21: a new issue has no PR yet, so no pill.
        external_state: null,
        external_state_updated_at_ms: null,
        created_at_ms: now,
        updated_at_ms: now,
        completed_at_ms: createdDone ? now : null,
        // Publish is fired off the request path (EFB-24), so it has not
        // landed yet at response time. Stamped later, if at all.
        substrate_event_id: null,
        // Nothing is born a duplicate — the mark is always a later judgement
        // (EFB-30), through POST /issues/:id/duplicate-of.
        duplicate_of_issue_id: null,
      };
      yield* db.execute(
        "INSERT INTO issueCache (id, short_id, board_id, title, body, body_format, type, status, column_id, container, assignee_pubkey, priority, estimate, labels, github_links, position, created_at_ms, updated_at_ms, completed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          short_id,
          board.id,
          title,
          issueBody,
          body_format,
          type,
          column.name,
          column.id,
          container,
          assignee,
          priority,
          estimate,
          JSON.stringify(labels),
          "[]",
          position,
          now,
          now,
          issue.completed_at_ms,
        ],
      );
      // EFB-56: keep the id. Creation writes a real null → first-column status
      // row, but this call used to discard what it returned, so `issue.created`
      // referenced nothing and the publish path had no 30553 to fan out. The
      // substrate's audit trail therefore began at an issue's FIRST TRANSITION
      // rather than at its creation — the one status change every issue has was
      // the one never published.
      const statusChangeId = yield* insertStatusChange({
        issue_id: id,
        board_id: board.id,
        actor_pubkey: pubkey,
        from_status: null,
        to_status: column.name,
        from_container: null,
        to_container: container,
        container_at_completion: createdDone ? container : null,
        occurred_at_ms: now,
      });
      yield* audit.record({
        event_type: "issue_created",
        actor: claims.login,
        details: { board: board.slug, issue: id },
      });
      // `route.caller` (EFB-63): the pubkey the statusChangeCache row above was
      // written with is `callerPubkey(claims)`, so the 30553's actor_pubkey is
      // byte-identical to the pre-EFB-63 build — but the source now names the
      // role instead of defaulting to `audit.system`, and it is constructed
      // HERE, where the Claims that make the claim provable are in scope.
      yield* emitSecureBoardEvent(
        board.id,
        {
          kind: "issue.created",
          board_id: board.id,
          issue_id: id,
          // Top level, matching `issue.transitioned` post-EFB-33 — a private
          // board's payload arrives encrypted, so anything the publish path must
          // read has to live on the envelope.
          status_change_id: statusChangeId,
          at_ms: now,
          // The status fields ride the payload for the same reason they do on a
          // transition: nothing in the issue row records who acted, and
          // `buildKanbanStatusChange` needs the from/to pair. Additive keys — SSE
          // consumers that only read `issue` are unaffected.
          //
          // `actor_pubkey` stays for those SSE consumers. The publisher no
          // longer reads it — it takes the Provenance below — so this key is
          // now envelope-only (EFB-63).
          payload: {
            issue,
            actor_pubkey: pubkey,
            from_status: null,
            to_status: column.name,
            from_container: null,
            to_container: container,
          },
        },
        ProvenanceFromCaller(claims),
      );
      return { issue };
    });
    return runJson(c, program, 201);
  });

  // ── GET /boards/:slug/issues — list with composable filters + keyset ────
  //
  // EFB-71 reference route. Before the migration this read seven params by
  // name and never looked at the eighth, so `?status_id=<uuid>` — a field that
  // does not exist, mistaken for the real `column_id` — returned 200 and the
  // unfiltered list. The caller's wrong belief about the API was confirmed by
  // a successful response.
  issues.get(path("issue.list"), async (c) => {
    const program = Effect.gen(function* () {
      // The accepted key set, and therefore the whole of the fix: anything not
      // named here is a 400 that names it. Phase 22 wired column_id (one
      // Kanban column's paged stream) plus sprint_id and q for a later
      // filter-chip UI.
      const q = yield* parseRouteQuery(c, ListIssuesQuery);
      const limitRaw = q.limit;
      const after = q.after;

      const { board } = yield* resolveBoardScope(
        { org_slug: orgSlugOf(c), slug: c.req.param("slug") },
        callerPubkeyOrNull(c.get("claims")),
        "viewer",
      );

      let limit = DEFAULT_LIMIT;
      if (limitRaw !== undefined) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n < 1) return yield* new ValidationError({ reason: "limit" });
        limit = Math.min(n, MAX_LIMIT);
      }

      // Filters COMPOSE since phase 22. The old one-filter-at-a-time guard
      // made the feature impossible: a paged kanban column is inherently
      // container=active AND column_id=X, which that rule rejected.
      const filterParts: string[] = [];
      const filterParams: unknown[] = [];
      if (q.status !== undefined) {
        filterParts.push(" AND status = ?");
        filterParams.push(q.status);
      }
      if (q.container !== undefined) {
        yield* validateContainer(q.container);
        filterParts.push(" AND container = ?");
        filterParams.push(q.container);
      }
      if (q.assignee !== undefined) {
        filterParts.push(" AND assignee_pubkey = ?");
        filterParams.push(q.assignee);
      }
      if (q.label !== undefined) {
        filterParts.push(
          " AND EXISTS (SELECT 1 FROM json_each(issueCache.labels) WHERE json_each.value = ?)",
        );
        filterParams.push(q.label);
      }
      if (q.sprint_id !== undefined) {
        filterParts.push(" AND sprint_id = ?");
        filterParams.push(q.sprint_id);
      }
      if (q.q !== undefined && q.q.trim() !== "") {
        // Substring over title/body. Deliberately LIKE, not FTS: there is
        // no FTS table on issueCache, and adding one is its own phase.
        filterParts.push(" AND (title LIKE ? ESCAPE '\\' OR COALESCE(body, '') LIKE ? ESCAPE '\\')");
        const needle = `%${q.q.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        filterParams.push(needle, needle);
      }
      if (q.column_id !== undefined) {
        // Legacy rows awaiting the 0005 backfill carry column_id IS NULL and
        // are addressed by their status-name mirror, so a column's stream
        // must claim them too or they vanish from the board entirely.
        const col = columnById(board.columns, q.column_id);
        if (col === undefined) return yield* new ValidationError({ reason: "column_id" });
        filterParts.push(" AND (column_id = ? OR (column_id IS NULL AND status = ?))");
        filterParams.push(q.column_id, col.name);
      }
      const filterSql = filterParts.join("");

      // A column stream is ordered by fractional position; the side-lists
      // page by recency. See src/issue-cursor.ts for why the position key
      // is a tuple and why the cursor is encoded rather than an issue id.
      const streamKind: StreamKind = q.column_id !== undefined ? "position" : "recency";

      const db = yield* Db;
      let cursorSql = "";
      let cursorParams: unknown[] = [];
      if (after !== undefined) {
        const decoded = decodeCursor(after);
        if (decoded !== null) {
          if (decoded.kind !== streamKind) {
            return yield* new ValidationError({ reason: "after-stream-mismatch" });
          }
          const pred = cursorPredicate(decoded);
          cursorSql = pred.sql;
          cursorParams = pred.params;
        } else {
          // Back-compat: pre-22 clients passed a bare issue id on the
          // recency stream. Keep honouring it; a moved/deleted anchor is
          // exactly why the encoded form exists, so it is not offered for
          // the position stream.
          if (streamKind !== "recency") {
            return yield* new ValidationError({ reason: "after" });
          }
          const anchor = yield* db.queryFirst<Record<string, unknown>>(
            "SELECT * FROM issueCache WHERE board_id = ? AND id = ?",
            [board.id, after],
          );
          if (anchor === null) return yield* new ValidationError({ reason: "after" });
          cursorSql = " AND (updated_at_ms < ? OR (updated_at_ms = ? AND id < ?))";
          cursorParams = [anchor["updated_at_ms"], anchor["updated_at_ms"], after];
        }
      }

      // limit+1 probe answers has_more without a second count query.
      const rows = yield* db.queryAll(
        `SELECT * FROM issueCache WHERE board_id = ?${filterSql}${cursorSql} ${orderByFor(streamKind)} LIMIT ?`,
        [board.id, ...filterParams, ...cursorParams, limit + 1],
      );
      const count = yield* db.queryFirst<{ n: number }>(
        `SELECT COUNT(*) AS n FROM issueCache WHERE board_id = ?${filterSql}`,
        [board.id, ...filterParams],
      );

      // Cover enrichment for the kanban cards: one image-typed cover per
      // issue (partial unique index), merged in code — same no-JOIN posture
      // as the feed's title enrichment.
      const issues = rows.slice(0, limit).map(parseIssueRow);
      const covers = new Map<string, string>();
      if (issues.length > 0) {
        const placeholders = issues.map(() => "?").join(", ");
        const coverRows = yield* db.queryAll<{ issue_id: string; blob_url: string; content_type: string }>(
          `SELECT issue_id, blob_url, content_type FROM issueAttachmentCache WHERE is_cover = 1 AND deleted_at_ms IS NULL AND issue_id IN (${placeholders})`,
          issues.map((i) => i.id),
        );
        for (const cover of coverRows) {
          if (isImageContentType(cover.content_type)) covers.set(cover.issue_id, cover.blob_url);
        }
      }

      // next_after freezes the sort key of the last row WE RETURN (not the
      // limit+1 probe row), so the following page resumes exactly here.
      const hasMore = rows.length > limit;
      const last = issues.at(-1);
      return {
        issues: issues.map((i) => ({ ...i, cover_url: covers.get(i.id) ?? null })),
        total: count?.n ?? 0,
        has_more: hasMore,
        next_after: hasMore && last !== undefined ? encodeCursor(cursorOf(streamKind, last)) : null,
      };
    });
    return runJson(c, program);
  });

  // ── GET /issues/:id ─────────────────────────────────────────────────────
  // ?include=comments,attachments expands the response in one round-trip —
  // the shape MCP's kanban_issue_get always requests (phase 19).
  issues.get(path("issue.get"), async (c) => {
    const include = new Set(
      (c.req.query("include") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    );
    const program = Effect.gen(function* () {
      const { issue } = yield* fetchIssue(
        c.req.param("id"),
        callerPubkeyOrNull(c.get("claims")),
        "viewer",
      );
      const unknown = [...include].filter((k) => k !== "comments" && k !== "attachments");
      if (unknown.length > 0) return yield* new ValidationError({ reason: "include" });
      const db = yield* Db;
      const extras: Record<string, unknown> = {};
      if (include.has("comments")) {
        const rows = yield* db.queryAll(
          "SELECT * FROM commentCache WHERE issue_id = ? ORDER BY created_at_ms ASC, id ASC LIMIT ?",
          [issue.id, INCLUDE_COMMENTS_LIMIT],
        );
        extras["comments"] = rows.map(parseCommentRow);
      }
      if (include.has("attachments")) {
        const rows = yield* db.queryAll(
          "SELECT * FROM issueAttachmentCache WHERE issue_id = ? AND deleted_at_ms IS NULL ORDER BY uploaded_at_ms ASC",
          [issue.id],
        );
        extras["attachments"] = rows.map(parseAttachmentRow);
      }
      return { issue, ...extras };
    });
    return runJson(c, program);
  });

  // ── PATCH /issues/:id — partial update (container excluded) ─────────────
  issues.patch(path("issue.update"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      // EFB-54 reference route. Everything the old hand-rolled preamble did —
      // the immutable-key loop, the empty-patch guard, and eight per-field
      // validators — is now PatchIssueBody, and the thing it never did (reject
      // a key we don't recognize) comes free with it. That omission was EFB-53:
      // `{"assignee": "..."}` returned 200 and assigned nobody.
      const body = yield* parseRouteBody(c, PatchIssueBody);

      const { issue: current, board } = yield* fetchIssue(c.req.param("id"), pubkey, "contributor");
      const db = yield* Db;

      const title = body.title ?? current.title;
      const issueBody = body.body === undefined ? current.body : body.body;
      const body_format = body.body_format ?? current.body_format;
      const type = body.type ?? current.type;
      // status, assignee and duplicate_of are the fields the schema
      // deliberately does NOT finish. All three need board state the schema
      // cannot see: which columns this board has, who is on its roster, and
      // which issues live on it. Shape is settled above; these are
      // authorization and lookup, so they stay here, named.
      const duplicateOf =
        body.duplicate_of_issue_id === undefined
          ? current.duplicate_of_issue_id
          : body.duplicate_of_issue_id === null
            ? null
            : yield* resolveDuplicateTarget(current, body.duplicate_of_issue_id);
      // Newly pointing at a target, as opposed to clearing it or leaving an
      // existing pointer alone. Only this case carries the move-to-Done.
      const marksDuplicate =
        duplicateOf !== null && duplicateOf !== current.duplicate_of_issue_id;
      // Marking a duplicate moves the issue to Done — that was the old route's
      // behavior and it survives the fold. An explicit `status` in the same
      // request wins, because the caller said what they wanted. A board with no
      // enabled done column records the pointer and leaves the column alone
      // rather than inventing a destination.
      const doneColumn = enabledColumns(board.columns).find((col) => col.category === "done");
      const toColumn =
        body.status !== undefined
          ? yield* validateStatus(board.columns, body.status)
          : marksDuplicate && doneColumn !== undefined
            ? doneColumn
            : issueColumn(board, current);
      const status = toColumn?.name ?? current.status;
      const column_id = toColumn?.id ?? current.column_id;
      const assignee =
        body.assignee_pubkey === undefined
          ? current.assignee_pubkey
          : yield* assertRosterMember(body.assignee_pubkey, board);
      const priority = body.priority === undefined ? current.priority : body.priority;
      const estimate = body.estimate === undefined ? current.estimate : body.estimate;
      const labels = body.labels === undefined ? current.labels : [...body.labels];

      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      const toDone = toColumn?.category === "done";
      const completed =
        status === current.status
          ? current.completed_at_ms
          : nextCompletedAt(current, inDone(board, current), toDone, now);
      // Estimate changes are audited (EFB-22): issueCache.estimate holds only
      // the current value, so without this row a re-estimate would silently
      // redraw every earlier day of the sprint tide at the new number.
      //
      // Ordered BEFORE the UPDATE on purpose. There's no transaction here, so
      // one of the two can land alone, and the two failure modes are not
      // equally bad:
      //
      //   update-then-insert, insert fails → estimate moved with no audit row,
      //     so every earlier day replays at the NEW number. That is precisely
      //     the corruption this table exists to prevent.
      //   insert-then-update, update fails → an audit row for a change that
      //     didn't happen. Harmless to the replay: estimateAt() reads
      //     prev_estimate before the row's instant and the unchanged current
      //     value after it, and both still equal the truth.
      //
      // Not hypothetical — it happened in prod when this code deployed ahead
      // of migration 0021 and every estimate PATCH half-wrote.
      if (estimate !== current.estimate) {
        yield* db.execute(
          "INSERT INTO issueEstimateHistory (id, issue_id, occurred_at_ms, prev_estimate, next_estimate, actor_pubkey) VALUES (?, ?, ?, ?, ?, ?)",
          [crypto.randomUUID(), current.id, now, current.estimate, estimate, pubkey],
        );
      }
      yield* db.execute(
        "UPDATE issueCache SET title = ?, body = ?, body_format = ?, type = ?, status = ?, column_id = ?, assignee_pubkey = ?, priority = ?, estimate = ?, labels = ?, duplicate_of_issue_id = ?, updated_at_ms = ?, completed_at_ms = ? WHERE id = ?",
        [title, issueBody, body_format, type, status, column_id, assignee, priority, estimate, JSON.stringify(labels), duplicateOf, now, completed, current.id],
      );
      const statusChangeId =
        status === current.status
          ? null
          : yield* insertStatusChange({
              issue_id: current.id,
              board_id: current.board_id,
              actor_pubkey: pubkey,
              from_status: current.status,
              to_status: status,
              from_container: null,
              to_container: null,
              container_at_completion: toDone ? current.container : null,
              occurred_at_ms: now,
            });
      yield* audit.record({
        event_type: "issue_updated",
        actor: claims.login,
        details: { issue: current.id },
      });
      // The duplicate link keeps its own audit events across the fold, so
      // existing audit queries for marking and clearing still resolve.
      if (duplicateOf !== current.duplicate_of_issue_id) {
        yield* audit.record(
          duplicateOf === null
            ? {
                event_type: "issue_duplicate_cleared",
                actor: claims.login,
                details: { issue: current.id, was_duplicate_of: current.duplicate_of_issue_id },
              }
            : {
                event_type: "issue_marked_duplicate",
                actor: claims.login,
                details: { issue: current.id, duplicate_of: duplicateOf },
              },
        );
      }
      const issue: IssueShape = {
        ...current,
        title,
        body: issueBody,
        body_format,
        type,
        status,
        column_id,
        assignee_pubkey: assignee,
        priority,
        estimate,
        labels,
        duplicate_of_issue_id: duplicateOf,
        updated_at_ms: now,
        completed_at_ms: completed,
      };
      // A column move publishes issue.transitioned, carrying the status change
      // id and the actor, so the 30553 goes out alongside the 30551; anything
      // else publishes issue.updated.
      //
      // EFB-98 unified this. The old duplicate-of route did exactly the above,
      // while PATCH published issue.updated for EVERY edit including a status
      // change — so it wrote a statusChangeCache row and then never published
      // the 30553 that row exists to accompany. Folding the routes together
      // without unifying the publish would have silently dropped the duplicate
      // route's 30553; unifying it also closes that gap on plain status edits.
      //
      // Provenance tracks the same branch: a move needs its actor, an in-place
      // edit publishes only the 30551, which has no actor slot to fill. The
      // issue's `assignee_pubkey` is a REFERENCE — who owns the work, not who
      // made this edit — and BOUNDARY_DISCIPLINE scopes Provenance to actors.
      const moved = status !== current.status || column_id !== current.column_id;
      yield* emitSecureBoardEvent(
        current.board_id,
        {
          kind: moved ? "issue.transitioned" : "issue.updated",
          board_id: current.board_id,
          issue_id: current.id,
          at_ms: now,
          ...(statusChangeId === null ? {} : { status_change_id: statusChangeId }),
          payload: moved
            ? {
                issue,
                actor_pubkey: pubkey,
                from_status: current.status,
                to_status: status,
              }
            : { issue },
        },
        moved ? ProvenanceFromCaller(claims) : null,
      );
      return { issue };
    });
    return runJson(c, program);
  });

  // ── DELETE /issues/:id — cascades comments in code; audit rows stay ─────
  issues.delete(path("issue.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { issue } = yield* fetchIssue(c.req.param("id"), callerPubkey(claims), "contributor");
      const db = yield* Db;
      const audit = yield* AuditLog;
      yield* db.execute("DELETE FROM commentCache WHERE issue_id = ?", [issue.id]);
      yield* db.execute("DELETE FROM issueCache WHERE id = ?", [issue.id]);
      yield* audit.record({
        event_type: "issue_deleted",
        actor: claims.login,
        details: { issue: issue.id },
      });
      const now = yield* Clock.currentTimeMillis;
      // `null`, though a caller is in scope: the 30551 tombstone attributes
      // nothing. Same reasoning as the comment tombstone — buildKanbanIssue has
      // no actor slot to fill, so naming the deleter here would have nowhere
      // honest to go.
      yield* emitSecureBoardEvent(
        issue.board_id,
        {
          kind: "issue.deleted",
          board_id: issue.board_id,
          issue_id: issue.id,
          at_ms: now,
          payload: { issue_id: issue.id },
        },
        null,
      );
      return { deleted: true };
    });
    return runJson(c, program);
  });

  // ── POST /issues/:id/transition — the drag-drop endpoint ────────────────
  // column_id is the preferred addressing (stable across renames); `to` is
  // the legacy name-match, with `to_status` still accepted as its pre-17
  // spelling. When both arrive, column_id wins.
  issues.post(path("issue.transition"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const body = yield* parseRouteBody(c, PostTransitionBody);
      const { issue, board } = yield* fetchIssue(c.req.param("id"), pubkey, "contributor");
      let to: Column;
      if (body.column_id !== undefined) {
        // Still `!== undefined` and not a truthiness test: the schema now
        // rejects a null before this runs, but the branch has to keep meaning
        // "the caller addressed a column", so that an id which is well-formed
        // and simply not on THIS board answers `column_id` rather than
        // silently falling back to the legacy name-match.
        const target = columnById(board.columns, body.column_id);
        if (target === undefined) return yield* new ValidationError({ reason: "column_id" });
        to = target;
      } else {
        // `??`, preserved exactly: `to: null` falls through to `to_status`.
        to = yield* validateStatus(board.columns, body.to ?? body.to_status);
      }
      const { issue: updated, statusChangeId } = yield* applyStatusChange(
        issue,
        to,
        board,
        pubkey,
      );
      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "issue_transitioned",
        actor: claims.login,
        details: { issue: issue.id, to_status: to.name },
      });
      if (updated.status !== issue.status || updated.column_id !== issue.column_id) {
        // status_change_id is undefined for a column-only move: the column
        // identity changed but the status NAME did not, so no statusChangeCache
        // row was written. The issue event still carries the new state; there is
        // simply no 30553 to publish. See applyStatusChange.
        yield* emitSecureBoardEvent(
          issue.board_id,
          {
            kind: "issue.transitioned",
            board_id: issue.board_id,
            issue_id: issue.id,
            at_ms: updated.updated_at_ms,
            ...(statusChangeId === null ? {} : { status_change_id: statusChangeId }),
            // actor_pubkey is WHO MOVED THE CARD, which is not recoverable from
            // the issue: assignee_pubkey is who owns the work, a different
            // person most of the time. Kept for SSE consumers; the publisher
            // reads the Provenance argument instead (EFB-63).
            payload: {
              issue: updated,
              actor_pubkey: pubkey,
              from_status: issue.status,
              to_status: to.name,
            },
          },
          ProvenanceFromCaller(claims),
        );
      }
      return { issue: updated };
    });
    return runJson(c, program);
  });

  // ── POST /issues/:id/duplicate-of — mark (or un-mark) a duplicate ───────
  //
  // The preserve-with-pointer half of EFB-26's delete. Deleting a duplicate
  // works, but it discards the reason the duplicate was worth noticing:
  // somebody filed this twice, and the second filing usually carries context
  // the first one didn't. So the row stays, points at the original, and moves
  // to Done — Linear's model, picked over Jira's delete-and-redirect.
  //
  // A DEDICATED ENDPOINT, not a PATCH field. Two reasons. Convention:
  // /transition and /move-to-board already own the state changes that are
  // more than a field write, and this is one — it transitions a column and
  // appends an audit row as a side effect. Coordination: EFB-54 is rewriting
  // the PATCH handler in parallel flight, and a field added there would
  // collide with that work for no benefit.
  //
  // THE INVARIANT, since it is easy to get backwards: the audit trail is
  // append-only, the state is revertible. Un-marking clears the pointer and
  // does NOT move the issue back out of Done. The transition to Done really
  // happened; unwinding it would put a lie in statusChangeCache, and every
  // tide day already replayed with the issue excluded. Linear behaves the
  // same way, for the same reason.
  /**
   * Resolve a duplicate-of reference to a target issue id on THIS board.
   *
   * EFB-98 folded POST /issues/:id/duplicate-of into PATCH /issue/:id. The
   * pointer is a field with the same authorization as every other field, so a
   * dedicated route only bought it a verb in the URL. What was genuinely
   * unique to that route is right here — everything else it did (write the
   * row, transition to Done, audit, publish) PATCH already did, and now does
   * once for both.
   */
  const resolveDuplicateTarget = (current: IssueShape, ref: string) =>
    Effect.gen(function* () {
      const db = yield* Db;
      // Same addressing as fetchIssue (short id or UUID) so the API accepts
      // whatever a caller has in hand, but deliberately NOT fetchIssue itself:
      // that authorizes the target's board, and the target is constrained to
      // THIS board anyway. Short ids are per-board vocabulary (PUT
      // /issue/:id/board mints a fresh one), so a cross-board pointer could not
      // render as "→ EFB-7" without lying about which board's #7.
      const shortId = asShortId(ref);
      const row =
        shortId === null
          ? yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ?", [ref])
          : yield* db.queryFirst("SELECT * FROM issueCache WHERE short_id = ?", [shortId]);
      if (row === null) {
        return yield* new ValidationError({ reason: "duplicate-target-not-found" });
      }
      const target = parseIssueRow(row);
      if (target.board_id !== current.board_id) {
        return yield* new ValidationError({ reason: "duplicate-target-other-board" });
      }
      if (yield* closesDuplicateLoop(current.id, target.id)) {
        return yield* new ValidationError({ reason: "circular_duplicate" });
      }
      return target.id;
    });

  // ── PUT /issue/:id/board — cross-board move ─────────────────────────────
  // Contributor on BOTH boards. The issue keeps its container but gets a
  // fresh short_id minted in the target's prefix (links to the old id keep
  // resolving nowhere — short ids are per-board vocabulary), lands in the
  // same-named enabled column when the target has one, else the first
  // enabled todo-category column, else the first enabled column. Sprint
  // assignment is per-board, so it resets.
  issues.put(path("issue.board.set"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      // Parsed BEFORE the issue is fetched, holding the old order: a malformed
      // body on an issue that doesn't exist is a 400 about the body, not a 404
      // about the issue.
      const { target_board_id } = yield* parseRouteBody(c, PostMoveToBoardBody);
      const { issue, board: source } = yield* fetchIssue(c.req.param("id"), pubkey, "contributor");
      if (target_board_id === source.id) {
        return yield* new ValidationError({ reason: "target-is-source" });
      }
      const { board: target } = yield* authorizeBoardById(
        target_board_id,
        pubkey,
        "contributor",
      ).pipe(
        Effect.mapError((e) =>
          e._tag === "BoardOwnershipError" ? new NotFoundError({ reason: "target-board" }) : e,
        ),
      );

      const enabled = enabledColumns(target.columns);
      if (enabled.length === 0) return yield* new ValidationError({ reason: "target-columns" });
      const sameName = columnByName(target.columns, issue.status);
      const column =
        (sameName !== undefined && sameName.enabled ? sameName : undefined) ??
        enabled.find((col) => col.category === "todo") ??
        enabled[0]!;

      const db = yield* Db;
      // Re-mint in the target's prefix — deriving one first for legacy
      // boards that predate 0003, exactly like the create path.
      let prefix = target.issue_prefix;
      if (prefix === null) {
        const taken = yield* db.queryAll<{ issue_prefix: string }>(
          "SELECT issue_prefix FROM boardCache WHERE issue_prefix IS NOT NULL",
        );
        prefix = uniquePrefix(derivePrefix(target.title), new Set(taken.map((r) => r.issue_prefix)));
        yield* db.execute(
          "UPDATE boardCache SET issue_prefix = ? WHERE id = ? AND issue_prefix IS NULL",
          [prefix, target.id],
        );
      }
      const claimed = yield* db.queryFirst<{ n: number }>(
        "UPDATE boardCache SET next_issue_number = next_issue_number + 1 WHERE id = ? RETURNING next_issue_number - 1 AS n",
        [target.id],
      );
      if (claimed === null) return yield* new NotFoundError({ reason: "target-board" });
      const short_id = `${prefix}-${claimed.n}`;

      const maxPos = yield* db.queryFirst<{ m: number | null }>(
        "SELECT MAX(position) AS m FROM issueCache WHERE board_id = ?",
        [target.id],
      );
      const position = (maxPos?.m ?? 0) + POSITION_STEP;
      const now = yield* Clock.currentTimeMillis;
      // duplicate_of_issue_id resets with sprint_id, and for the same reason:
      // both are per-board vocabulary (EFB-30). The pointer is constrained to
      // same-board targets so the card can render "→ EFB-7"; carried across,
      // it would point at an issue on the OLD board while the badge spelled it
      // in the NEW board's numbering — a reference to a ticket that isn't the
      // one named. Issues on the source board still pointing AT this one are
      // left dangling, which is the documented soft-pointer posture (see
      // migration 0024) and matches what DELETE already leaves behind.
      yield* db.execute(
        "UPDATE issueCache SET board_id = ?, short_id = ?, column_id = ?, status = ?, sprint_id = NULL, duplicate_of_issue_id = NULL, position = ?, updated_at_ms = ? WHERE id = ?",
        [target.id, short_id, column.id, column.name, position, now, issue.id],
      );
      const moved = {
        ...issue,
        board_id: target.id,
        short_id,
        column_id: column.id,
        status: column.name,
        sprint_id: null,
        duplicate_of_issue_id: null,
        position,
        updated_at_ms: now,
      };
      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "issue_moved_to_board",
        actor: claims.login,
        details: { issue: issue.id, from_board: source.id, to_board: target.id, short_id },
      });
      // Both streams: the source board sees the card leave, the target sees
      // it arrive.
      yield* emitSecureBoardEvent(
        source.id,
        {
          kind: "issue.updated",
          board_id: source.id,
          issue_id: issue.id,
          at_ms: now,
          payload: { issue_id: issue.id, moved_to_board: target.id },
        },
        null,
      );
      yield* emitSecureBoardEvent(
        target.id,
        {
          kind: "issue.updated",
          board_id: target.id,
          issue_id: issue.id,
          at_ms: now,
          payload: { issue: moved },
        },
        null,
      );
      return { issue: moved };
    });
    return runJson(c, program);
  });

  // ── PATCH /issues/:id/reorder — intra-column fractional positioning ─────
  // Body: { before_issue_id?, after_issue_id? } — the visible neighbors
  // around the drop slot (before = the card above, after = the card below;
  // omit one at the column's edges). The server computes the midpoint; when
  // the gap has degraded, or a legacy NULL-position row is involved, the
  // whole column rebalances to whole POSITION_STEPs in display order first,
  // with the dragged issue already in its new slot.
  // EFB-98: "reorder" is a verb; the noun it edits is the issue's position,
  // and PUT is the right method for setting one wholesale.
  issues.put(path("issue.position.set"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const body = yield* parseRouteBody(c, PatchReorderBody);

      // Absent and explicitly-null collapse to the same thing — "no neighbour
      // on this side" — which is how a drop at a column edge is spelled.
      const beforeId = body.before_issue_id ?? null;
      const afterId = body.after_issue_id ?? null;
      // Not `requireAnyOf`: that tests presence, and `{"before_issue_id": null}`
      // is present. A drop needs at least one REAL neighbour to compute a
      // midpoint from, so the check is on the values, here, as it always was.
      if (beforeId === null && afterId === null) {
        return yield* new ValidationError({ reason: "neighbors" });
      }

      const { issue, board } = yield* fetchIssue(c.req.param("id"), pubkey, "contributor");
      if (beforeId === issue.id || afterId === issue.id) {
        return yield* new ValidationError({ reason: "neighbors" });
      }
      const db = yield* Db;

      // Column identity as the VIEW sees it — resolved column id when the
      // board still knows the column, raw status name otherwise.
      const columnKeyOf = (i: IssueShape) => issueColumn(board, i)?.id ?? `status:${i.status}`;
      const issueKey = columnKeyOf(issue);

      const loadNeighbor = (nid: string) =>
        Effect.gen(function* () {
          const row = yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ?", [nid]);
          if (row === null) return yield* new ValidationError({ reason: "neighbors" });
          const neighbor = parseIssueRow(row);
          if (
            neighbor.board_id !== issue.board_id ||
            neighbor.container !== issue.container ||
            columnKeyOf(neighbor) !== issueKey
          ) {
            return yield* new ValidationError({ reason: "neighbor-not-in-column" });
          }
          return neighbor;
        });
      const before = beforeId === null ? null : yield* loadNeighbor(beforeId);
      const after = afterId === null ? null : yield* loadNeighbor(afterId);

      const now = yield* Clock.currentTimeMillis;
      let newPos: number | null = null;
      if (before !== null && after !== null) {
        if (
          before.position !== null &&
          after.position !== null &&
          after.position - before.position > MIN_POSITION_GAP
        ) {
          newPos = (before.position + after.position) / 2;
        }
      } else if (before !== null && before.position !== null) {
        newPos = before.position + POSITION_STEP;
      } else if (after !== null && after.position !== null) {
        newPos = after.position - POSITION_STEP;
      }

      let updated: IssueShape;
      if (newPos !== null) {
        yield* db.execute(
          "UPDATE issueCache SET position = ?, updated_at_ms = ? WHERE id = ?",
          [newPos, now, issue.id],
        );
        updated = { ...issue, position: newPos, updated_at_ms: now };
      } else {
        // Rebalance path. Display order = position ASC (NULL last), then
        // updated_at_ms DESC — the exact comparator the views use.
        const rows = yield* db.queryAll(
          "SELECT * FROM issueCache WHERE board_id = ? AND container = ? AND (column_id = ? OR (column_id IS NULL AND status = ?))",
          [issue.board_id, issue.container, issue.column_id, issue.status],
        );
        const mates = rows
          .map(parseIssueRow)
          .filter((i) => i.id !== issue.id && columnKeyOf(i) === issueKey)
          .sort((a, b) => {
            const pa = a.position ?? Number.POSITIVE_INFINITY;
            const pb = b.position ?? Number.POSITIVE_INFINITY;
            if (pa !== pb) return pa - pb;
            return b.updated_at_ms - a.updated_at_ms;
          });
        let insertAt = mates.length;
        if (after !== null) {
          const idx = mates.findIndex((i) => i.id === after.id);
          if (idx !== -1) insertAt = idx;
        } else if (before !== null) {
          const idx = mates.findIndex((i) => i.id === before.id);
          if (idx !== -1) insertAt = idx + 1;
        }
        updated = { ...issue, position: 0, updated_at_ms: now };
        const ordered: IssueShape[] = [...mates.slice(0, insertAt), updated, ...mates.slice(insertAt)];
        for (let i = 0; i < ordered.length; i++) {
          const target = ordered[i]!;
          const pos = (i + 1) * POSITION_STEP;
          if (target.id === issue.id) {
            updated = { ...updated, position: pos };
            yield* db.execute(
              "UPDATE issueCache SET position = ?, updated_at_ms = ? WHERE id = ?",
              [pos, now, issue.id],
            );
          } else if (target.position !== pos) {
            yield* db.execute("UPDATE issueCache SET position = ? WHERE id = ?", [pos, target.id]);
          }
        }
      }

      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "issue_reordered",
        actor: claims.login,
        details: { issue: issue.id },
      });
      yield* emitSecureBoardEvent(
        issue.board_id,
        {
          kind: "issue.updated",
          board_id: issue.board_id,
          issue_id: issue.id,
          at_ms: now,
          payload: { issue: updated },
        },
        null,
      );
      return { issue: updated };
    });
    return runJson(c, program);
  });

  // ── container move — POST /issue/:id/container, idempotent ──────────────
  //
  // EFB-98 collapsed three routes into this one. They were
  // promote_to_backlog / promote_to_active / send_to_icebox: identical in
  // authorization and in every line of their bodies, differing only in the
  // destination, which is exactly the thing that belongs in a request body.
  //
  // They were also registered through a HELPER TAKING A COMPUTED PATH, which
  // meant check:boundary — which scans route files as text — could not see
  // them at all. They lived in scripts/boundary-allowlist.json as an
  // audit-trail note saying the checker "cannot see this route", which is a
  // declaration of debt rather than enforcement. Registering through the
  // manifest makes that impossible: a route not declared is not served.
  //
  // The audit event names are preserved per destination rather than collapsed
  // into one, so existing audit queries keep working across the rename.
  const CONTAINER_AUDIT_EVENT: Record<Container, string> = {
    backlog: "issue_promoted_to_backlog",
    active: "issue_promoted_to_active",
    icebox: "issue_sent_to_icebox",
  };

  /**
   * `Schema.Literal` over the three containers, so an unknown destination is a
   * 400 naming `container` rather than a silent no-op move.
   */
  const ContainerBody = Schema.Struct({
    container: Schema.Literal("backlog", "active", "icebox"),
  });

  {
    issues.post(path("issue.container.set"), async (c) => {
      const program = Effect.gen(function* () {
        const claims = yield* requireCaller(c.get("claims"));
        const pubkey = callerPubkey(claims);
        const { container: to } = yield* parseRouteBody(c, ContainerBody);
        const event = CONTAINER_AUDIT_EVENT[to];
        const { issue } = yield* fetchIssue(c.req.param("id"), pubkey, "contributor");
        const { issue: updated, statusChangeId } = yield* applyContainerMove(issue, to, pubkey);
        const audit = yield* AuditLog;
        yield* audit.record({
          event_type: event,
          actor: claims.login,
          details: { issue: issue.id },
        });
        if (updated.container !== issue.container) {
          yield* emitSecureBoardEvent(
            issue.board_id,
            {
              kind: "issue.container_changed",
              board_id: issue.board_id,
              issue_id: issue.id,
              at_ms: updated.updated_at_ms,
              ...(statusChangeId === null ? {} : { status_change_id: statusChangeId }),
              payload: {
                issue: updated,
                actor_pubkey: pubkey,
                from_container: issue.container,
                to_container: to,
              },
            },
            ProvenanceFromCaller(claims),
          );
        }
        return { issue: updated };
      });
      return runJson(c, program);
    });
  }

  return issues;
};
