-- Evenflow D1 schema — migration 0009: BYOB storage (phase 18b).
--
-- One row per org choosing where its attachment blobs live.
--   kind 'default' → the Evenflow-managed Blossom host (same as no row);
--   kind 'blossom' → the org's own Blossom server at blossom_url;
--   kind 's3'      → the org's own S3-compatible bucket (R2, AWS, MinIO…).
--
-- Trust model (locked design decision): S3 credentials are NIP-44 v2
-- encrypted BY THE CLIENT to the Evenflow SERVER's static pubkey — never to
-- the org audience, so bucket creds are not exposed to org members. The
-- client encrypts with an ephemeral sender keypair (ECIES-style);
-- s3_creds_sender_pubkey is that ephemeral pubkey, which the server ECDHs
-- with its EVENFLOW_STORAGE_SECRET-derived privkey to unwrap at upload
-- time. Plaintext credentials never touch D1.
--
-- No FK: same posture as every other *Cache table (D1 + app-level cascade;
-- org deletion is a soft delete anyway).

CREATE TABLE IF NOT EXISTS orgStorageConfig (
  org_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('default','blossom','s3')),
  blossom_url TEXT,
  s3_endpoint TEXT,
  s3_region TEXT,
  s3_bucket TEXT,
  s3_path_style INTEGER NOT NULL DEFAULT 1,
  s3_creds_ciphertext BLOB,
  s3_creds_sender_pubkey TEXT,
  updated_by_pubkey TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
