// Intra-column display order (phase 18d). Mirrors the Worker's
// positioning constants in src/routes/issues.ts — keep in lockstep.
//
// Positioned issues sort by position ASC; legacy NULL-position rows sort
// after every positioned row, newest-updated first (exactly the pre-18d
// order, so untouched boards look unchanged). The first reorder on a
// column rebalances it fully server-side.

import type { Column } from "./columns";
import type { Issue } from "./types";

export const POSITION_STEP = 1000;

export const byBoardOrder = (a: Issue, b: Issue): number => {
  const pa = a.position ?? Number.POSITIVE_INFINITY;
  const pb = b.position ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  return b.updated_at_ms - a.updated_at_ms;
};

/**
 * The issues a kanban column displays, in display order. column_id is the
 * identity; the status-name match covers rows awaiting the 0005 backfill.
 */
export const issuesInColumn = (issues: ReadonlyArray<Issue>, column: Column): Issue[] =>
  issues
    .filter((i) => (i.column_id !== null ? i.column_id === column.id : i.status === column.name))
    .sort(byBoardOrder);
