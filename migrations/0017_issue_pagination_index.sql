-- Evenflow D1 schema — migration 0017: per-column pagination index.
--
-- The board views stop fetching "everything" and become cursor-paged
-- streams, one per visible list. Two access patterns need to be seekable
-- rather than scan-then-sort:
--
--   active container  → ORDER BY (position IS NULL), position, id DESC
--   backlog / icebox  → ORDER BY updated_at_ms DESC, id DESC
--
-- No column changes — this migration is purely indexes. `position` keeps
-- its existing semantics (fractional, set only by the reorder endpoint);
-- it is the stable cursor precisely because it does not shift when
-- neighbours change.

-- Active-container Kanban columns. Leading (board_id, container, column_id)
-- narrows to one column's stream; the trailing position lets SQLite walk
-- the index in order instead of sorting the whole column.
--
-- `position` is left plain here rather than mirroring the query's
-- (position IS NULL) prefix: SQLite orders NULLs FIRST in an ASC index, so
-- the index still supplies the ordering for the non-NULL majority, and the
-- legacy NULL-position tail is small and bounded (pre-18d rows only).
CREATE INDEX IF NOT EXISTS idx_issueCache_board_container_column_position
  ON issueCache (board_id, container, column_id, position, id);

-- Backlog and icebox side-lists, which page by recency instead.
-- idx_issueCache_board_updated (0001) covers (board_id, updated_at_ms) but
-- not the container narrowing, so a busy board still scanned the other
-- containers' rows to fill a page.
CREATE INDEX IF NOT EXISTS idx_issueCache_board_container_updated
  ON issueCache (board_id, container, updated_at_ms DESC, id DESC);
