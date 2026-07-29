-- Evenflow D1 schema — migration 0010: sprints (phase 20).
--
-- A sprint is a named batch of backlog issues that starts together
-- (backlog → active in one move) and completes together. Linear model:
-- completing a sprint does NOT touch its unfinished issues — they stay
-- active; the sprint itself just leaves the Sprints section.
--
-- issueCache.sprint_id is a soft link, same posture as the other caches:
-- ON DELETE SET NULL so a reaped sprint never strands its issues.
--
-- (0009 is reserved for the in-flight phase-18b BYOB storage work.)

CREATE TABLE sprintCache (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boardCache(id) ON DELETE CASCADE,
  name TEXT NOT NULL,          -- e.g., "Sprint 3"
  goal TEXT,                    -- optional one-liner
  status TEXT NOT NULL CHECK (status IN ('planning','active','completed')),
  started_at_ms INTEGER,        -- null until start
  completed_at_ms INTEGER,      -- null until complete
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_sprintCache_board_status ON sprintCache(board_id, status);

ALTER TABLE issueCache ADD COLUMN sprint_id TEXT REFERENCES sprintCache(id) ON DELETE SET NULL;
CREATE INDEX idx_issueCache_sprint ON issueCache(sprint_id) WHERE sprint_id IS NOT NULL;
