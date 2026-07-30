// /api/v0 attachments — issue file uploads against issueAttachmentCache,
// with blobs living on the Evenflow-managed default Blossom host (phase
// 18a; BYO buckets arrive in 18b).
//
// Upload accepts multipart form-data (field `file`) or JSON
// {file_b64, filename, content_type}. Validation failures return the
// ACTIONABLE shape {code, message, link} — the link points at the org's
// storage settings page, which ships fully in phase 18b (today it 404s
// gracefully into the SPA shell).
//
// Cover invariant: at most one non-deleted cover per issue. The PATCH
// handler clears the previous cover before setting the new one, and the
// partial unique index from migration 0006 backstops any race.
//
// Auth: reads run at "viewer" (anonymous works on public boards); upload,
// delete, and set-cover require "contributor".

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
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
  bootstrap,
  sha256Hex,
  type S3Target,
} from "../effects";
import { emitSecureBoardEvent } from "../audiences";
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
import { parseAttachmentRow, parseIssueRow, type AttachmentShape, type IssueShape } from "../shapes";
import {
  BLOSSOM_DEFAULT_MAX_BYTES,
  BYO_S3_MAX_BYTES,
  MAX_ATTACHMENTS_PER_ISSUE,
  formatBytes,
  isAllowedContentType,
  type StorageKind,
} from "../attachments";
import { deriveServerStorageKeys, decryptS3Creds } from "../lib/nostr-keys";
import { getOrgStorageConfig, type OrgStorageConfigShape } from "../storage-config";
import { asShortId } from "../slug";

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}
/** Upload rejections carry user-facing copy + a storage-settings link. */
class RejectedError extends Data.TaggedError("RejectedError")<{
  readonly code: "size_exceeded" | "count_exceeded" | "type_not_allowed";
  readonly message: string;
  readonly link: string;
}> {}
/** The org's saved BYO-S3 credentials could not be unwrapped at upload time. */
class StorageCredsError extends Data.TaggedError("StorageCredsError")<{
  readonly reason: string;
}> {}

type AttachmentsFailure =
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

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<AttachmentsFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "RejectedError":
        return c.json({ code: f.code, message: f.message, link: f.link }, 400);
      case "UnauthorizedError":
        return c.json({ error: "unauthorized", reason: f.reason }, 401);
      case "ForbiddenError":
        return c.json({ error: "forbidden", reason: f.reason }, 403);
      case "NotFoundError":
      case "BoardOwnershipError":
        return c.json({ error: "not-found", reason: f.reason }, 404);
      case "BlossomError":
        return c.json({ error: "storage-unavailable", reason: f.reason }, 502);
      case "S3Error":
        return c.json({ error: "storage-unavailable", reason: f.code ?? f.reason }, 502);
      case "StorageCredsError":
        return c.json({ error: "storage-unavailable", reason: f.reason }, 502);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

// The org's storage section lives inside the single /@handle/settings page,
// not at a /storage sub-path (that route doesn't exist). #storage scrolls
// to it — see StorageSection wraps a matching id.
const STORAGE_SETTINGS_HINT = (orgSlug: string | null) =>
  orgSlug === null ? "/boards" : `/@${orgSlug}/settings#storage`;

/** Decode standard or url-safe base64 into bytes; null on malformed input. */
const decodeB64 = (s: string): Uint8Array | null => {
  try {
    const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

const EXECUTABLE_HINTS = [/executable/, /msdownload/, /x-sh$/, /x-elf/, /java-archive/];
const looksExecutable = (contentType: string, filename: string): boolean =>
  EXECUTABLE_HINTS.some((re) => re.test(contentType)) ||
  /\.(exe|dll|sh|bat|cmd|com|scr|jar|app)$/i.test(filename);

interface UploadInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
}

/** Read the upload from multipart form-data (`file` field) or the JSON shape. */
const readUpload = (c: Context<AppHonoEnv>): Effect.Effect<UploadInput, ValidationError> =>
  Effect.tryPromise({
    try: async (): Promise<UploadInput | null> => {
      const requestContentType = c.req.header("Content-Type") ?? "";
      if (requestContentType.startsWith("multipart/form-data")) {
        const form = await c.req.formData();
        const entry = form.get("file");
        // Duck-typed File check — the Worker tsconfig has no DOM lib, so
        // `instanceof File` doesn't typecheck here.
        if (entry === null || typeof entry === "string") return null;
        const file = entry as { arrayBuffer(): Promise<ArrayBuffer>; name: string; type: string };
        return {
          bytes: new Uint8Array(await file.arrayBuffer()),
          filename: file.name === "" ? "unnamed" : file.name,
          contentType: file.type === "" ? "application/octet-stream" : file.type,
        };
      }
      const body = (await c.req.json()) as Record<string, unknown>;
      if (
        typeof body["file_b64"] !== "string" ||
        typeof body["filename"] !== "string" ||
        body["filename"] === "" ||
        typeof body["content_type"] !== "string"
      ) {
        return null;
      }
      const bytes = decodeB64(body["file_b64"]);
      if (bytes === null) return null;
      return { bytes, filename: body["filename"], contentType: body["content_type"] };
    },
    catch: () => new ValidationError({ reason: "upload-body" }),
  }).pipe(
    Effect.filterOrFail(
      (u): u is UploadInput => u !== null,
      () => new ValidationError({ reason: "upload-body" }),
    ),
  );

/** Resolve an issue inside the route's board scope at `minRole`. */
const fetchScopedIssue = (
  c: Context<AppHonoEnv>,
  pubkey: string | null,
  minRole: string,
) =>
  Effect.gen(function* () {
    const params = c.req.param() as Record<string, string | undefined>;
    const { board, org } = yield* resolveBoardScope(
      { org_slug: params["org_slug"], slug: params["slug"] ?? "" },
      pubkey,
      minRole,
    );
    const db = yield* Db;
    const ref = params["issue_ref"] ?? "";
    const shortId = asShortId(ref);
    const row =
      shortId === null
        ? yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ? AND board_id = ?", [ref, board.id])
        : yield* db.queryFirst("SELECT * FROM issueCache WHERE short_id = ? AND board_id = ?", [shortId, board.id]);
    if (row === null) return yield* new NotFoundError({ reason: "issue" });
    return { issue: parseIssueRow(row), board, org };
  });

/** Fetch a live attachment + its issue, proving `minRole` on the board. */
const fetchAttachment = (id: string, pubkey: string | null, minRole: string) =>
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
    yield* authorizeBoardById(issue.board_id, pubkey, minRole).pipe(
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

export const makeAttachmentsRouter = (layerFor: LayerFor = bootstrap) => {
  const attachments = new Hono<AppHonoEnv>();

  const runJson = async (
    c: Context<AppHonoEnv>,
    program: Effect.Effect<unknown, AttachmentsFailure, Db | AuditLog | BoardEmitter | Audience | Blossom | S3>,
    okStatus: 200 | 201 = 200,
  ) => {
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, okStatus);
  };

  // ── POST /boards/:slug/issues/:issue_ref/attachments — upload ───────────
  attachments.post("/boards/:slug/issues/:issue_ref/attachments", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const { issue, board, org } = yield* fetchScopedIssue(c, pubkey, "contributor");
      const upload = yield* readUpload(c);
      const link = STORAGE_SETTINGS_HINT(org?.slug ?? null);

      // Phase 18b: the board's org may route blobs to its own Blossom or S3
      // bucket. Lookup keys off board.org_id — the legacy (org-less) mount
      // can't see the org row but the board always knows its org.
      const storageCfg =
        board.org_id === null ? null : yield* getOrgStorageConfig(board.org_id);
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
      if (!isAllowedContentType(upload.contentType)) {
        return yield* new RejectedError({
          code: "type_not_allowed",
          message: looksExecutable(upload.contentType, upload.filename)
            ? `Executable files aren't allowed on Evenflow storage (${upload.contentType}).`
            : `${upload.contentType} isn't an accepted file type — images, PDFs, plain text, zip, and JSON are.`,
          link,
        });
      }
      const existing = yield* listLiveAttachments(issue.id);
      if (existing.length >= MAX_ATTACHMENTS_PER_ISSUE) {
        return yield* new RejectedError({
          code: "count_exceeded",
          message: `This issue already has ${MAX_ATTACHMENTS_PER_ISSUE} attachments — the cap per issue on Evenflow's default storage.`,
          link,
        });
      }

      const { url, sha256, storage_kind } = yield* uploadToConfiguredStorage(
        c.env.EVENFLOW_STORAGE_SECRET,
        storageCfg,
        upload,
      );

      const db = yield* Db;
      const audit = yield* AuditLog;
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
        actor: claims.login,
        details: { issue: issue.id, attachment: id, size: upload.bytes.byteLength },
      });
      yield* emitSecureBoardEvent(board.id, {
        kind: "issue.updated",
        board_id: board.id,
        issue_id: issue.id,
        at_ms: now,
        payload: { issue_id: issue.id, attachment_change: true },
      });
      return { attachment };
    });
    return runJson(c, program, 201);
  });

  // ── GET /boards/:slug/issues/:issue_ref/attachments — list ──────────────
  // Anonymous works when the board is public (viewer floor).
  attachments.get("/boards/:slug/issues/:issue_ref/attachments", async (c) => {
    const program = Effect.gen(function* () {
      const { issue } = yield* fetchScopedIssue(c, callerPubkeyOrNull(c.get("claims")), "viewer");
      const attachments_ = yield* listLiveAttachments(issue.id, true);
      return { attachments: attachments_ };
    });
    return runJson(c, program);
  });

  // ── PATCH /attachments/:id — {is_cover} ─────────────────────────────────
  attachments.patch("/attachments/:id", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const body = yield* Effect.tryPromise({
        try: () => c.req.json() as Promise<Record<string, unknown>>,
        catch: () => new ValidationError({ reason: "expected-json" }),
      });
      if (typeof body["is_cover"] !== "boolean") {
        return yield* new ValidationError({ reason: "is_cover" });
      }
      const is_cover = body["is_cover"];
      const { attachment, issue } = yield* fetchAttachment(c.req.param("id"), pubkey, "contributor");

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
        actor: claims.login,
        details: { attachment: attachment.id, is_cover },
      });
      yield* emitSecureBoardEvent(issue.board_id, {
        kind: "issue.updated",
        board_id: issue.board_id,
        issue_id: issue.id,
        at_ms: now,
        payload: { issue_id: issue.id, attachment_change: true },
      });
      return { attachment: { ...attachment, is_cover } };
    });
    return runJson(c, program);
  });

  // ── DELETE /attachments/:id — soft delete; the blob stays on Blossom ────
  attachments.delete("/attachments/:id", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { attachment, issue } = yield* fetchAttachment(
        c.req.param("id"),
        callerPubkey(claims),
        "contributor",
      );
      const db = yield* Db;
      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      yield* db.execute(
        "UPDATE issueAttachmentCache SET deleted_at_ms = ?, is_cover = 0 WHERE id = ?",
        [now, attachment.id],
      );
      yield* audit.record({
        event_type: "attachment_deleted",
        actor: claims.login,
        details: { attachment: attachment.id },
      });
      yield* emitSecureBoardEvent(issue.board_id, {
        kind: "issue.updated",
        board_id: issue.board_id,
        issue_id: issue.id,
        at_ms: now,
        payload: { issue_id: issue.id, attachment_change: true },
      });
      return { deleted: true };
    });
    return runJson(c, program);
  });

  return attachments;
};
