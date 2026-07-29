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
 */
export const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "application/zip",
  "application/json",
] as const;

export const isAllowedContentType = (contentType: string): boolean =>
  (ALLOWED_CONTENT_TYPES as ReadonlyArray<string>).includes(contentType);

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
