-- Evenflow D1 schema — migration 0005: issue types + structured columns.
--
-- Part 1 — Linear-style issue types. Six fixed kinds, default 'task'.
--
-- Part 2 — boardCache.columns changes SHAPE (no DDL needed: the column
-- stays TEXT/JSON) from a bare name array ["Todo", ...] to a Column[] of
-- {id, name, order, enabled, category}. id is the stable identity across
-- renames; category ∈ todo|in_progress|in_review|done|blocked is what
-- velocity and completed_at_ms key off — never the literal name "Done".
-- issueCache.column_id carries the stable reference; status remains as a
-- name mirror for display, not identity.
--
-- column_id is nullable for the pre-backfill window only (same posture as
-- 0003's short_id / 0004's org_id): scripts/backfill-columns-v5.mjs runs
-- immediately after this file is applied — it needs string logic SQL
-- doesn't have (UUID minting, category inference) — and resolves every
-- issue's status name against its board's new Column[].

ALTER TABLE issueCache ADD COLUMN type TEXT NOT NULL DEFAULT 'task' CHECK(type IN ('task','feature','bug','story','improvement','chore'));
CREATE INDEX idx_issueCache_type ON issueCache(type);

ALTER TABLE issueCache ADD COLUMN column_id TEXT;
CREATE INDEX idx_issueCache_column_id ON issueCache(column_id);
