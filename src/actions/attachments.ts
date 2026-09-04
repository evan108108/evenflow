/**
 * Issue attachment actions — the business half of src/routes/attachments.ts,
 * split out by EFB-98.
 *
 * Uploads land on the Evenflow-managed default Blossom host or, when the
 * board's org has configured one, its own Blossom or S3-compatible bucket
 * (phase 18a/18b). Everything here takes a plain input record, talks to the
 * database and the storage services through Effect, and returns a value. It
 * imports no Hono and never sees a Context.
 *
 * WHAT STAYED IN THE ROUTE, and why it matters here more than elsewhere:
 * this family has TWO raw reads pinned by `scripts/boundary-allowlist.json`
 * to `src/routes/attachments.ts` — the multipart/JSON upload read and the
 * hand-rolled JSON read on the cover PATCH. Both scanners resolve routes
 * under `src/routes` only, so a read that moved here would leave its
 * allowlist entry describing a route that no longer performs it: the entry
 * keeps looking like it guards something and guards nothing. The READS stay
 * there; the POLICY those reads feed — size ceilings, the accepted-type
 * decision, the per-issue cap — is business logic and lives here.
 *
 * Cover invariant: at most one non-deleted cover per issue. The PATCH action
 * clears the previous cover before setting the new one, and the partial unique
 * index from migration 0006 backstops any race.
 *
 * Auth: reads run at "viewer" (anonymous works on public boards); upload,
 * delete, and set-cover require "contributor".
 *
 * Bodies moved VERBATIM. Every comment, ordering decision and failure reason
 * below is the pre-split code; the only edits read params/body/claims off an
 * input record instead of off a Context.
 */

import { Clock, Data, Effect } from "effect";

import {
  AuditLog,
  Audience,
  Blossom,
  BlossomError,
  BoardEmitter,
  Db,
  DbError,
  S3,
  S3Error,
  sha256Hex,
  type S3Target,
} from "../effects";
import { emitSecureBoardEvent } from "../audiences";
import {
  ForbiddenError,
  UnauthorizedError,
  authorizeBoardById,
  callerPubkey,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { NotFoundError, ValidationError } from "../lib/errors";
import { parseAttachmentRow, parseIssueRow, type AttachmentShape } from "../shapes";
import {
  BLOSSOM_DEFAULT_MAX_BYTES,
  BYO_S3_MAX_BYTES,
  MAX_ATTACHMENTS_PER_ISSUE,
  formatBytes,
  isAllowedContentType,
  needsByoStorage,
  type StorageKind,
} from "../attachments";
import { deriveServerStorageKeys, decryptS3Creds } from "../lib/nostr-keys";
import { getOrgStorageConfig, type OrgStorageConfigShape } from "../storage-config";
import { asShortId } from "../slug";
import type { Grant } from "../scopes";
import type { ActionInput, PublicActionInput } from "./types";

/** Upload rejections carry user-facing copy + a storage-settings link. */
export class RejectedError extends Data.TaggedError("RejectedError")<{
  readonly code: "size_exceeded" | "count_exceeded" | "type_not_allowed";
  readonly message: string;
  readonly link: string;
}> {}
/** The org's saved BYO-S3 credentials could not be unwrapped at upload time. */
export class StorageCredsError extends Data.TaggedError("StorageCredsError")<{
  readonly reason: string;
}> {}

export type AttachmentsFailure =
  | ValidationError
  | NotFoundError
  | RejectedError
  | BoardOwnershipError
  | UnauthorizedError
  | ForbiddenError
  | BlossomError
  | S3Error
  | StorageCredsError
  | DbError;

/** Everything the attachment actions ask the layer for. */
export type AttachmentServices = Db | AuditLog | BoardEmitter | Audience | Blossom | S3;

// The org's storage section lives inside the single /@handle/settings page,
// not at a /storage sub-path (that route doesn't exist). #storage scrolls
// to it — see StorageSection wraps a matching id.
const STORAGE_SETTINGS_HINT = (orgSlug: string | null) =>
  orgSlug === null ? "/boards" : `/@${orgSlug}/settings#storage`;

const EXECUTABLE_HINTS = [/executable/, /msdownload/, /x-sh$/, /x-elf/, /java-archive/];
const looksExecutable = (contentType: string, filename: string): boolean =>
  EXECUTABLE_HINTS.some((re) => re.test(contentType)) ||
  /\.(exe|dll|sh|bat|cmd|com|scr|jar|app)$/i.test(filename);

/**
 * The decoded upload, however it arrived on the wire.
 *
 * Declared here with the logic that consumes it; the route imports it back for
 * the reader that produces it, the same way a body schema lives with its
 * action and the route imports it for the parse.
 */
export interface UploadInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
}

/** Resolve an issue inside the route's board scope at `minRole`. */
const fetchScopedIssue = (
  input: Pick<PublicActionInput<unknown>, "orgSlug" | "params" | "grants">,
  pubkey: string | null,
  minRole: string,
) =>
  Effect.gen(function* () {
    const { board, org } = yield* resolveBoardScope(
      { org_slug: input.orgSlug ?? undefined, slug: input.params["slug"] ?? "" },
      pubkey,
      minRole, input.grants,);
    const db = yield* Db;
    const ref = input.params["issue_ref"] ?? "";
    const shortId = asShortId(ref);
    const row =
      shortId === null
        ? yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ? AND board_id = ?", [ref, board.id])
        : yield* db.queryFirst("SELECT * FROM issueCache WHERE short_id = ? AND board_id = ?", [shortId, board.id]);
    if (row === null) return yield* new NotFoundError({ reason: "issue" });
    return { issue: parseIssueRow(row), board, org };
  });

/** Fetch a live attachment + its issue, proving `minRole` on the board. */
const fetchAttachment = (
  id: string,
  pubkey: string | null,
  minRole: string,
  grants: readonly Grant[] | null,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst(
      "SELECT * FROM issueAttachmentCache WHERE id = ? AND deleted_at_ms IS NULL",
      [id],
    );
    if (row === null) return yield* new NotFoundError({ reason: "attachment" });
    const attachment = parseAttachmentRow(row);
    const issueRow = yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ?", [attachment.issue_id]);
    if (issueRow === null) return yield* new NotFoundError({ reason: "attachment" });
    const issue = parseIssueRow(issueRow);
    yield* authorizeBoardById(issue.board_id, pubkey, minRole, grants).pipe(
      Effect.mapError((e) =>
        e._tag === "BoardOwnershipError" ? new NotFoundError({ reason: "attachment" }) : e,
      ),
    );
    return { attachment, issue };
  });

/**
 * Live attachments on an issue. `issueLevelOnly` restricts to rows no
 * comment has claimed (the Files panel view); the unrestricted form backs
 * the per-issue upload cap, which comment attachments count toward.
 */
const listLiveAttachments = (issueId: string, issueLevelOnly = false) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db.queryAll(
      issueLevelOnly
        ? "SELECT * FROM issueAttachmentCache WHERE issue_id = ? AND comment_id IS NULL AND deleted_at_ms IS NULL ORDER BY uploaded_at_ms ASC"
        : "SELECT * FROM issueAttachmentCache WHERE issue_id = ? AND deleted_at_ms IS NULL ORDER BY uploaded_at_ms ASC",
      [issueId],
    );
    return rows.map(parseAttachmentRow);
  });

/**
 * Route the blob to wherever the org configured (phase 18b): the default
 * Blossom host, the org's own Blossom, or the org's S3-compatible bucket
 * (creds NIP-44-unwrapped here, held only for the duration of the PUT).
 * The returned URL is where the blob actually lives — no proxying.
 */
const uploadToConfiguredStorage = (
  storageSecret: string | undefined,
  cfg: OrgStorageConfigShape | null,
  upload: UploadInput,
): Effect.Effect<
  { url: string; sha256: string; storage_kind: StorageKind },
  BlossomError | S3Error | StorageCredsError,
  Blossom | S3
> =>
  Effect.gen(function* () {
    if (cfg !== null && cfg.kind === "blossom" && cfg.blossom_url !== null) {
      const blossom = yield* Blossom;
      const result = yield* blossom.uploadTo(
        cfg.blossom_url,
        upload.bytes,
        upload.contentType,
        upload.filename,
      );
      return { ...result, storage_kind: "blossom_byo" as StorageKind };
    }
    if (cfg !== null && cfg.kind === "s3") {
      const keys = deriveServerStorageKeys(storageSecret);
      if (keys === null) return yield* new StorageCredsError({ reason: "server-key" });
      if (cfg.s3_creds_ciphertext === null || cfg.s3_creds_sender_pubkey === null) {
        return yield* new StorageCredsError({ reason: "missing-creds" });
      }
      const creds = decryptS3Creds(keys, cfg.s3_creds_ciphertext, cfg.s3_creds_sender_pubkey);
      if (creds === null) return yield* new StorageCredsError({ reason: "creds-unreadable" });
      const target: S3Target = {
        endpoint: cfg.s3_endpoint ?? "",
        region: cfg.s3_region ?? "",
        bucket: cfg.s3_bucket ?? "",
        pathStyle: cfg.s3_path_style,
        accessKeyId: creds.access_key_id,
        secretAccessKey: creds.secret_access_key,
      };
      const sha256 = yield* Effect.promise(() => sha256Hex(upload.bytes));
      const s3 = yield* S3;
      const { url } = yield* s3.putObject(
        target,
        `evenflow/${cfg.org_id}/${sha256}`,
        upload.bytes,
        upload.contentType,
      );
      return { url, sha256, storage_kind: "s3_byo" as StorageKind };
    }
    const blossom = yield* Blossom;
    const result = yield* blossom.upload(upload.bytes, upload.contentType, upload.filename);
    return { ...result, storage_kind: "blossom_default" as StorageKind };
  });

// ── POST /boards/:slug/issues/:issue_ref/attachments — upload ───────────
/**
 * `storageSecret` is `c.env.EVENFLOW_STORAGE_SECRET`, read in the route and
 * passed explicitly: server configuration is ambient and identical for every
 * caller, so it is a parameter rather than a field on the request-shaped input.
 *
 * `input.body` is a DEFERRED read (EFB-98 rule 10). The pre-split handler ran
 * `fetchScopedIssue` BEFORE reading the upload, so a caller who cannot see the
 * issue gets its 404/403 rather than a 400 about a body they were never
 * entitled to send. The reader is built in the route — where the allowlist
 * needs it — and yielded here, one line below the gate, exactly where it ran
 * before.
 */
export const createAttachment = (
  input: ActionInput<Effect.Effect<UploadInput, ValidationError, never>>,
  storageSecret: string | undefined,
) =>
  Effect.gen(function* () {
    const pubkey = callerPubkey(input.claims);
    const { issue, board, org } = yield* fetchScopedIssue(input, pubkey, "contributor");
    const upload = yield* input.body;
    const link = STORAGE_SETTINGS_HINT(org?.slug ?? null);

    // Phase 18b: the board's org may route blobs to its own Blossom or S3
    // bucket. Lookup keys off board.org_id — the legacy (org-less) mount
    // can't see the org row but the board always knows its org.
    const storageCfg = board.org_id === null ? null : yield* getOrgStorageConfig(board.org_id);
    const byob = storageCfg !== null && storageCfg.kind !== "default";

    const maxBytes = byob ? BYO_S3_MAX_BYTES : BLOSSOM_DEFAULT_MAX_BYTES;
    if (upload.bytes.byteLength > maxBytes) {
      return yield* new RejectedError({
        code: "size_exceeded",
        message: byob
          ? `This file is ${formatBytes(upload.bytes.byteLength)} — Evenflow caps uploads to your storage at ${formatBytes(BYO_S3_MAX_BYTES)} per file.`
          : `This file is ${formatBytes(upload.bytes.byteLength)} — Evenflow's default storage caps at ${formatBytes(BLOSSOM_DEFAULT_MAX_BYTES)} per file. Set up your own bucket to upload larger files.`,
        link,
      });
    }
    if (!isAllowedContentType(upload.contentType, byob)) {
      // Three refusals, most specific first. The middle one is EFB-80's:
      // a type we'd happily take on a BYO bucket but the default host
      // rejects. It earns a "set up a bucket" nudge rather than a flat
      // "not accepted", and it never names the host — routing stays an
      // implementation detail in user copy.
      const message = looksExecutable(upload.contentType, upload.filename)
        ? `Executable files aren't allowed on Evenflow storage (${upload.contentType}).`
        : needsByoStorage(upload.contentType)
          ? `${upload.contentType} files need your own storage bucket — Evenflow's default storage takes images only.`
          : byob
            ? `${upload.contentType} isn't an accepted file type — images, PDFs, plain text, markdown, zip, and JSON are.`
            : `${upload.contentType} isn't an accepted file type — Evenflow's default storage takes images. With your own bucket you can also attach PDFs, plain text, markdown, zip, and JSON.`;
      return yield* new RejectedError({ code: "type_not_allowed", message, link });
    }
    const existing = yield* listLiveAttachments(issue.id);
    if (existing.length >= MAX_ATTACHMENTS_PER_ISSUE) {
      return yield* new RejectedError({
        code: "count_exceeded",
        message: `This issue already has ${MAX_ATTACHMENTS_PER_ISSUE} attachments — the cap per issue on Evenflow's default storage.`,
        link,
      });
    }

    const audit = yield* AuditLog;
    // Record storage failures, not just successes. AuditLog.record writes a
    // JSON line to Workers observability, so this is simultaneously the
    // structured log and the queryable signal — without it a degrading
    // default host produces no server-side trace at all, and the only
    // symptom is users reporting a 502 we can't attribute.
    const { url, sha256, storage_kind } = yield* uploadToConfiguredStorage(
      storageSecret,
      storageCfg,
      upload,
    ).pipe(
      Effect.tapError((e) =>
        audit.record({
          event_type: "attachment_upload_failed",
          actor: input.claims.login,
          issue: issue.id,
          details: {
            storage_kind: byob ? storageCfg?.kind ?? "default" : "default",
            error: e._tag,
            reason: e._tag === "S3Error" ? e.code ?? e.reason : e.reason,
            // Upstream status + message: the operator-facing half of the
            // failure, kept out of the HTTP response on purpose.
            status: e._tag === "StorageCredsError" ? undefined : e.status,
            detail: e._tag === "StorageCredsError" ? undefined : e.detail,
            size: upload.bytes.byteLength,
            content_type: upload.contentType,
          },
        }),
      ),
    );

    const db = yield* Db;
    const now = yield* Clock.currentTimeMillis;
    const id = crypto.randomUUID();
    const attachment: AttachmentShape = {
      id,
      issue_id: issue.id,
      comment_id: null,
      blob_url: url,
      sha256,
      filename: upload.filename,
      content_type: upload.contentType,
      size_bytes: upload.bytes.byteLength,
      storage_kind,
      is_cover: false,
      uploaded_by: pubkey,
      uploaded_at_ms: now,
      deleted_at_ms: null,
    };
    yield* db.execute(
      "INSERT INTO issueAttachmentCache (id, issue_id, comment_id, blob_url, sha256, filename, content_type, size_bytes, storage_kind, is_cover, uploaded_by, uploaded_at_ms, deleted_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, issue.id, null, url, sha256, upload.filename, upload.contentType, upload.bytes.byteLength, storage_kind, 0, pubkey, now, null],
    );
    yield* audit.record({
      event_type: "attachment_uploaded",
      actor: input.claims.login,
      details: { issue: issue.id, attachment: id, size: upload.bytes.byteLength },
    });
    yield* emitSecureBoardEvent(
      board.id,
      {
        kind: "issue.updated",
        board_id: board.id,
        issue_id: issue.id,
        at_ms: now,
        payload: { issue_id: issue.id, attachment_change: true },
      },
      null,
    );
    return { attachment };
  });

// ── GET /boards/:slug/issues/:issue_ref/attachments — list ──────────────
// Anonymous works when the board is public (viewer floor). The nullable
// caller is in the signature rather than a case that happens to work.
export const listAttachments = (input: PublicActionInput) =>
  Effect.gen(function* () {
    const { issue } = yield* fetchScopedIssue(
      input,
      input.claims === null ? null : callerPubkey(input.claims),
      "viewer",
    );
    const attachments_ = yield* listLiveAttachments(issue.id, true);
    return { attachments: attachments_ };
  });

// ── PATCH /attachments/:id — {is_cover} ─────────────────────────────────
/**
 * NOT a deferred body, deliberately (EFB-98 rule 10 — preserve means preserve,
 * not "always defer"). The pre-split handler read and validated the body
 * ABOVE `fetchAttachment`, so a malformed body has always beaten the 404 on
 * this route, and tests/attachments.test.ts pins both halves separately: a bad
 * `is_cover` on a live id answers 400, a good body on an unknown id answers
 * 404. Deferring here would flip an order the suite already observes.
 *
 * The route performs the raw read (pinned to the route file by the boundary
 * allowlist) and hands over the undecoded record; the `is_cover` policy is
 * business logic and runs here, first, exactly as before.
 */
export const updateAttachment = (input: ActionInput<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const pubkey = callerPubkey(input.claims);
    if (typeof input.body["is_cover"] !== "boolean") {
      return yield* new ValidationError({ reason: "is_cover" });
    }
    const is_cover = input.body["is_cover"];
    const { attachment, issue } = yield* fetchAttachment(
      input.params["id"] ?? "",
      pubkey,
      "contributor", input.grants,);

    const db = yield* Db;
    const audit = yield* AuditLog;
    const now = yield* Clock.currentTimeMillis;
    if (is_cover) {
      // Clear-then-set keeps the partial unique index happy; the index
      // backstops racing writers.
      yield* db.execute(
        "UPDATE issueAttachmentCache SET is_cover = 0 WHERE issue_id = ? AND is_cover = 1 AND deleted_at_ms IS NULL",
        [attachment.issue_id],
      );
      yield* db.execute("UPDATE issueAttachmentCache SET is_cover = 1 WHERE id = ?", [attachment.id]);
    } else {
      yield* db.execute("UPDATE issueAttachmentCache SET is_cover = 0 WHERE id = ?", [attachment.id]);
    }
    yield* audit.record({
      event_type: "attachment_cover_set",
      actor: input.claims.login,
      details: { attachment: attachment.id, is_cover },
    });
    yield* emitSecureBoardEvent(
      issue.board_id,
      {
        kind: "issue.updated",
        board_id: issue.board_id,
        issue_id: issue.id,
        at_ms: now,
        payload: { issue_id: issue.id, attachment_change: true },
      },
      null,
    );
    return { attachment: { ...attachment, is_cover } };
  });

// ── DELETE /attachments/:id — soft delete; the blob stays on Blossom ────
export const deleteAttachment = (input: ActionInput) =>
  Effect.gen(function* () {
    const { attachment, issue } = yield* fetchAttachment(
      input.params["id"] ?? "",
      callerPubkey(input.claims),
      "contributor", input.grants,);
    const db = yield* Db;
    const audit = yield* AuditLog;
    const now = yield* Clock.currentTimeMillis;
    yield* db.execute(
      "UPDATE issueAttachmentCache SET deleted_at_ms = ?, is_cover = 0 WHERE id = ?",
      [now, attachment.id],
    );
    yield* audit.record({
      event_type: "attachment_deleted",
      actor: input.claims.login,
      details: { attachment: attachment.id },
    });
    yield* emitSecureBoardEvent(
      issue.board_id,
      {
        kind: "issue.updated",
        board_id: issue.board_id,
        issue_id: issue.id,
        at_ms: now,
        payload: { issue_id: issue.id, attachment_change: true },
      },
      null,
    );
    return { deleted: true };
  });
