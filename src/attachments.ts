// Shared vocabulary for issue attachments (phase 18a).
//
// Mirrored at web/src/lib/attachments.ts — keep the two files in lockstep.
//
// Default storage is the Evenflow-managed Blossom host (5 MB/file). The
// BYO caps and storage kinds beyond 'blossom_default' are declared now so
// the schema and error copy stay stable, but BYOB paths ship in phase 18b.

export const MAX_ATTACHMENTS_PER_ISSUE = 20;

/** Per-file cap on the Evenflow-managed default Blossom host. */
export const BLOSSOM_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Safety cap for BYO buckets — enforced when phase 18b ships them. */
export const BYO_S3_MAX_BYTES = 100 * 1024 * 1024;

export const STORAGE_KINDS = ["blossom_default", "blossom_byo", "s3_byo"] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];

/**
 * Server-side content-type allowlist. Anything not listed is rejected
 * loudly — in particular every executable/script type. Images render as
 * thumbnails + covers; the rest get generic file cards.
 *
 * This is the ceiling for BYO buckets, which hold whatever their owner
 * allows. The default path accepts a strict subset — see below.
 */
export const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/zip",
  "application/json",
] as const;

/**
 * What the Evenflow-managed default host actually accepts (EFB-80).
 *
 * The free tier of the default Blossom host serves images, audio and video;
 * documents and archives are gated behind a paid plan. Verified 2026-08-03
 * by signing a BUD-01 auth and PUTting one file per type: `image/png` → 200,
 * while `application/pdf`, `application/zip` and `application/json` → 415
 * "File type not allowed" and `text/plain` → 400.
 *
 * Before this split the edge accepted all eight types and let four of them
 * fail upstream, surfacing as an opaque 502 with no server-side signal —
 * the "asserted guarantee is not an enforced one" shape EFB-80 was filed
 * about. Validating here turns that into an actionable 400 that points at
 * BYO setup.
 *
 * Deliberately narrower than the host's own free set: audio and video would
 * upload fine, but the cover/thumbnail path assumes images, so widening is
 * its own change. Keep this list in sync with what the default host takes —
 * if the host's terms change, this constant is the one place to edit.
 */
export const BLOSSOM_DEFAULT_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

/** Types accepted on a given storage path; BYO buckets take the full set. */
export const allowedContentTypesFor = (byob: boolean): ReadonlyArray<string> =>
  byob ? ALLOWED_CONTENT_TYPES : BLOSSOM_DEFAULT_CONTENT_TYPES;

export const isAllowedContentType = (contentType: string, byob: boolean): boolean =>
  allowedContentTypesFor(byob).includes(contentType);

/**
 * True when a type is fine on a BYO bucket but not on the default path —
 * the case that earns "set up your own bucket" rather than a flat refusal.
 */
export const needsByoStorage = (contentType: string): boolean =>
  isAllowedContentType(contentType, true) && !isAllowedContentType(contentType, false);

export const isImageContentType = (contentType: string): boolean =>
  contentType.startsWith("image/");

export const BODY_FORMATS = ["plain", "markdown"] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];

/** Human-sized byte count for the actionable size_exceeded error copy. */
export const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
};
