// /api/v0 comments — comment write path + thread reads against
// commentCache. Same MVP posture as issues.ts: D1 rows directly, uuid ids,
// 4a event publishing (kind 30552) lands in the event-publisher phase.
//
// Threads read chronologically, so listing sorts created_at_ms ASC — the
// opposite of the boards/issues lists — and the keyset cursor walks
// forward. Deletion stays author-only on top of the phase-16 contributor
// requirement: board admin rights grant no moderation power yet.
//
// Auth (phase 16): behind optionalAuth — thread reads run at "viewer"
// (anonymous works on public boards); comment writes require a caller at
// "contributor".

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option, Schema } from "effect";
import { parseRouteBody } from "../lib/route-body";
import { AuditLog, Audience, BoardEmitter, Db, DbError, bootstrap } from "../effects";
import { emitSecureBoardEvent } from "../audiences";
import type { AppHonoEnv, LayerFor } from "../http";
import {
  ForbiddenError,
  UnauthorizedError,
  authorizeBoardById,
  callerPubkey,
  callerPubkeyOrNull,
  notVisible,
  requireCaller,
  type BoardOwnershipError,
} from "../authz";
import {
  parseAttachmentRow,
  parseCommentRow,
  parseIssueRow,
  type AttachmentShape,
  type CommentShape,
} from "../shapes";
import { asShortId } from "../slug";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Attachments one comment may claim — same ceiling as the per-issue cap. */
const MAX_ATTACHMENT_IDS_PER_COMMENT = 20;

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}

type CommentsFailure =
  | ValidationError
  | NotFoundError
  | ForbiddenError
  | UnauthorizedError
  | BoardOwnershipError
  | DbError;

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

/**
 * POST /issues/:id/comments — the accepted shape.
 *
 * EFB-61. SHAPE only, per docs/BOUNDARY_DISCIPLINE.md: the two checks this
 * route makes that need a database — the parent comment exists on THIS issue,
 * each attachment is live and unclaimed on THIS issue — are authorization and
 * stay in the handler as named steps below.
 *
 * Every failure message here is deliberately PROSE, not a kebab slug. A bare
 * slug is read as a reason CODE by `reasonFor` and would surface as
 * `body-<slug>`; prose falls back to the field name, which is the string this
 * route already answered (`reason: "body"`, `reason: "in_reply_to"`) and which
 * tests/comments.test.ts pins.
 */
export const PostCommentBody = Schema.Struct({
  // `Schema.minLength(1)` would accept "   ". The pre-migration handler tested
  // `text.trim() === ""`, so whitespace-only has always been a 400 and stays one.
  body: Schema.String.pipe(
    Schema.filter((s) => (s.trim() === "" ? "must be a non-empty string" : undefined)),
  ),
  attachment_ids: Schema.optional(
    Schema.Array(Schema.String).pipe(
      Schema.filter((ids) =>
        ids.length > MAX_ATTACHMENT_IDS_PER_COMMENT
          ? `must hold at most ${MAX_ATTACHMENT_IDS_PER_COMMENT} ids`
          : new Set(ids).size !== ids.length
            ? "must not repeat an id"
            : undefined,
      ),
    ),
  ),
  // `null` is accepted and means "no parent", exactly as before — the old
  // handler skipped its check on both `undefined` and `null`.
  in_reply_to: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * Issue lookup (short id or UUID) + minRole proof on its board. For an
 * authenticated caller, a missing issue and an invisible board are both 404
 * "issue" (no existence leak); a visible board with an under-role caller is
 * 403. For an anonymous caller both are 401 (EFB-76) — see authz.ts.
 */
const fetchIssueForRole = (ref: string, pubkey: string | null, minRole: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const shortId = asShortId(ref);
    const row =
      shortId === null
        ? yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ?", [ref])
        : yield* db.queryFirst("SELECT * FROM issueCache WHERE short_id = ?", [shortId]);
    if (row === null) return yield* notVisible(pubkey, new NotFoundError({ reason: "issue" }));
    const issue = parseIssueRow(row);
    yield* authorizeBoardById(issue.board_id, pubkey, minRole).pipe(
      Effect.mapError((e) =>
        e._tag === "BoardOwnershipError" ? new NotFoundError({ reason: "issue" }) : e,
      ),
    );
    return issue;
  });

/**
 * Live attachments claimed by comments on this issue, keyed by comment id.
 * Merged in code — same no-JOIN posture as the issue list's cover
 * enrichment.
 */
const commentAttachmentsByComment = (issueId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db.queryAll(
      "SELECT * FROM issueAttachmentCache WHERE issue_id = ? AND comment_id IS NOT NULL AND deleted_at_ms IS NULL ORDER BY uploaded_at_ms ASC",
      [issueId],
    );
    const byComment = new Map<string, AttachmentShape[]>();
    for (const row of rows) {
      const attachment = parseAttachmentRow(row);
      if (attachment.comment_id === null) continue;
      const list = byComment.get(attachment.comment_id) ?? [];
      list.push(attachment);
      byComment.set(attachment.comment_id, list);
    }
    return byComment;
  });

export const makeCommentsRouter = (layerFor: LayerFor = bootstrap) => {
  const comments = new Hono<AppHonoEnv>();

  const runJson = async (
    c: Context<AppHonoEnv>,
    program: Effect.Effect<unknown, CommentsFailure, Db | AuditLog | BoardEmitter | Audience>,
    okStatus: 200 | 201 = 200,
  ) => {
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, okStatus);
  };

  // ── POST /issues/:id/comments ───────────────────────────────────────────
  comments.post("/issues/:id/comments", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const issue = yield* fetchIssueForRole(c.req.param("id"), pubkey, "contributor");
      const body = yield* parseRouteBody(c, PostCommentBody);

      const text = body.body;
      const db = yield* Db;

      // attachment_ids claim previously-uploaded issue-level attachments
      // for this comment. Each must be a live, unclaimed attachment on THIS
      // issue — cross-issue or double-claims fail the whole post. Shape
      // (string[], unique, bounded) is the schema's job; existence is this
      // route's, because it needs the resolved issue id.
      const attachmentIds: string[] = [...(body.attachment_ids ?? [])];
      for (const attachmentId of attachmentIds) {
        const row = yield* db.queryFirst(
          "SELECT * FROM issueAttachmentCache WHERE id = ? AND issue_id = ? AND comment_id IS NULL AND deleted_at_ms IS NULL",
          [attachmentId, issue.id],
        );
        if (row === null) return yield* new ValidationError({ reason: "attachment_ids" });
      }

      let inReplyTo: string | null = null;
      if (body.in_reply_to !== undefined && body.in_reply_to !== null) {
        // Must reference an existing comment on the same issue — no
        // dangling or cross-issue threads.
        const parent = yield* db.queryFirst(
          "SELECT * FROM commentCache WHERE id = ? AND issue_id = ?",
          [body.in_reply_to, issue.id],
        );
        if (parent === null) return yield* new ValidationError({ reason: "in_reply_to" });
        inReplyTo = body.in_reply_to;
      }

      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      const comment: CommentShape = {
        id: crypto.randomUUID(),
        issue_id: issue.id,
        author_pubkey: pubkey,
        body: text,
        body_format: "markdown",
        in_reply_to: inReplyTo,
        created_at_ms: now,
        // Publish is fired off the request path (EFB-24) — not landed yet.
        substrate_event_id: null,
      };
      yield* db.execute(
        "INSERT INTO commentCache (id, issue_id, author_pubkey, body, body_format, in_reply_to, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [comment.id, comment.issue_id, comment.author_pubkey, comment.body, comment.body_format, comment.in_reply_to, comment.created_at_ms],
      );
      const attachments: AttachmentShape[] = [];
      for (const attachmentId of attachmentIds) {
        // Claim guard repeated in the WHERE — a racing post loses quietly
        // rather than stealing the attachment.
        yield* db.execute(
          "UPDATE issueAttachmentCache SET comment_id = ? WHERE id = ? AND comment_id IS NULL AND deleted_at_ms IS NULL",
          [comment.id, attachmentId],
        );
        const row = yield* db.queryFirst(
          "SELECT * FROM issueAttachmentCache WHERE id = ? AND comment_id = ?",
          [attachmentId, comment.id],
        );
        if (row !== null) attachments.push(parseAttachmentRow(row));
      }
      yield* audit.record({
        event_type: "comment_created",
        actor: claims.login,
        details: { issue: issue.id, comment: comment.id },
      });
      yield* emitSecureBoardEvent(issue.board_id, {
        kind: "comment.created",
        board_id: issue.board_id,
        issue_id: issue.id,
        comment_id: comment.id,
        at_ms: now,
        payload: { comment },
      });
      return { comment: { ...comment, attachments } };
    });
    return runJson(c, program, 201);
  });

  // ── GET /issues/:id/comments — chronological with forward keyset ────────
  comments.get("/issues/:id/comments", async (c) => {
    const limitRaw = c.req.query("limit");
    const after = c.req.query("after");
    const program = Effect.gen(function* () {
      const issue = yield* fetchIssueForRole(
        c.req.param("id"),
        callerPubkeyOrNull(c.get("claims")),
        "viewer",
      );

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
      const attachmentsByComment = yield* commentAttachmentsByComment(issue.id);
      return {
        comments: rows.slice(0, limit).map((row) => {
          const comment = parseCommentRow(row);
          return { ...comment, attachments: attachmentsByComment.get(comment.id) ?? [] };
        }),
        total: count?.n ?? 0,
        has_more: rows.length > limit,
      };
    });
    return runJson(c, program);
  });

  // ── DELETE /comments/:id — author-only, atop the contributor floor ──────
  comments.delete("/comments/:id", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const db = yield* Db;
      const row = yield* db.queryFirst("SELECT * FROM commentCache WHERE id = ?", [
        c.req.param("id"),
      ]);
      if (row === null) return yield* new NotFoundError({ reason: "comment" });
      const comment = parseCommentRow(row);
      // Comments don't carry board_id — resolve it through the issue. The
      // issue can only be missing if it was deleted mid-flight (its comment
      // cascade would have taken this row too); an orphan row still deletes
      // on the author check alone.
      const issueRow = yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ?", [
        comment.issue_id,
      ]);
      if (issueRow !== null) {
        const issue = parseIssueRow(issueRow);
        yield* authorizeBoardById(issue.board_id, pubkey, "contributor").pipe(
          Effect.mapError((e) =>
            e._tag === "BoardOwnershipError" ? new NotFoundError({ reason: "comment" }) : e,
          ),
        );
      }
      if (comment.author_pubkey !== pubkey) {
        return yield* new ForbiddenError({ reason: "not-author" });
      }
      const audit = yield* AuditLog;
      yield* db.execute("DELETE FROM commentCache WHERE id = ?", [comment.id]);
      // The comment's attachments soft-delete with it (blobs stay on
      // Blossom, same as issue-attachment deletes).
      const deletedAt = yield* Clock.currentTimeMillis;
      yield* db.execute(
        "UPDATE issueAttachmentCache SET deleted_at_ms = ?, is_cover = 0 WHERE comment_id = ? AND deleted_at_ms IS NULL",
        [deletedAt, comment.id],
      );
      yield* audit.record({
        event_type: "comment_deleted",
        actor: claims.login,
        details: { comment: comment.id },
      });
      if (issueRow !== null) {
        const issue = parseIssueRow(issueRow);
        const now = yield* Clock.currentTimeMillis;
        yield* emitSecureBoardEvent(issue.board_id, {
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
