-- Evenflow D1 schema — migration 0011: variable sprint lengths.
--
-- Two knobs (Evan wants both): a board-level default and a per-sprint
-- override. Effective length = sprint.planned_days ?? board.default_sprint_days.
-- planned_days stays NULL unless a sprint explicitly overrides, so changing
-- the board default retroactively adjusts every non-overridden sprint.
--
-- (0009 remains reserved for the in-flight phase-18b BYOB storage work.)

ALTER TABLE boardCache ADD COLUMN default_sprint_days INTEGER NOT NULL DEFAULT 14;
ALTER TABLE sprintCache ADD COLUMN planned_days INTEGER;  -- nullable; null → board default
