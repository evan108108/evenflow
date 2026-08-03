/**
 * Comment actions — the worked example for the EFB-98 action split.
 *
 * Everything here is business logic: it takes a plain input record, talks to
 * the database through Effect services, and returns a value. It imports no
 * Hono and never sees a request. src/routes/comments.ts is the HTTP shell that
 * extracts params, parses the body, calls one of these, and formats the
 * result.
 *
 * The pattern, for the files that follow this one:
 *
 *   - The DOMAIN lives here: the request schema, the failure union, the
 *     lookup helpers, the actions. A schema belongs with the logic that
 *     consumes it, and the route imports it back for parseRouteBody so
 *     check:boundary keeps seeing the body read exactly where it always has.
 *   - The HTTP MAPPING stays in the route: errorResponse turns this file's
 *     failure union into status codes, which is the one thing that genuinely
 *     is transport.
 *   - An action taking `ActionInput` is guaranteed a caller — the route ran
 *     requireCaller and passed the result. One taking `PublicActionInput` can
 *     be reached anonymously and says so in its signature.
 *   - Bodies moved VERBATIM. Every comment, every ordering decision and every
 *     failure reason below is the pre-split code; the only edits are reading
 *     params/body/claims off `input` instead of off a Context.
 */

import { Clock, Data, Effect, Schema } from "effect";

import { AuditLog, Audience, BoardEmitter, Db, DbError } from "../effects";
import { emitSecureBoardEvent } from "../audiences";
import {
  ForbiddenError,
  UnauthorizedError,
  authorizeBoardById,
  callerPubkey,
  notVisible,
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
import { ProvenanceFromCaller, ProvenanceFromSystem } from "../lib/route-body";
import type { ActionInput, PublicActionInput } from "./types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Attachments one comment may claim — same ceiling as the per-issue cap. */
const MAX_ATTACHMENT_IDS_PER_COMMENT = 20;

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}

export type CommentsFailure =
  | ValidationError
  | NotFoundError
  | ForbiddenError
  | UnauthorizedError
  | BoardOwnershipError
  | DbError;

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
export const fetchIssueForRole = (ref: string, pubkey: string | null, minRole: string) =>
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
export const commentAttachmentsByComment = (issueId: string) =>
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

/** Services every comment action needs. */
export type CommentServices = Db | AuditLog | BoardEmitter | Audience;

/** POST /issue/:id/comments — create a comment, claiming any attachments. */
export const createComment = (
  input: ActionInput<typeof PostCommentBody.Type>,
): Effect.Effect<{ comment: CommentShape & { attachments: AttachmentShape[] } }, CommentsFailure, CommentServices> =>
  Effect.gen(function* () {
    const pubkey = callerPubkey(input.claims);
  const issue = yield* fetchIssueForRole(input.params["id"] ?? "", pubkey, "contributor");
  const body = input.body;

  const text = body.body;
  const db = yield* Db;

  // attachment_ids claim previously-uploaded issue-level attachments
  // for this comment. Each must be a live, unclaimed attachment on THIS
  // issue — cross-issue or double-input.claims fail the whole post. Shape
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
    actor: input.claims.login,
    details: { issue: issue.id, comment: comment.id },
  });
  // The caller IS the author here — `author_pubkey` above is
  // `callerPubkey(input.claims)`, the same derivation `ProvenanceFromCaller`
  // uses — so the 30552's `author_pubkey` is byte-identical to what the
  // stored-actor read produced before EFB-63, and now says so at the one
  // frame that can prove it (EFB-63).
  yield* emitSecureBoardEvent(
    issue.board_id,
    {
      kind: "comment.created",
      board_id: issue.board_id,
      issue_id: issue.id,
      comment_id: comment.id,
      at_ms: now,
      payload: { comment },
    },
    ProvenanceFromCaller(input.claims),
  );
  return { comment: { ...comment, attachments } };
  });

/** GET /issue/:id/comments — chronological, forward keyset. Anonymous-readable. */
export const listComments = (
  input: PublicActionInput,
): Effect.Effect<unknown, CommentsFailure, CommentServices> =>
  Effect.gen(function* () {
    const limitRaw = input.query["limit"];
    const after = input.query["after"];
  const issue = yield* fetchIssueForRole(
    input.params["id"] ?? "",
    input.claims === null ? null : callerPubkey(input.claims),
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

/** DELETE /comment/:id — author-only, atop the contributor floor. */
export const deleteComment = (
  input: ActionInput,
): Effect.Effect<unknown, CommentsFailure, CommentServices> =>
  Effect.gen(function* () {
    const pubkey = callerPubkey(input.claims);
  const db = yield* Db;
  const row = yield* db.queryFirst("SELECT * FROM commentCache WHERE id = ?", [
    input.params["id"] ?? "",
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
    actor: input.claims.login,
    details: { comment: comment.id },
  });
  if (issueRow !== null) {
    const issue = parseIssueRow(issueRow);
    const now = yield* Clock.currentTimeMillis;
    // NOT the caller, though the caller is in scope and deleting is
    // certainly an act. The 30552's actor slot is the comment's AUTHOR,
    // and a tombstone that named the deleter would publish a signed,
    // unretractable claim that they wrote someone else's comment — EFB-33's
    // failure at a new callsite. A tombstone is administrative: nobody to
    // attribute, which is what `ProvenanceFromSystem` means. This is also
    // what keeps the wire byte-identical — the pre-EFB-63 publisher found
    // no comment row on this payload and emitted the empty pubkey too.
    yield* emitSecureBoardEvent(
      issue.board_id,
      {
        kind: "comment.deleted",
        board_id: issue.board_id,
        issue_id: issue.id,
        comment_id: comment.id,
        at_ms: now,
        payload: { comment_id: comment.id, issue_id: issue.id },
      },
      ProvenanceFromSystem(),
    );
  }
  return { deleted: true };
  });
