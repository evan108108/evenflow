-- Evenflow D1 schema — migration 0006: issue attachments + rich-text bodies.
--
-- issueAttachmentCache follows the *Cache posture from 0001: blobs live on
-- the Blossom substrate (sha256-addressed, immutable), these rows are the
-- fast-read projection. storage_kind records WHERE the blob lives —
-- 'blossom_default' is the Evenflow-managed host (phase 18a, the only kind
-- written today); 'blossom_byo' / 's3_byo' arrive with BYOB storage in
-- phase 18b. Soft-delete via deleted_at_ms: the blob is the substrate's
-- business, the D1 row just hides.
--
-- The partial unique index is the one-cover-per-issue invariant: the
-- PATCH handler clears the old cover in the same batch, and the index
-- backstops any race.

CREATE TABLE issueAttachmentCache (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  blob_url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_kind TEXT NOT NULL CHECK(storage_kind IN ('blossom_default','blossom_byo','s3_byo')),
  is_cover INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT NOT NULL,
  uploaded_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER
);
CREATE INDEX idx_issueAttachmentCache_issue_id ON issueAttachmentCache(issue_id);
CREATE UNIQUE INDEX idx_issueAttachmentCache_one_cover_per_issue ON issueAttachmentCache(issue_id) WHERE is_cover = 1 AND deleted_at_ms IS NULL;

-- body_format: new bodies are GFM markdown; rows that predate this
-- migration keep rendering exactly as before (plain, white-space:
-- pre-wrap), so the backfill pins every existing body to 'plain' before
-- the 'markdown' default starts applying to fresh inserts.
ALTER TABLE issueCache ADD COLUMN body_format TEXT NOT NULL DEFAULT 'markdown' CHECK(body_format IN ('plain','markdown'));
UPDATE issueCache SET body_format = 'plain' WHERE body IS NOT NULL;
