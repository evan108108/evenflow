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
// Auth: mounted under /api/v0 (requireAuth applied in index.ts).

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { AuditLog, BoardEmitter, Db, DbError, bootstrap, emitBoardEvent, type Claims } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { assertOwnBoard, callerPubkey, type BoardOwnershipError } from "../authz";
import {
  CONTAINERS,
  parseBoardRow,
  parseIssueRow,
  type Container,
  type IssueShape,
} from "../shapes";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// MVP: the literal "Done" column is the completion marker (matches the
// default column set). Column-role metadata (which column means "done" on a
// custom board) is a later phase.
const DONE_STATUS = "Done";

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}

type IssuesFailure = ValidationError | NotFoundError | BoardOwnershipError | DbError;

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<IssuesFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
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

const validateStatus = (columns: ReadonlyArray<string>, v: unknown) =>
  typeof v === "string" && columns.includes(v)
    ? Effect.succeed(v)
    : Effect.fail(new ValidationError({ reason: "status-not-a-column" }));

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
 * Fetch an issue plus its board, AND prove the caller owns that board.
 * Missing issue and someone else's issue are both 404 "issue" — existence
 * must not leak.
 */
const fetchOwnIssue = (id: string, pubkey: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ?", [id]);
    if (row === null) return yield* new NotFoundError({ reason: "issue" });
    const issue = parseIssueRow(row);
    const boardRow = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT * FROM boardCache WHERE id = ?",
      [issue.board_id],
    );
    if (boardRow === null || boardRow["pubkey"] !== pubkey) {
      return yield* new NotFoundError({ reason: "issue" });
    }
    return { issue, board: parseBoardRow(boardRow) };
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

/** completed_at_ms follows the Done edge: set on arrival, cleared on exit. */
const nextCompletedAt = (
  current: IssueShape,
  toStatus: string,
  now: number,
): number | null => {
  if (toStatus === DONE_STATUS && current.status !== DONE_STATUS) return now;
  if (toStatus !== DONE_STATUS) return null;
  return current.completed_at_ms;
};

/**
 * Apply a status change (shared by PATCH and /transition): update the row,
 * maintain completed_at_ms, write the audit row. No-op when unchanged.
 */
const applyStatusChange = (issue: IssueShape, toStatus: string, actor: string) =>
  Effect.gen(function* () {
    if (toStatus === issue.status) return issue;
    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    const completed = nextCompletedAt(issue, toStatus, now);
    yield* db.execute(
      "UPDATE issueCache SET status = ?, updated_at_ms = ?, completed_at_ms = ? WHERE id = ?",
      [toStatus, now, completed, issue.id],
    );
    yield* insertStatusChange({
      issue_id: issue.id,
      board_id: issue.board_id,
      actor_pubkey: actor,
      from_status: issue.status,
      to_status: toStatus,
      from_container: null,
      to_container: null,
      container_at_completion: toStatus === DONE_STATUS ? issue.container : null,
      occurred_at_ms: now,
    });
    return { ...issue, status: toStatus, updated_at_ms: now, completed_at_ms: completed };
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
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const pubkey = callerPubkey(claims);
      const board = yield* assertOwnBoard(c.req.param("slug"), pubkey);
      const body = yield* readJsonBody(c);

      const title = yield* validateTitle(body["title"]);
      const issueBody = body["body"] === undefined ? null : yield* validateBody(body["body"]);
      const status =
        body["status"] === undefined
          ? board.columns[0] ?? DONE_STATUS
          : yield* validateStatus(board.columns, body["status"]);
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
      const now = yield* Clock.currentTimeMillis;
      const id = crypto.randomUUID();
      const issue: IssueShape = {
        id,
        board_id: board.id,
        title,
        body: issueBody,
        status,
        container,
        assignee_pubkey: assignee,
        priority,
        estimate,
        labels,
        github_links: [],
        created_at_ms: now,
        updated_at_ms: now,
        completed_at_ms: status === DONE_STATUS ? now : null,
      };
      yield* db.execute(
        "INSERT INTO issueCache (id, board_id, title, body, status, container, assignee_pubkey, priority, estimate, labels, github_links, created_at_ms, updated_at_ms, completed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          board.id,
          title,
          issueBody,
          status,
          container,
          assignee,
          priority,
          estimate,
          JSON.stringify(labels),
          "[]",
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
        to_status: status,
        from_container: null,
        to_container: container,
        container_at_completion: status === DONE_STATUS ? container : null,
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
    const claims = c.get("claims");
    const q = {
      status: c.req.query("status"),
      container: c.req.query("container"),
      assignee: c.req.query("assignee"),
      label: c.req.query("label"),
    };
    const limitRaw = c.req.query("limit");
    const after = c.req.query("after");

    const program = Effect.gen(function* () {
      const board = yield* assertOwnBoard(c.req.param("slug"), callerPubkey(claims));

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
      return {
        issues: rows.slice(0, limit).map(parseIssueRow),
        total: count?.n ?? 0,
        has_more: rows.length > limit,
      };
    });
    return runJson(c, program);
  });

  // ── GET /issues/:id ─────────────────────────────────────────────────────
  issues.get("/issues/:id", async (c) => {
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const { issue } = yield* fetchOwnIssue(c.req.param("id"), callerPubkey(claims));
      return { issue };
    });
    return runJson(c, program);
  });

  // ── PATCH /issues/:id — partial update (container excluded) ─────────────
  issues.patch("/issues/:id", async (c) => {
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);
      for (const immutable of ["id", "board_id", "created_at_ms", "github_links", "container", "completed_at_ms", "updated_at_ms"]) {
        if (body[immutable] !== undefined) {
          return yield* new ValidationError({ reason: `${immutable}-immutable` });
        }
      }
      const patchable = ["title", "body", "status", "assignee_pubkey", "priority", "estimate", "labels"];
      if (!patchable.some((k) => body[k] !== undefined)) {
        return yield* new ValidationError({ reason: "empty-patch" });
      }

      const { issue: current, board } = yield* fetchOwnIssue(c.req.param("id"), pubkey);
      const db = yield* Db;

      const title = body["title"] === undefined ? current.title : yield* validateTitle(body["title"]);
      const issueBody = body["body"] === undefined ? current.body : yield* validateBody(body["body"]);
      const status =
        body["status"] === undefined ? current.status : yield* validateStatus(board.columns, body["status"]);
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
      const completed = status === current.status ? current.completed_at_ms : nextCompletedAt(current, status, now);
      yield* db.execute(
        "UPDATE issueCache SET title = ?, body = ?, status = ?, assignee_pubkey = ?, priority = ?, estimate = ?, labels = ?, updated_at_ms = ?, completed_at_ms = ? WHERE id = ?",
        [title, issueBody, status, assignee, priority, estimate, JSON.stringify(labels), now, completed, current.id],
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
          container_at_completion: status === DONE_STATUS ? current.container : null,
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
        status,
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
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const { issue } = yield* fetchOwnIssue(c.req.param("id"), callerPubkey(claims));
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
  issues.post("/issues/:id/transition", async (c) => {
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);
      const { issue, board } = yield* fetchOwnIssue(c.req.param("id"), pubkey);
      const toStatus = yield* validateStatus(board.columns, body["to_status"]);
      const updated = yield* applyStatusChange(issue, toStatus, pubkey);
      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "issue_transitioned",
        actor: claims.login,
        details: { issue: issue.id, to_status: toStatus },
      });
      if (updated.status !== issue.status) {
        yield* emitBoardEvent(issue.board_id, {
          kind: "issue.transitioned",
          board_id: issue.board_id,
          issue_id: issue.id,
          at_ms: updated.updated_at_ms,
          payload: { issue: updated, from_status: issue.status, to_status: toStatus },
        });
      }
      return { issue: updated };
    });
    return runJson(c, program);
  });

  // ── container moves: three verbs, all idempotent ────────────────────────
  const containerEndpoint = (path: `/issues/:id/${string}`, to: Container, event: string) => {
    issues.post(path, async (c) => {
      const claims = c.get("claims");
      const program = Effect.gen(function* () {
        const pubkey = callerPubkey(claims);
        const { issue } = yield* fetchOwnIssue(c.req.param("id"), pubkey);
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
