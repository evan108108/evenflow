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
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { AuditLog, Audience, BoardEmitter, Db, DbError, bootstrap } from "../effects";
import { emitSecureBoardEvent } from "../audiences";
import { canonicalizeIdentityRef, isRosterMember } from "../lib/identity";
import type { AppHonoEnv, LayerFor } from "../http";
import {
  ForbiddenError,
  UnauthorizedError,
  authorizeBoardById,
  callerPubkey,
  callerPubkeyOrNull,
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
import {
  DEFAULT_ISSUE_TYPE,
  ISSUE_TYPES,
  columnById,
  columnByName,
  enabledColumns,
  type Column,
  type IssueType,
} from "../columns";
import { BODY_FORMATS, isImageContentType, type BodyFormat } from "../attachments";
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
const POSITION_STEP = 1000;
const MIN_POSITION_GAP = 1e-6;

// How far the duplicate-of cycle walk follows a chain before giving up and
// rejecting (EFB-30). A real chain is one or two links — this is a backstop
// for already-corrupt data, sized so the walk provably terminates rather than
// sized to any expected depth.
const DUPLICATE_CHAIN_MAX_HOPS = 10;

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}

type IssuesFailure =
  | ValidationError
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

// ── field validators ──────────────────────────────────────────────────────

const validateTitle = (v: unknown) =>
  typeof v === "string" && v.trim() !== ""
    ? Effect.succeed(v)
    : Effect.fail(new ValidationError({ reason: "title" }));

const validateBody = (v: unknown) =>
  v === null || typeof v === "string"
    ? Effect.succeed(v as string | null)
    : Effect.fail(new ValidationError({ reason: "body" }));

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

const validateType = (v: unknown) =>
  typeof v === "string" && (ISSUE_TYPES as ReadonlyArray<string>).includes(v)
    ? Effect.succeed(v as IssueType)
    : Effect.fail(new ValidationError({ reason: "type" }));

const validateBodyFormat = (v: unknown) =>
  typeof v === "string" && (BODY_FORMATS as ReadonlyArray<string>).includes(v)
    ? Effect.succeed(v as BodyFormat)
    : Effect.fail(new ValidationError({ reason: "body_format" }));

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

/**
 * An assignee is a reference to a person, not a string (EFB-38).
 *
 * Two failures used to hide here: `049b628c…` and `nostr:049b628c…` were
 * stored as different assignees for one key, and any authenticated caller
 * could assign work to somebody who was not on the board at all.
 *
 * The roster is boardMemberCache — deliberately the same source the members
 * endpoint and the UI picker read, so the API cannot accept an assignee the
 * picker can't show. NOT effectiveBoardRole, which floors every pubkey at
 * "viewer" on a public board and would make this check a no-op there.
 */
const validateAssignee = (
  v: unknown,
  board: BoardShape,
): Effect.Effect<string | null, ValidationError, Db> =>
  Effect.gen(function* () {
    if (v === null) return null;
    // EFB-41 removed the `isNpub` early-reject: bech32 decodes in
    // canonicalizeIdentityRef now, so an npub for somebody on the roster is a
    // valid assign. A bad-checksum npub falls through to `assignee_pubkey`,
    // and a well-formed npub for a non-member still hits `not-a-member` —
    // the roster check below is what makes that safe, not the shape gate.
    const ref = canonicalizeIdentityRef(v);
    if (ref === null) return yield* new ValidationError({ reason: "assignee_pubkey" });
    if (!(yield* isRosterMember("boardMemberCache", board.id, ref))) {
      return yield* new ValidationError({ reason: "not-a-member" });
    }
    return ref;
  }).pipe(
    // The roster read is the only failure the caller can't act on; surfacing
    // it as a 400 would blame them for our outage, so let DbError stay in the
    // channel and land as a 500 like every other read.
    Effect.catchTag("DbError", (e) => Effect.die(e)),
  );

const validateIntOrNull = (field: string) => (v: unknown) =>
  v === null || (typeof v === "number" && Number.isInteger(v))
    ? Effect.succeed(v as number | null)
    : Effect.fail(new ValidationError({ reason: field }));

const validateLabels = (v: unknown) =>
  Array.isArray(v) && v.every((l) => typeof l === "string")
    ? Effect.succeed(v as string[])
    : Effect.fail(new ValidationError({ reason: "labels" }));

// ── shared lookups + writes ───────────────────────────────────────────────

/**
 * Fetch an issue plus its board, AND prove the caller holds `minRole` on
 * that board. The ref is either a short id (FLOW-42, case-insensitive) or a
 * UUID — SSE payloads and pre-migration bookmarks still speak UUID. Missing
 * issue and an invisible board are both 404 "issue" — existence must not
 * leak; a visible board with an under-role caller is 403.
 */
const fetchIssue = (ref: string, pubkey: string | null, minRole: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const shortId = asShortId(ref);
    const row =
      shortId === null
        ? yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ?", [ref])
        : yield* db.queryFirst("SELECT * FROM issueCache WHERE short_id = ?", [shortId]);
    if (row === null) return yield* new NotFoundError({ reason: "issue" });
    const issue = parseIssueRow(row);
    const { board } = yield* authorizeBoardById(issue.board_id, pubkey, minRole).pipe(
      Effect.mapError((e) =>
        e._tag === "BoardOwnershipError" ? new NotFoundError({ reason: "issue" }) : e,
      ),
    );
    return { issue, board };
  });

interface StatusChangeWrite {
  readonly issue_id: string;
  readonly board_id: string;
  readonly actor_pubkey: string;
  readonly from_status: string | null;
  readonly to_status: string | null;
  readonly from_container: string | null;
  readonly to_container: string | null;
  readonly container_at_completion: string | null;
  readonly occurred_at_ms: number;
}

/**
 * Write the status-change audit row and RETURN ITS ID (EFB-33).
 *
 * The id used to be generated inline and thrown away, which is precisely why
 * EFB-24 could not publish a 30553: the substrate event keys on this row (it
 * is the `d` tag), so with the id discarded there was nothing to sign
 * against. Returning it is the whole unlock — callers thread it onto the
 * board event, and the publish path stamps `statusChangeCache` with it.
 */
const insertStatusChange = (w: StatusChangeWrite) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const statusChangeId = crypto.randomUUID();
    yield* db.execute(
      "INSERT INTO statusChangeCache (id, issue_id, board_id, actor_pubkey, from_status, to_status, from_container, to_container, container_at_completion, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        statusChangeId,
        w.issue_id,
        w.board_id,
        w.actor_pubkey,
        w.from_status,
        w.to_status,
        w.from_container,
        w.to_container,
        w.container_at_completion,
        w.occurred_at_ms,
      ],
    );
    return statusChangeId;
  });

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
    yield* db.execute(
      "UPDATE issueCache SET status = ?, column_id = ?, updated_at_ms = ?, completed_at_ms = ? WHERE id = ?",
      [to.name, to.id, now, completed, issue.id],
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
    yield* db.execute(
      "UPDATE issueCache SET container = ?, updated_at_ms = ? WHERE id = ?",
      [to, now, issue.id],
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
    return { issue: { ...issue, container: to, updated_at_ms: now }, statusChangeId };
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
  issues.post("/boards/:slug/issues", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const { board } = yield* resolveBoardScope(
        { org_slug: orgSlugOf(c), slug: c.req.param("slug") },
        pubkey,
        "contributor",
      );
      const body = yield* readJsonBody(c);

      const title = yield* validateTitle(body["title"]);
      const issueBody = body["body"] === undefined ? null : yield* validateBody(body["body"]);
      const body_format =
        body["body_format"] === undefined
          ? ("markdown" as BodyFormat)
          : yield* validateBodyFormat(body["body_format"]);
      const type =
        body["type"] === undefined ? DEFAULT_ISSUE_TYPE : yield* validateType(body["type"]);
      const column =
        body["status"] === undefined
          ? defaultColumn(board)
          : yield* validateStatus(board.columns, body["status"]);
      if (column === undefined) return yield* new ValidationError({ reason: "status-not-a-column" });
      const container =
        body["container"] === undefined
          ? ("backlog" as Container)
          : yield* validateContainer(body["container"]);
      const assignee =
        body["assignee_pubkey"] === undefined ? null : yield* validateAssignee(body["assignee_pubkey"], board);
      const priority =
        body["priority"] === undefined ? null : yield* validateIntOrNull("priority")(body["priority"]);
      const estimate =
        body["estimate"] === undefined ? null : yield* validateIntOrNull("estimate")(body["estimate"]);
      const labels = body["labels"] === undefined ? [] : yield* validateLabels(body["labels"]);

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
      yield* insertStatusChange({
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
      yield* emitSecureBoardEvent(board.id, {
        kind: "issue.created",
        board_id: board.id,
        issue_id: id,
        at_ms: now,
        payload: { issue },
      });
      return { issue };
    });
    return runJson(c, program, 201);
  });

  // ── GET /boards/:slug/issues — list with single-filter + keyset ─────────
  issues.get("/boards/:slug/issues", async (c) => {
    const q = {
      status: c.req.query("status"),
      container: c.req.query("container"),
      assignee: c.req.query("assignee"),
      label: c.req.query("label"),
      // Phase 22: column_id selects one Kanban column's paged stream;
      // sprint_id and q are wired through for a later filter-chip UI.
      column_id: c.req.query("column_id"),
      sprint_id: c.req.query("sprint_id"),
      q: c.req.query("q"),
    };
    const limitRaw = c.req.query("limit");
    const after = c.req.query("after");

    const program = Effect.gen(function* () {
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
  issues.get("/issues/:id", async (c) => {
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
  issues.patch("/issues/:id", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);
      // column_id is immutable here on purpose: status (name) is the PATCH
      // vocabulary, /transition is the column_id-first mover. position only
      // moves through /reorder, which knows the neighbor midpoint math.
      for (const immutable of ["id", "board_id", "created_at_ms", "github_links", "container", "column_id", "completed_at_ms", "updated_at_ms", "position", "sprint_id"]) {
        if (body[immutable] !== undefined) {
          return yield* new ValidationError({ reason: `${immutable}-immutable` });
        }
      }
      const patchable = ["title", "body", "body_format", "type", "status", "assignee_pubkey", "priority", "estimate", "labels"];
      if (!patchable.some((k) => body[k] !== undefined)) {
        return yield* new ValidationError({ reason: "empty-patch" });
      }

      const { issue: current, board } = yield* fetchIssue(c.req.param("id"), pubkey, "contributor");
      const db = yield* Db;

      const title = body["title"] === undefined ? current.title : yield* validateTitle(body["title"]);
      const issueBody = body["body"] === undefined ? current.body : yield* validateBody(body["body"]);
      const body_format =
        body["body_format"] === undefined
          ? current.body_format
          : yield* validateBodyFormat(body["body_format"]);
      const type = body["type"] === undefined ? current.type : yield* validateType(body["type"]);
      const toColumn =
        body["status"] === undefined
          ? issueColumn(board, current)
          : yield* validateStatus(board.columns, body["status"]);
      const status = toColumn?.name ?? current.status;
      const column_id = toColumn?.id ?? current.column_id;
      const assignee =
        body["assignee_pubkey"] === undefined
          ? current.assignee_pubkey
          : yield* validateAssignee(body["assignee_pubkey"], board);
      const priority =
        body["priority"] === undefined ? current.priority : yield* validateIntOrNull("priority")(body["priority"]);
      const estimate =
        body["estimate"] === undefined ? current.estimate : yield* validateIntOrNull("estimate")(body["estimate"]);
      const labels = body["labels"] === undefined ? current.labels : yield* validateLabels(body["labels"]);

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
        "UPDATE issueCache SET title = ?, body = ?, body_format = ?, type = ?, status = ?, column_id = ?, assignee_pubkey = ?, priority = ?, estimate = ?, labels = ?, updated_at_ms = ?, completed_at_ms = ? WHERE id = ?",
        [title, issueBody, body_format, type, status, column_id, assignee, priority, estimate, JSON.stringify(labels), now, completed, current.id],
      );
      if (status !== current.status) {
        yield* insertStatusChange({
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
      }
      yield* audit.record({
        event_type: "issue_updated",
        actor: claims.login,
        details: { issue: current.id },
      });
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
        updated_at_ms: now,
        completed_at_ms: completed,
      };
      yield* emitSecureBoardEvent(current.board_id, {
        kind: "issue.updated",
        board_id: current.board_id,
        issue_id: current.id,
        at_ms: now,
        payload: { issue },
      });
      return { issue };
    });
    return runJson(c, program);
  });

  // ── DELETE /issues/:id — cascades comments in code; audit rows stay ─────
  issues.delete("/issues/:id", async (c) => {
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
      yield* emitSecureBoardEvent(issue.board_id, {
        kind: "issue.deleted",
        board_id: issue.board_id,
        issue_id: issue.id,
        at_ms: now,
        payload: { issue_id: issue.id },
      });
      return { deleted: true };
    });
    return runJson(c, program);
  });

  // ── POST /issues/:id/transition — the drag-drop endpoint ────────────────
  // column_id is the preferred addressing (stable across renames); `to` is
  // the legacy name-match, with `to_status` still accepted as its pre-17
  // spelling. When both arrive, column_id wins.
  issues.post("/issues/:id/transition", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);
      const { issue, board } = yield* fetchIssue(c.req.param("id"), pubkey, "contributor");
      let to: Column;
      if (body["column_id"] !== undefined) {
        const target =
          typeof body["column_id"] === "string"
            ? columnById(board.columns, body["column_id"])
            : undefined;
        if (target === undefined) return yield* new ValidationError({ reason: "column_id" });
        to = target;
      } else {
        to = yield* validateStatus(board.columns, body["to"] ?? body["to_status"]);
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
        yield* emitSecureBoardEvent(issue.board_id, {
          kind: "issue.transitioned",
          board_id: issue.board_id,
          issue_id: issue.id,
          at_ms: updated.updated_at_ms,
          ...(statusChangeId === null ? {} : { status_change_id: statusChangeId }),
          // actor_pubkey is WHO MOVED THE CARD, which is not recoverable from
          // the issue: assignee_pubkey is who owns the work, a different
          // person most of the time. The 30553 attributes the change, so it
          // needs the actor the statusChangeCache row was written with.
          payload: {
            issue: updated,
            actor_pubkey: pubkey,
            from_status: issue.status,
            to_status: to.name,
          },
        });
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
  issues.post("/issues/:id/duplicate-of", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);
      const raw = body["duplicate_of_issue_id"];
      if (raw !== null && typeof raw !== "string") {
        return yield* new ValidationError({ reason: "duplicate_of_issue_id" });
      }
      const { issue, board } = yield* fetchIssue(c.req.param("id"), pubkey, "contributor");
      const db = yield* Db;
      const audit = yield* AuditLog;

      // ── un-mark ──────────────────────────────────────────────────────────
      if (raw === null) {
        if (issue.duplicate_of_issue_id === null) return { issue };
        const now = yield* Clock.currentTimeMillis;
        yield* db.execute(
          "UPDATE issueCache SET duplicate_of_issue_id = NULL, updated_at_ms = ? WHERE id = ?",
          [now, issue.id],
        );
        yield* audit.record({
          event_type: "issue_duplicate_cleared",
          actor: claims.login,
          details: { issue: issue.id, was_duplicate_of: issue.duplicate_of_issue_id },
        });
        const updated: IssueShape = {
          ...issue,
          duplicate_of_issue_id: null,
          updated_at_ms: now,
        };
        yield* emitSecureBoardEvent(issue.board_id, {
          kind: "issue.updated",
          board_id: issue.board_id,
          issue_id: issue.id,
          at_ms: now,
          payload: { issue: updated },
        });
        return { issue: updated };
      }

      // ── resolve the target ───────────────────────────────────────────────
      // Same addressing as fetchIssue (short id or UUID) so the API accepts
      // whatever a caller has in hand, but deliberately NOT fetchIssue itself:
      // that authorizes the target's board, and the target is constrained to
      // THIS board anyway. Short ids are per-board vocabulary (see
      // /move-to-board, which mints a fresh one), so a cross-board pointer
      // could not render as "→ EFB-7" without lying about which board's #7.
      const targetShortId = asShortId(raw);
      const targetRow =
        targetShortId === null
          ? yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ?", [raw])
          : yield* db.queryFirst("SELECT * FROM issueCache WHERE short_id = ?", [targetShortId]);
      if (targetRow === null) {
        return yield* new ValidationError({ reason: "duplicate-target-not-found" });
      }
      const target = parseIssueRow(targetRow);
      if (target.board_id !== issue.board_id) {
        return yield* new ValidationError({ reason: "duplicate-target-other-board" });
      }

      // ── cycle guard ──────────────────────────────────────────────────────
      if (yield* closesDuplicateLoop(issue.id, target.id)) {
        return yield* new ValidationError({ reason: "circular_duplicate" });
      }

      // ── write ────────────────────────────────────────────────────────────
      // Pointer BEFORE transition, and the order matters because there is no
      // transaction here. Pointer-then-transition half-writes to "a duplicate
      // sitting in its old column" — visible on the board, and re-running the
      // action fixes it. Transition-then-pointer half-writes to "an issue
      // silently in Done with nothing saying why", which nobody would think
      // to look for. Same reasoning as the estimate-history ordering in PATCH.
      const markedAt = yield* Clock.currentTimeMillis;
      yield* db.execute(
        "UPDATE issueCache SET duplicate_of_issue_id = ?, updated_at_ms = ? WHERE id = ?",
        [target.id, markedAt, issue.id],
      );
      const pointed: IssueShape = {
        ...issue,
        duplicate_of_issue_id: target.id,
        updated_at_ms: markedAt,
      };

      // A board with no enabled done column is a configuration problem, not a
      // reason to refuse the mark: record the pointer and leave the column
      // alone rather than inventing a destination.
      const doneColumn = enabledColumns(board.columns).find((col) => col.category === "done");
      const { issue: updated, statusChangeId } =
        doneColumn === undefined
          ? { issue: pointed, statusChangeId: null }
          : yield* applyStatusChange(pointed, doneColumn, board, pubkey);

      yield* audit.record({
        event_type: "issue_marked_duplicate",
        actor: claims.login,
        details: { issue: issue.id, duplicate_of: target.id },
      });

      // issue.transitioned when a column actually moved, so the 30553 gets
      // published alongside the 30551; issue.updated when the issue was
      // already in Done and only the pointer changed. Both carry the whole
      // issue, so either way the substrate 30551 picks up fa:duplicate_of.
      const moved = updated.status !== issue.status || updated.column_id !== issue.column_id;
      yield* emitSecureBoardEvent(issue.board_id, {
        kind: moved ? "issue.transitioned" : "issue.updated",
        board_id: issue.board_id,
        issue_id: issue.id,
        at_ms: updated.updated_at_ms,
        ...(statusChangeId === null ? {} : { status_change_id: statusChangeId }),
        payload: moved
          ? {
              issue: updated,
              actor_pubkey: pubkey,
              from_status: issue.status,
              to_status: updated.status,
            }
          : { issue: updated },
      });
      return { issue: updated };
    });
    return runJson(c, program);
  });

  // ── POST /issues/:id/move-to-board — cross-board move ───────────────────
  // Contributor on BOTH boards. The issue keeps its container but gets a
  // fresh short_id minted in the target's prefix (links to the old id keep
  // resolving nowhere — short ids are per-board vocabulary), lands in the
  // same-named enabled column when the target has one, else the first
  // enabled todo-category column, else the first enabled column. Sprint
  // assignment is per-board, so it resets.
  issues.post("/issues/:id/move-to-board", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);
      if (typeof body["target_board_id"] !== "string" || body["target_board_id"] === "") {
        return yield* new ValidationError({ reason: "target_board_id" });
      }
      const { issue, board: source } = yield* fetchIssue(c.req.param("id"), pubkey, "contributor");
      if (body["target_board_id"] === source.id) {
        return yield* new ValidationError({ reason: "target-is-source" });
      }
      const { board: target } = yield* authorizeBoardById(
        body["target_board_id"],
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
      yield* emitSecureBoardEvent(source.id, {
        kind: "issue.updated",
        board_id: source.id,
        issue_id: issue.id,
        at_ms: now,
        payload: { issue_id: issue.id, moved_to_board: target.id },
      });
      yield* emitSecureBoardEvent(target.id, {
        kind: "issue.updated",
        board_id: target.id,
        issue_id: issue.id,
        at_ms: now,
        payload: { issue: moved },
      });
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
  issues.patch("/issues/:id/reorder", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);

      const neighborId = (key: string) =>
        body[key] === undefined || body[key] === null
          ? Effect.succeed(null)
          : typeof body[key] === "string"
            ? Effect.succeed(body[key] as string)
            : Effect.fail(new ValidationError({ reason: key }));
      const beforeId = yield* neighborId("before_issue_id");
      const afterId = yield* neighborId("after_issue_id");
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
      yield* emitSecureBoardEvent(issue.board_id, {
        kind: "issue.updated",
        board_id: issue.board_id,
        issue_id: issue.id,
        at_ms: now,
        payload: { issue: updated },
      });
      return { issue: updated };
    });
    return runJson(c, program);
  });

  // ── container moves: three verbs, all idempotent ────────────────────────
  const containerEndpoint = (path: `/issues/:id/${string}`, to: Container, event: string) => {
    issues.post(path, async (c) => {
      const program = Effect.gen(function* () {
        const claims = yield* requireCaller(c.get("claims"));
        const pubkey = callerPubkey(claims);
        const { issue } = yield* fetchIssue(c.req.param("id"), pubkey, "contributor");
        const { issue: updated, statusChangeId } = yield* applyContainerMove(issue, to, pubkey);
        const audit = yield* AuditLog;
        yield* audit.record({
          event_type: event,
          actor: claims.login,
          details: { issue: issue.id },
        });
        if (updated.container !== issue.container) {
          yield* emitSecureBoardEvent(issue.board_id, {
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
          });
        }
        return { issue: updated };
      });
      return runJson(c, program);
    });
  };
  containerEndpoint("/issues/:id/promote_to_backlog", "backlog", "issue_promoted_to_backlog");
  containerEndpoint("/issues/:id/promote_to_active", "active", "issue_promoted_to_active");
  containerEndpoint("/issues/:id/send_to_icebox", "icebox", "issue_sent_to_icebox");

  return issues;
};
