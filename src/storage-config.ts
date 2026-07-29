// Org storage configuration (phase 18b BYOB) — the orgStorageConfig row
// shape, its wire view, and the per-org lookup the upload path runs.
//
// kind 'default' (or no row at all) → Evenflow-managed Blossom;
// kind 'blossom' → the org's own Blossom at blossom_url;
// kind 's3' → the org's own S3-compatible bucket, creds NIP-44-encrypted to
// the server pubkey (see src/lib/nostr-keys.ts for the trust story).

import { Effect } from "effect";
import { Db, type DbError } from "./effects";

export const ORG_STORAGE_KINDS = ["default", "blossom", "s3"] as const;
export type OrgStorageKind = (typeof ORG_STORAGE_KINDS)[number];

export interface OrgStorageConfigShape {
  readonly org_id: string;
  readonly kind: OrgStorageKind;
  readonly blossom_url: string | null;
  readonly s3_endpoint: string | null;
  readonly s3_region: string | null;
  readonly s3_bucket: string | null;
  readonly s3_path_style: boolean;
  readonly s3_creds_ciphertext: string | null;
  readonly s3_creds_sender_pubkey: string | null;
  readonly updated_by_pubkey: string;
  readonly updated_at_ms: number;
}

export const parseOrgStorageRow = (row: Record<string, unknown>): OrgStorageConfigShape => ({
  org_id: row["org_id"] as string,
  kind: row["kind"] as OrgStorageKind,
  blossom_url: (row["blossom_url"] as string | null) ?? null,
  s3_endpoint: (row["s3_endpoint"] as string | null) ?? null,
  s3_region: (row["s3_region"] as string | null) ?? null,
  s3_bucket: (row["s3_bucket"] as string | null) ?? null,
  s3_path_style: row["s3_path_style"] === 1 || row["s3_path_style"] === true,
  s3_creds_ciphertext: (row["s3_creds_ciphertext"] as string | null) ?? null,
  s3_creds_sender_pubkey: (row["s3_creds_sender_pubkey"] as string | null) ?? null,
  updated_by_pubkey: row["updated_by_pubkey"] as string,
  updated_at_ms: row["updated_at_ms"] as number,
});

/** The org's storage config row, or null (= default storage). */
export const getOrgStorageConfig = (
  orgId: string,
): Effect.Effect<OrgStorageConfigShape | null, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT * FROM orgStorageConfig WHERE org_id = ?",
      [orgId],
    );
    return row === null ? null : parseOrgStorageRow(row);
  });

/**
 * What the settings surface may see: everything except the ciphertext and
 * sender pubkey, plus a has_credentials flag so the UI can say "saved"
 * without ever seeing the secret material again.
 */
export const redactedStorageView = (cfg: OrgStorageConfigShape | null) =>
  cfg === null
    ? { kind: "default" as OrgStorageKind }
    : {
        kind: cfg.kind,
        blossom_url: cfg.blossom_url,
        s3_endpoint: cfg.s3_endpoint,
        s3_region: cfg.s3_region,
        s3_bucket: cfg.s3_bucket,
        s3_path_style: cfg.s3_path_style,
        has_credentials: cfg.s3_creds_ciphertext !== null,
        updated_at_ms: cfg.updated_at_ms,
      };
