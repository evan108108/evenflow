// /api/v0 attachments — HTTP shell over src/actions/attachments.ts.
//
// EFB-98 split this file in two. Everything that decides what an attachment
// IS moved to the action module; what stays here is transport: pull the params
// off the request, read the upload, run requireCaller, call the action, map a
// failure to a status code.
//
// The two RAW READS below stay here deliberately. Upload accepts multipart
// form-data (field `file`) or JSON {file_b64, filename, content_type}, and the
// cover PATCH reads its own JSON; both are named in
// `scripts/boundary-allowlist.json` against THIS file, and both scanners
// resolve routes under `src/routes` only. A read that moved into the action
// module would leave its allowlist entry pointing at a route that no longer
// performs it — the entry would keep looking like it guarded something while
// guarding nothing. What moved is the POLICY those reads feed: size ceilings,
// the accepted-type decision, the per-issue cap.
//
// Validation failures return the ACTIONABLE shape {code, message, link} — the
// link points at the org's storage settings page.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Effect, Exit, Option } from "effect";

import { path } from "../routes-manifest";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { grantsOf } from "../http";
import { callerPubkeyOrNull, requireCaller } from "../authz";
import { ValidationError } from "../lib/errors";
import { makeRunJson } from "../lib/run-json";
import { actionInput } from "../actions/types";
import type { Claims } from "../effects";
import {
  createAttachment,
  deleteAttachment,
  downloadAttachment,
  listAttachments,
  updateAttachment,
  type AttachmentServices,
  type AttachmentsFailure,
  type UploadInput,
} from "../actions/attachments";

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
      // `status` is the upstream host's HTTP status, carried through so a
      // rate-limit (429) is distinguishable from an outage (5xx) or a
      // rejected blob (4xx) — previously every one of these collapsed to
      // the literal string "http" and the status was dropped on the floor.
      // The upstream `detail` is deliberately NOT surfaced: it names the
      // storage vendor, and routing stays an implementation detail in user
      // copy. It goes to the audit log instead (attachment_upload_failed).
      case "BlossomError":
        return c.json({ error: "storage-unavailable", reason: f.reason, status: f.status }, 502);
      case "S3Error":
        return c.json(
          { error: "storage-unavailable", reason: f.code ?? f.reason, status: f.status },
          502,
        );
      case "StorageCredsError":
        return c.json({ error: "storage-unavailable", reason: f.reason }, 502);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

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

/**
 * Assemble a raw-bytes Response from a DownloadedAttachment. Kept OUTSIDE
 * the route registration so the boundary scanner sees the handler span as
 * a small forwarding call — its shape is what parseRouteQuery-style
 * checkers expect from a route that does not read the query string.
 * Filename is doubled through RFC 5987's `filename*` form so non-ASCII
 * characters survive a copy round-trip.
 */
const buildDownloadResponse = (result: {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}): Response => {
  const safeAscii = result.filename.replace(/["\r\n]/g, "").replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(result.filename);
  const body = new Uint8Array(result.bytes.byteLength);
  body.set(result.bytes);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Content-Length": String(result.bytes.byteLength),
      "Content-Disposition": `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, max-age=60",
    },
  });
};

const runDownload = async (
  c: Context<AppHonoEnv>,
  layerFor: LayerFor,
): Promise<Response> => {
  const program = downloadAttachment(
    actionInput<undefined, Claims | null>(
      c.get("claims") ?? null,
      c.req.param(),
      undefined,
      { grants: grantsOf(c), orgSlug: c.req.param("org_slug") ?? null },
    ),
    c.env.EVENFLOW_STORAGE_SECRET,
  );
  const provided = Effect.provide(
    program as Effect.Effect<
      { bytes: Uint8Array; contentType: string; filename: string },
      AttachmentsFailure,
      never
    >,
    layerFor(c.env),
  );
  const exit = await Effect.runPromiseExit(provided);
  if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
  return buildDownloadResponse(exit.value);
};

export const makeAttachmentsRouter = (layerFor: LayerFor = bootstrap) => {
  const attachments = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<AttachmentsFailure, AttachmentServices>(layerFor, errorResponse);

  const orgSlug = (c: Context<AppHonoEnv>) => c.req.param("org_slug") ?? null;

  // ── POST /boards/:slug/issues/:issue_ref/attachments — upload ───────────
  //
  // `readUpload` is built here but NOT awaited (EFB-98 rule 10): the pre-split
  // handler resolved and authorized the issue BEFORE reading the upload, so a
  // caller who cannot see the issue still gets its 404/403 rather than a 400
  // about a body they were never entitled to send.
  attachments.post(path("attachment.create"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* createAttachment(
        actionInput(claims, c.req.param(), readUpload(c), { grants: grantsOf(c), orgSlug: orgSlug(c) }),
        c.env.EVENFLOW_STORAGE_SECRET,
      );
    });
    return runJson(c, program, 201);
  });

  // ── GET /boards/:slug/issues/:issue_ref/attachments — list ──────────────
  // Anonymous works when the board is public (viewer floor).
  attachments.get(path("attachment.list"), async (c) =>
    runJson(
      c,
      listAttachments(
        actionInput<undefined, Claims | null>(
          c.get("claims") ?? null,
          c.req.param(),
          undefined,
          { grants: grantsOf(c), orgSlug: orgSlug(c) },
        ),
      ),
    ),
  );

  // ── PATCH /attachments/:id — {is_cover} ─────────────────────────────────
  //
  // Read eagerly and NOT deferred, unlike the upload above: this handler has
  // always validated its body before looking the attachment up, so a bad
  // `is_cover` answers 400 even on an id that does not exist. Deferring would
  // flip an order the suite already observes.
  attachments.patch(path("attachment.update"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* Effect.tryPromise({
        try: () => c.req.json() as Promise<Record<string, unknown>>,
        catch: () => new ValidationError({ reason: "expected-json" }),
      });
      return yield* updateAttachment(
        actionInput(claims, c.req.param(), body, { grants: grantsOf(c), orgSlug: orgSlug(c) }),
      );
    });
    return runJson(c, program);
  });

  // ── GET /attachment/:id/download — bytes-back for readers on the board ─
  //
  // NOT `runJson` — this handler returns raw bytes, not JSON. Same layer
  // provider, same error mapping via errorResponse, but the success path
  // writes a Response with Content-Type and Content-Disposition instead
  // of `c.json(...)`. Anonymous callers work on public boards (viewer
  // floor), matching attachment.list's posture.
  attachments.get(path("attachment.download"), (c) => runDownload(c, layerFor));

  // ── DELETE /attachments/:id — soft delete; the blob stays on Blossom ────
  attachments.delete(path("attachment.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* deleteAttachment(
        actionInput(claims, c.req.param(), undefined, { grants: grantsOf(c), orgSlug: orgSlug(c) }),
      );
    });
    return runJson(c, program);
  });

  return attachments;
};
