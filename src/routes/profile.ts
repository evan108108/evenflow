// /api/v0 profile — HTTP shell over src/actions/profile.ts.
//
// EFB-98 split this file in two. What stays here is transport: the 401, the
// bearer, the raw reads, errorResponse, runJson.
//
// THE RAW READS STAY HERE, and that is load-bearing rather than stylistic.
// POST /profile/picture and PUT /profile/me are on scripts/boundary-allowlist.json
// and GET /profile is on the query allowlist, every entry pinned to
// `src/routes/profile.ts` — and both checkers scan src/routes as TEXT. Move a
// read into the action module and the entry stops describing anything real
// while the checker keeps exiting 0: detected debt silently downgraded to
// declared (EFB-98 rule 11). The reads are built here and handed over as
// un-run Effects; the POLICY over what they produce is business logic and
// lives in the action (rule 12).

import { Hono } from "hono";
import { path } from "../routes-manifest";
import type { Context } from "hono";
import { Cause, Effect, Option } from "effect";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { ValidationError } from "../lib/errors";
import { makeRunJson } from "../lib/run-json";
import { actionInput } from "../actions/types";
import {
  createProfilePicture,
  getMyProfile,
  getProfile,
  listProfiles,
  setMyProfile,
  type ProfileFailure,
  type ProfileServices,
  type UploadedImage,
} from "../actions/profile";

// Re-exported for tests/profile.test.ts, which reaches for the caps rather
// than hard-coding them. The values live with the logic that enforces them.
export { BULK_MAX, PROFILE_CACHE_TTL_MS, MAX_UPLOAD_BYTES, ALLOWED_IMAGE_TYPES } from "../actions/profile";
export type { ProfileShape } from "../actions/profile";

const BEARER_PREFIX = "Bearer ";

/**
 * This router's OWN failure mapping, deliberately not the shared errorResponse
 * from ./errors: a FourAError here answers 502 `4a-<reason>`, and the shared
 * one has no such arm. Rule 3 — failure-union-to-status-code is transport.
 */
const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<ProfileFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "FourAError":
        return c.json({ error: "substrate", reason: `4a-${f.reason}` }, 502);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

/**
 * The raw JSON read for PUT /profile/me, kept in this file per rule 11.
 *
 * Deliberately NOT `readJsonBody` from ./errors: that helper is byte-identical
 * in behaviour, but this route is on the allowlist under its own hand-rolled
 * read, and swapping the spelling during a migration is the kind of quiet
 * change that makes a diff unreadable as "the same code".
 */
const readProfileBody = (c: Context<AppHonoEnv>) =>
  Effect.tryPromise({
    try: () => c.req.json() as Promise<Record<string, unknown>>,
    catch: () => new ValidationError({ reason: "expected-json" }),
  }).pipe(
    Effect.filterOrFail(
      (b): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b),
      () => new ValidationError({ reason: "expected-json-object" }),
    ),
  );

/**
 * The raw image read for POST /profile/picture — multipart or base64 JSON.
 *
 * Everything here is a READ: getting bytes and a claimed content type off the
 * request. What those bytes are ALLOWED to be — type, emptiness, size — is
 * policy and lives in the action. That split is rule 12, and this is the case
 * it was written from.
 */
const readUploadedImage = (
  c: Context<AppHonoEnv>,
  contentTypeHeader: string,
): Effect.Effect<UploadedImage, ValidationError, never> =>
  Effect.gen(function* () {
    let bytes: Uint8Array;
    let imageType: string;

    if (contentTypeHeader === "multipart/form-data") {
      const form = yield* Effect.tryPromise({
        try: () => c.req.formData(),
        catch: () => new ValidationError({ reason: "expected-multipart" }),
      });
      // FormDataEntryValue is string | File; workers-types has no global
      // File to instanceof against, so duck-type on the Blob surface.
      const entry = form.get("file") as { type?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | string | null;
      if (entry === null || typeof entry === "string" || typeof entry.arrayBuffer !== "function") {
        return yield* new ValidationError({ reason: "missing-file" });
      }
      imageType = (entry.type ?? "").split(";")[0]!.trim().toLowerCase();
      bytes = new Uint8Array(yield* Effect.promise(() => entry.arrayBuffer!()));
    } else {
      const body = yield* Effect.tryPromise({
        try: () => c.req.json() as Promise<Record<string, unknown>>,
        catch: () => new ValidationError({ reason: "expected-json" }),
      });
      if (typeof body["image_b64"] !== "string" || body["image_b64"] === "") {
        return yield* new ValidationError({ reason: "image_b64" });
      }
      if (typeof body["content_type"] !== "string") {
        return yield* new ValidationError({ reason: "content_type" });
      }
      imageType = body["content_type"].split(";")[0]!.trim().toLowerCase();
      try {
        const bin = atob(body["image_b64"]);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch {
        return yield* new ValidationError({ reason: "image_b64-not-base64" });
      }
    }
    return { bytes, imageType };
  });

export const makeProfileRouter = (layerFor: LayerFor = bootstrap) => {
  const profile = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<ProfileFailure, ProfileServices>(layerFor, errorResponse);

  // This router answers `missing-authorization`, where `requireCaller` answers
  // `authentication-required`. Both are wire-visible strings and a mechanical
  // migration may not change one into the other (BOUNDARY_DISCIPLINE.md:244),
  // so the check stays exactly as it was rather than being normalised to the
  // helper every other family uses.
  const unauthorized = (c: Context<AppHonoEnv>) =>
    c.json({ error: "unauthorized", reason: "missing-authorization" }, 401);

  // The bearer, sliced the way this file has always sliced it. Deliberately
  // not `c.get("token")`: that is set by middleware and need not be
  // character-identical to this, and the value is handed to 4a as a
  // credential — not somewhere to discover a difference.
  const bearerOf = (c: Context<AppHonoEnv>) =>
    (c.req.header("Authorization") ?? "").slice(BEARER_PREFIX.length).trim();

  // ── GET /profile/me ─────────────────────────────────────────────────────
  profile.get(path("profile.me.get"), async (c) => {
    const claims = c.get("claims");
    if (claims === undefined) return unauthorized(c);
    return runJson(
      c,
      getMyProfile(actionInput(claims, c.req.param(), undefined, { token: bearerOf(c) })),
    );
  });

  // ── POST /profile/picture ───────────────────────────────────────────────
  // Stage a profile picture: validate, proxy the bytes to 4a's blob store,
  // return the immutable URL. Deliberately does NOT publish a kind 0 — the
  // URL only reaches the substrate when the user Saves (PUT /profile/me),
  // so the UI can preview before anything goes public.
  //
  // The read is constructed here and run inside the action. NOT a rule-10
  // deferral — nothing gates above it, and the action yields it first, exactly
  // where it has always run. It travels as an Effect so the raw markers stay
  // in this file (rule 11) while the policy over the result lives with the
  // logic that owns it (rule 12).
  profile.post(path("profile.picture.create"), async (c) => {
    const claims = c.get("claims");
    if (claims === undefined) return unauthorized(c);
    const contentTypeHeader = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    return runJson(
      c,
      createProfilePicture(
        actionInput(claims, c.req.param(), readUploadedImage(c, contentTypeHeader), {
          token: bearerOf(c),
        }),
      ),
    );
  });

  // ── PUT /profile/me ─────────────────────────────────────────────────────
  // Full replacement of the four kind-0 fields: publish to 4a first (the
  // substrate is the source of truth), cache only what actually published.
  profile.put(path("profile.me.set"), async (c) => {
    const claims = c.get("claims");
    if (claims === undefined) return unauthorized(c);
    return runJson(
      c,
      setMyProfile(
        actionInput(claims, c.req.param(), readProfileBody(c), { token: bearerOf(c) }),
      ),
    );
  });

  // ── GET /profile?pubkeys=a,b,c — bulk resolve for chip rendering ────────
  // Registered before /profile/:pubkey so the bare path wins the match.
  profile.get(path("profile.list"), async (c) =>
    runJson(
      c,
      listProfiles(
        actionInput(null, c.req.param(), undefined, { query: c.req.query() }),
      ),
    ),
  );

  // ── GET /profile/:pubkey ────────────────────────────────────────────────
  profile.get(path("profile.get"), async (c) =>
    runJson(c, getProfile(actionInput(null, c.req.param(), undefined))),
  );

  return profile;
};
