-- Evenflow D1 schema — migration 0003: short human-readable issue ids.
--
-- Linear-style references: each board carries a short uppercase prefix
-- (FLOW) plus a monotonic counter, and each issue gets short_id
-- '<prefix>-<n>' (FLOW-42) — the reference used in URLs, git commits, and
-- the UI. Issue numbers are claimed atomically at create time via
-- UPDATE ... RETURNING on next_issue_number.
--
-- short_id is nullable here on purpose: prefix derivation from board
-- titles needs string logic SQL doesn't have, so rows that predate this
-- migration are populated by scripts/backfill-short-ids.mjs immediately
-- after `wrangler d1 migrations apply`. New issues always insert with
-- short_id set. (SQLite unique indexes admit multiple NULLs, so the
-- pre-backfill window is safe.)

ALTER TABLE boardCache ADD COLUMN issue_prefix TEXT;
ALTER TABLE boardCache ADD COLUMN next_issue_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE issueCache ADD COLUMN short_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_issueCache_short_id
  ON issueCache (short_id);
