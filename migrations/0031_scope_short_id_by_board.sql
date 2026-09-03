-- Evenflow D1 schema — migration 0031: scope short_id uniqueness to the board.
--
-- Migration 0003 added `idx_issueCache_short_id` as a GLOBAL unique index on
-- issueCache.short_id. That was the wrong shape: short_id lives in a
-- board-owned namespace ("ADA-42 in the Adaptengine board"), not in a
-- database-wide one. The global scope was cross-org isolation broken by
-- construction:
--
--   Org A creates board "acme" with prefix ADA, files 500 issues, deletes
--   the board. `deleteBoard` deliberately does not cascade (boards.ts:796),
--   so those 500 issueCache rows survive with no live parent. Org B — a
--   different org that A cannot even see — later creates a board with
--   prefix ADA and attempts to file ADA-1. The INSERT hits idx_issueCache
--   _short_id, fails with an opaque `db-query-failed`, and Org B has no way
--   to know why because the offending rows belong to Org A and are hidden
--   by authz. One org's deleted data silently freezes another org's
--   namespace.
--
-- The fix is to move uniqueness to (board_id, short_id) — the address a
-- short_id is actually meant to name. Prefixes remain globally reserved
-- among LIVE boards (uniquePrefix, issues.ts:728) so `ADA-1` still reads
-- unambiguously across the app, but a deleted board's orphans can no
-- longer block a new board that legitimately took the same prefix.
--
-- Two lookup call-sites (`SELECT * FROM issueCache WHERE short_id = ?` in
-- actions/issues.ts) join against boardCache in the same PR so they skip
-- orphan rows and cannot silently return a deleted board's ADA-1 in place
-- of a live one's.

DROP INDEX IF EXISTS idx_issueCache_short_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_issueCache_board_short_id
  ON issueCache (board_id, short_id);
