-- Evenflow D1 schema — migration 0018: sprint membership audit + metrics
-- (phase 21a).
--
-- issueCache.sprint_id is the CURRENT sprint the issue belongs to (or NULL).
-- sprintMembership is the audit trail: every time an issue enters a sprint
-- we insert a row (added_at_ms=now, removed_at_ms=NULL). On removal or
-- carry-over we stamp removed_at_ms. On sprint-complete we mark
-- was_completed_in_sprint for the rows still open in that sprint. This is
-- what makes "which sprints has issue X ever been in" and "what shipped in
-- Sprint 5" answerable — the single-value sprint_id would otherwise lose
-- everything on the next assignment.
--
-- carried_to_sprint_id: when a sprint completes and an incomplete issue
-- rolls to the next planning sprint, the audit row for the old sprint gets
-- this pointer so the archive view can render "carried over to Sprint 6".
--
-- Sprint metrics (points_committed_start / points_completed / points_carried /
-- adds_mid_sprint) are computed at start/complete time and cached so the
-- archive page is a cheap SELECT. Rebuildable from audit rows if drift ever
-- shows up.
--
-- boardCache.done_window_days: for kanban-only teams (no active sprint), the
-- Kanban Done column shows items completed within this window. Falls back
-- to board.default_sprint_days shape (14 default).

CREATE TABLE sprintMembership (
  id TEXT PRIMARY KEY,
  sprint_id TEXT NOT NULL REFERENCES sprintCache(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES issueCache(id) ON DELETE CASCADE,
  added_at_ms INTEGER NOT NULL,
  removed_at_ms INTEGER,
  was_completed_in_sprint INTEGER NOT NULL DEFAULT 0,
  carried_to_sprint_id TEXT REFERENCES sprintCache(id) ON DELETE SET NULL
);
CREATE INDEX idx_sprintMembership_sprint ON sprintMembership(sprint_id);
CREATE INDEX idx_sprintMembership_issue ON sprintMembership(issue_id);
-- Fast lookup for the "still-open membership on this (sprint, issue)" query
-- used by remove/complete paths. Only one open row per pair is expected.
CREATE INDEX idx_sprintMembership_open ON sprintMembership(sprint_id, issue_id) WHERE removed_at_ms IS NULL;

ALTER TABLE sprintCache ADD COLUMN points_committed_start INTEGER;
ALTER TABLE sprintCache ADD COLUMN points_completed INTEGER;
ALTER TABLE sprintCache ADD COLUMN points_carried INTEGER;
ALTER TABLE sprintCache ADD COLUMN adds_mid_sprint INTEGER NOT NULL DEFAULT 0;

ALTER TABLE boardCache ADD COLUMN done_window_days INTEGER NOT NULL DEFAULT 14;

-- Backfill: every issue currently in a sprint gets one open membership row
-- with added_at_ms = the issue's created_at_ms (best-effort — we don't have
-- the real add time from before this migration). was_completed_in_sprint
-- stays 0; a completed sprint's post-hoc metrics remain best-effort.
INSERT INTO sprintMembership (id, sprint_id, issue_id, added_at_ms, removed_at_ms, was_completed_in_sprint, carried_to_sprint_id)
SELECT
  lower(hex(randomblob(16))),
  i.sprint_id,
  i.id,
  i.created_at_ms,
  NULL,
  0,
  NULL
FROM issueCache i
WHERE i.sprint_id IS NOT NULL;
