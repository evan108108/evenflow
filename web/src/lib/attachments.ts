// Client mirror of src/attachments.ts on the Worker — attachment caps,
// allowed types, and the wire shape. The server module is the source of
// truth; keep the two files in lockstep.

export const MAX_ATTACHMENTS_PER_ISSUE = 20;

/** Per-file cap on the Evenflow-managed default Blossom host. */
export const BLOSSOM_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Safety cap for BYO buckets — enforced when phase 18b ships them. */
export const BYO_S3_MAX_BYTES = 100 * 1024 * 1024;

export const STORAGE_KINDS = ["blossom_default", "blossom_byo", "s3_byo"] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];

/** The ceiling, for BYO buckets. The default path takes a subset. */
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
 * What the Evenflow-managed default host accepts (EFB-80) — its free tier
 * gates documents and archives behind a paid plan, so accepting them at the
 * edge only bought an opaque 502 later. See src/attachments.ts for the
 * verification detail; the server is the enforcing gate, this mirror exists
 * to keep the two vocabularies in lockstep.
 */
export const BLOSSOM_DEFAULT_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const isImageContentType = (contentType: string): boolean =>
  contentType.startsWith("image/");

export const BODY_FORMATS = ["plain", "markdown"] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];

/** Wire shape returned by the attachments endpoints. */
export interface Attachment {
  readonly id: string;
  readonly issue_id: string;
  // Null = issue-level (Files panel); non-null = owned by one comment.
  readonly comment_id?: string | null;
  readonly blob_url: string;
  readonly sha256: string;
  readonly filename: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly storage_kind: StorageKind;
  readonly is_cover: boolean;
  readonly uploaded_by: string;
  readonly uploaded_at_ms: number;
  readonly deleted_at_ms: number | null;
}

/** The image cover among an issue's attachments, if any. */
export const coverOf = (attachments: ReadonlyArray<Attachment>): Attachment | undefined =>
  attachments.find((a) => a.is_cover && isImageContentType(a.content_type));

export const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
};
