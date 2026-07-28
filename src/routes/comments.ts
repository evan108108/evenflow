// /api/v0 comments — comment write path + thread reads against
// commentCache. Same MVP posture as issues.ts: D1 rows directly, uuid ids,
// 4a event publishing (kind 30552) lands in the event-publisher phase.
//
// Threads read chronologically, so listing sorts created_at_ms ASC — the
// opposite of the boards/issues lists — and the keyset cursor walks
// forward. Deletion is author-only: board ownership grants no moderation
// power in MVP (that conversation belongs to the membership phase).

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { AuditLog, BoardEmitter, Db, DbError, bootstrap, emitBoardEvent } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { callerPubkey, type BoardOwnershipError } from "../authz";
import { parseCommentRow, parseIssueRow, type CommentShape } from "../shapes";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}
class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly reason: string;
}> {}

type CommentsFailure =
  | ValidationError
  | NotFoundError
  | ForbiddenError
  | BoardOwnershipError
  | DbError;

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<CommentsFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
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

/** Issue lookup + board-ownership proof, 404 "issue" on any miss. */
const fetchOwnIssueId = (id: string, pubkey: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ?", [id]);
    if (row === null) return yield* new NotFoundError({ reason: "issue" });
    const issue = parseIssueRow(row);
    const board = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT * FROM boardCache WHERE id = ?",
      [issue.board_id],
    );
    if (board === null || board["pubkey"] !== pubkey) {
      return yield* new NotFoundError({ reason: "issue" });
    }
    return issue;
  });

export const makeCommentsRouter = (layerFor: LayerFor = bootstrap) => {
  const comments = new Hono<AppHonoEnv>();

  const runJson = async (
    c: Context<AppHonoEnv>,
    program: Effect.Effect<unknown, CommentsFailure, Db | AuditLog | BoardEmitter>,
    okStatus: 200 | 201 = 200,
  ) => {
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, okStatus);
  };

  // ── POST /issues/:id/comments ───────────────────────────────────────────
  comments.post("/issues/:id/comments", async (c) => {
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const pubkey = callerPubkey(claims);
      const issue = yield* fetchOwnIssueId(c.req.param("id"), pubkey);
      const body = yield* readJsonBody(c);

      const text = body["body"];
      if (typeof text !== "string" || text.trim() === "") {
        return yield* new ValidationError({ reason: "body" });
      }
      const db = yield* Db;
      let inReplyTo: string | null = null;
      if (body["in_reply_to"] !== undefined && body["in_reply_to"] !== null) {
        if (typeof body["in_reply_to"] !== "string") {
          return yield* new ValidationError({ reason: "in_reply_to" });
        }
        // Must reference an existing comment on the same issue — no
        // dangling or cross-issue threads.
        const parent = yield* db.queryFirst(
          "SELECT * FROM commentCache WHERE id = ? AND issue_id = ?",
          [body["in_reply_to"], issue.id],
        );
        if (parent === null) return yield* new ValidationError({ reason: "in_reply_to" });
        inReplyTo = body["in_reply_to"];
      }

      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      const comment: CommentShape = {
        id: crypto.randomUUID(),
        issue_id: issue.id,
        author_pubkey: pubkey,
        body: text,
        in_reply_to: inReplyTo,
        created_at_ms: now,
      };
      yield* db.execute(
        "INSERT INTO commentCache (id, issue_id, author_pubkey, body, in_reply_to, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
        [comment.id, comment.issue_id, comment.author_pubkey, comment.body, comment.in_reply_to, comment.created_at_ms],
      );
      yield* audit.record({
        event_type: "comment_created",
        actor: claims.login,
        details: { issue: issue.id, comment: comment.id },
      });
      yield* emitBoardEvent(issue.board_id, {
        kind: "comment.created",
        board_id: issue.board_id,
        issue_id: issue.id,
        comment_id: comment.id,
        at_ms: now,
        payload: { comment },
      });
      return { comment };
    });
    return runJson(c, program, 201);
  });

  // ── GET /issues/:id/comments — chronological with forward keyset ────────
  comments.get("/issues/:id/comments", async (c) => {
    const claims = c.get("claims");
    const limitRaw = c.req.query("limit");
    const after = c.req.query("after");
    const program = Effect.gen(function* () {
      const issue = yield* fetchOwnIssueId(c.req.param("id"), callerPubkey(claims));

      let limit = DEFAULT_LIMIT;
      if (limitRaw !== undefined) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n < 1) return yield* new ValidationError({ reason: "limit" });
        limit = Math.min(n, MAX_LIMIT);
      }

      const db = yield* Db;
      let cursorSql = "";
      const cursorParams: unknown[] = [];
      if (after !== undefined) {
        const anchor = yield* db.queryFirst<Record<string, unknown>>(
          "SELECT * FROM commentCache WHERE id = ? AND issue_id = ?",
          [after, issue.id],
        );
        if (anchor === null) return yield* new ValidationError({ reason: "after" });
        cursorSql = " AND (created_at_ms > ? OR (created_at_ms = ? AND id > ?))";
        cursorParams.push(anchor["created_at_ms"], anchor["created_at_ms"], after);
      }

      const rows = yield* db.queryAll(
        `SELECT * FROM commentCache WHERE issue_id = ?${cursorSql} ORDER BY created_at_ms ASC, id ASC LIMIT ?`,
        [issue.id, ...cursorParams, limit + 1],
      );
      const count = yield* db.queryFirst<{ n: number }>(
        "SELECT COUNT(*) AS n FROM commentCache WHERE issue_id = ?",
        [issue.id],
      );
      return {
        comments: rows.slice(0, limit).map(parseCommentRow),
        total: count?.n ?? 0,
        has_more: rows.length > limit,
      };
    });
    return runJson(c, program);
  });

  // ── DELETE /comments/:id — author-only ──────────────────────────────────
  comments.delete("/comments/:id", async (c) => {
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const pubkey = callerPubkey(claims);
      const db = yield* Db;
      const row = yield* db.queryFirst("SELECT * FROM commentCache WHERE id = ?", [
        c.req.param("id"),
      ]);
      if (row === null) return yield* new NotFoundError({ reason: "comment" });
      const comment = parseCommentRow(row);
      if (comment.author_pubkey !== pubkey) {
        return yield* new ForbiddenError({ reason: "not-author" });
      }
      const audit = yield* AuditLog;
      yield* db.execute("DELETE FROM commentCache WHERE id = ?", [comment.id]);
      yield* audit.record({
        event_type: "comment_deleted",
        actor: claims.login,
        details: { comment: comment.id },
      });
      // Comments don't carry board_id — resolve it through the issue. The
      // issue can only be missing if it was deleted mid-flight (its comment
      // cascade would have taken this row too), so skip the emit then.
      const issueRow = yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ?", [
        comment.issue_id,
      ]);
      if (issueRow !== null) {
        const issue = parseIssueRow(issueRow);
        const now = yield* Clock.currentTimeMillis;
        yield* emitBoardEvent(issue.board_id, {
          kind: "comment.deleted",
          board_id: issue.board_id,
          issue_id: issue.id,
          comment_id: comment.id,
          at_ms: now,
          payload: { comment_id: comment.id, issue_id: issue.id },
        });
      }
      return { deleted: true };
    });
    return runJson(c, program);
  });

  return comments;
};
