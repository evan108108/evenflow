-- Evenflow D1 schema — migration 0021: sprint tide (EFB-22).
--
-- The tide is points remaining in a sprint (committed − done) sampled once
-- per day, so the board can render a 7-day sparkline and a direction arrow
-- instead of the hand-waved "The Current" number.
--
-- sprintTideSnapshot is a cache of kind:30560 fa:KanbanTideSnapshot (30565
-- encrypted, private boards). One row per (sprint, day). substrate_event_id
-- is stamped on a successful publish and left NULL when the publish failed —
-- same "publish, then stamp" posture as orgs/membership (0004). A NULL is
-- never load-bearing: every snapshot is recomputable from the audit rows
-- (sprintMembership + statusChangeCache + issueEstimateHistory), so a
-- dropped publish costs a substrate event, never the sparkline.
--
-- sprint_id NULL means the kanban-only variant: boards with no active sprint
-- get a board-level tide over boardCache.done_window_days as a virtual
-- sprint. The two partial unique indexes below give us one row per
-- (sprint, day) AND one row per (board, day) for the kanban case — a plain
-- UNIQUE(sprint_id, day_start_ms) would not, since SQLite treats every NULL
-- as distinct and quiet boards would accumulate duplicate rows per day.
--
-- issueEstimateHistory is the missing audit leg. issueCache.estimate is a
-- single current value, so re-estimating an issue mid-sprint silently
-- rewrites every historical remaining_pts we would otherwise derive. With
-- this table, replaying a past day uses the estimate that was in force on
-- that day. issues.ts PATCH inserts one row per estimate change.
--
-- Real FKs here (not the soft-FK posture the *Cache tables use) follow
-- migration 0018's sprintMembership precedent: these are sprint audit rows,
-- and ON DELETE CASCADE is what keeps a reaped sprint or board from
-- stranding tide history.

CREATE TABLE sprintTideSnapshot (
  id             TEXT PRIMARY KEY,                                        -- uuid
  sprint_id      TEXT REFERENCES sprintCache(id) ON DELETE CASCADE,       -- NULL = kanban-only board tide
  board_id       TEXT NOT NULL REFERENCES boardCache(id) ON DELETE CASCADE,
  day_start_ms   INTEGER NOT NULL,                                        -- UTC midnight of the day this snapshot closes
  committed_pts  INTEGER NOT NULL,
  done_pts       INTEGER NOT NULL,
  remaining_pts  INTEGER NOT NULL,
  adds_today     INTEGER NOT NULL DEFAULT 0,                              -- points added to scope that day
  drops_today    INTEGER NOT NULL DEFAULT 0,                              -- points removed from scope that day
  computed_at_ms INTEGER NOT NULL,
  substrate_event_id TEXT                                                 -- 4a event id; NULL = publish deferred
);

-- One snapshot per (sprint, day) …
CREATE UNIQUE INDEX idx_sprintTideSnapshot_sprint_day
  ON sprintTideSnapshot (sprint_id, day_start_ms) WHERE sprint_id IS NOT NULL;
-- … and one per (board, day) for the kanban-only variant.
CREATE UNIQUE INDEX idx_sprintTideSnapshot_board_day_kanban
  ON sprintTideSnapshot (board_id, day_start_ms) WHERE sprint_id IS NULL;
-- Sparkline read: last N days for a board, newest first.
CREATE INDEX idx_sprintTideSnapshot_board_day
  ON sprintTideSnapshot (board_id, day_start_ms DESC);
-- Retry sweep (not yet implemented): snapshots that never reached 4a.
CREATE INDEX idx_sprintTideSnapshot_unpublished
  ON sprintTideSnapshot (board_id) WHERE substrate_event_id IS NULL;

CREATE TABLE issueEstimateHistory (
  id             TEXT PRIMARY KEY,                                        -- uuid
  issue_id       TEXT NOT NULL REFERENCES issueCache(id) ON DELETE CASCADE,
  occurred_at_ms INTEGER NOT NULL,
  prev_estimate  INTEGER,                                                 -- NULL = was unestimated
  next_estimate  INTEGER,                                                 -- NULL = cleared back to unestimated
  actor_pubkey   TEXT NOT NULL
);

-- Replaying a day: every estimate change for an issue, newest first.
CREATE INDEX idx_issueEstimateHistory_issue_occurred
  ON issueEstimateHistory (issue_id, occurred_at_ms DESC);
