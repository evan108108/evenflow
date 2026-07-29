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
import { AuditLog, BoardEmitter, Db, DbError, bootstrap, emitBoardEvent } from "../effects";
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
import { asShortId, derivePrefix, uniquePrefix } from "../slug";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Fractional intra-column positioning (phase 18d, Trello-shape). Append =
// max+STEP, insert = neighbor midpoint; when the midpoint degenerates
// (neighbors closer than MIN_GAP, or a neighbor is a positionless legacy
// row) the whole column rebalances to whole STEPs in display order.
// Mirrored at web/src/lib/order.ts — keep the two in lockstep.
const POSITION_STEP = 1000;
const MIN_POSITION_GAP = 1e-6;

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

const validateAssignee = (v: unknown) =>
  v === null || (typeof v === "string" && v !== "")
    ? Effect.succeed(v as string | null)
    : Effect.fail(new ValidationError({ reason: "assignee_pubkey" }));

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

const insertStatusChange = (w: StatusChangeWrite) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.execute(
      "INSERT INTO statusChangeCache (id, issue_id, board_id, actor_pubkey, from_status, to_status, from_container, to_container, container_at_completion, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        crypto.randomUUID(),
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
 */
const applyStatusChange = (issue: IssueShape, to: Column, board: BoardShape, actor: string) =>
  Effect.gen(function* () {
    if (to.id === issue.column_id && to.name === issue.status) return issue;
    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    const toDone = to.category === "done";
    const completed = nextCompletedAt(issue, inDone(board, issue), toDone, now);
    yield* db.execute(
      "UPDATE issueCache SET status = ?, column_id = ?, updated_at_ms = ?, completed_at_ms = ? WHERE id = ?",
      [to.name, to.id, now, completed, issue.id],
    );
    if (to.name !== issue.status) {
      yield* insertStatusChange({
        issue_id: issue.id,
        board_id: issue.board_id,
        actor_pubkey: actor,
        from_status: issue.status,
        to_status: to.name,
        from_container: null,
        to_container: null,
        container_at_completion: toDone ? issue.container : null,
        occurred_at_ms: now,
      });
    }
    return {
      ...issue,
      status: to.name,
      column_id: to.id,
      updated_at_ms: now,
      completed_at_ms: completed,
    };
  });

/** Move an issue between containers. Idempotent: same-container is a no-op. */
const applyContainerMove = (issue: IssueShape, to: Container, actor: string) =>
  Effect.gen(function* () {
    if (to === issue.container) return issue;
    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    yield* db.execute(
      "UPDATE issueCache SET container = ?, updated_at_ms = ? WHERE id = ?",
      [to, now, issue.id],
    );
    yield* insertStatusChange({
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
    return { ...issue, container: to, updated_at_ms: now };
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
    program: Effect.Effect<unknown, IssuesFailure, Db | AuditLog | BoardEmitter>,
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
        body["assignee_pubkey"] === undefined ? null : yield* validateAssignee(body["assignee_pubkey"]);
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
        created_at_ms: now,
        updated_at_ms: now,
        completed_at_ms: createdDone ? now : null,
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
      yield* emitBoardEvent(board.id, {
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
    };
    const limitRaw = c.req.query("limit");
    const after = c.req.query("after");

    const program = Effect.gen(function* () {
      const { board } = yield* resolveBoardScope(
        { org_slug: orgSlugOf(c), slug: c.req.param("slug") },
        callerPubkeyOrNull(c.get("claims")),
        "viewer",
      );

      const active = Object.entries(q).filter(([, v]) => v !== undefined);
      if (active.length > 1) return yield* new ValidationError({ reason: "one-filter-at-a-time" });

      let limit = DEFAULT_LIMIT;
      if (limitRaw !== undefined) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n < 1) return yield* new ValidationError({ reason: "limit" });
        limit = Math.min(n, MAX_LIMIT);
      }

      // Single optional filter, expressed as a SQL fragment + params.
      let filterSql = "";
      const filterParams: unknown[] = [];
      if (q.status !== undefined) {
        filterSql = " AND status = ?";
        filterParams.push(q.status);
      } else if (q.container !== undefined) {
        yield* validateContainer(q.container);
        filterSql = " AND container = ?";
        filterParams.push(q.container);
      } else if (q.assignee !== undefined) {
        filterSql = " AND assignee_pubkey = ?";
        filterParams.push(q.assignee);
      } else if (q.label !== undefined) {
        filterSql = " AND EXISTS (SELECT 1 FROM json_each(issueCache.labels) WHERE json_each.value = ?)";
        filterParams.push(q.label);
      }

      const db = yield* Db;
      let cursorSql = "";
      const cursorParams: unknown[] = [];
      if (after !== undefined) {
        const anchor = yield* db.queryFirst<Record<string, unknown>>(
          "SELECT * FROM issueCache WHERE board_id = ? AND id = ?",
          [board.id, after],
        );
        if (anchor === null) return yield* new ValidationError({ reason: "after" });
        cursorSql = " AND (updated_at_ms < ? OR (updated_at_ms = ? AND id < ?))";
        cursorParams.push(anchor["updated_at_ms"], anchor["updated_at_ms"], after);
      }

      // limit+1 probe answers has_more without a second count query.
      const rows = yield* db.queryAll(
        `SELECT * FROM issueCache WHERE board_id = ?${filterSql}${cursorSql} ORDER BY updated_at_ms DESC, id DESC LIMIT ?`,
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

      return {
        issues: issues.map((i) => ({ ...i, cover_url: covers.get(i.id) ?? null })),
        total: count?.n ?? 0,
        has_more: rows.length > limit,
      };
    });
    return runJson(c, program);
  });

  // ── GET /issues/:id ─────────────────────────────────────────────────────
  issues.get("/issues/:id", async (c) => {
    const program = Effect.gen(function* () {
      const { issue } = yield* fetchIssue(
        c.req.param("id"),
        callerPubkeyOrNull(c.get("claims")),
        "viewer",
      );
      return { issue };
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
      for (const immutable of ["id", "board_id", "created_at_ms", "github_links", "container", "column_id", "completed_at_ms", "updated_at_ms", "position"]) {
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
          : yield* validateAssignee(body["assignee_pubkey"]);
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
      yield* emitBoardEvent(current.board_id, {
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
      yield* emitBoardEvent(issue.board_id, {
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
      const updated = yield* applyStatusChange(issue, to, board, pubkey);
      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "issue_transitioned",
        actor: claims.login,
        details: { issue: issue.id, to_status: to.name },
      });
      if (updated.status !== issue.status || updated.column_id !== issue.column_id) {
        yield* emitBoardEvent(issue.board_id, {
          kind: "issue.transitioned",
          board_id: issue.board_id,
          issue_id: issue.id,
          at_ms: updated.updated_at_ms,
          payload: { issue: updated, from_status: issue.status, to_status: to.name },
        });
      }
      return { issue: updated };
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
      yield* emitBoardEvent(issue.board_id, {
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
        const updated = yield* applyContainerMove(issue, to, pubkey);
        const audit = yield* AuditLog;
        yield* audit.record({
          event_type: event,
          actor: claims.login,
          details: { issue: issue.id },
        });
        if (updated.container !== issue.container) {
          yield* emitBoardEvent(issue.board_id, {
            kind: "issue.container_changed",
            board_id: issue.board_id,
            issue_id: issue.id,
            at_ms: updated.updated_at_ms,
            payload: { issue: updated, from_container: issue.container, to_container: to },
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
