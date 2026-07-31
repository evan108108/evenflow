// Client-side board filters (EFB-44): "show my tickets", assignee, label.
//
// Pure predicates over already-loaded issues — filtering never round-trips to
// the server at this scale. Kept separate from boardView.ts, which is URL/view
// routing and shares no concern with issue selection.
//
// The sprint filter is NOT here. It ships as its own scalar `filterSprintId`
// prop (phase 21c) and each view applies both; unifying the two mechanisms is
// a follow-up ticket, deliberately out of scope here.

import type { Issue } from "./types";

/**
 * Assignee-picker option standing for "nobody is assigned".
 *
 * Safe as a sentinel because a canonical pubkey is always `provider:oauth_id`
 * (see lib/jwt.ts), so anything without a colon cannot collide with a real one.
 */
export const UNASSIGNED = "unassigned";

export interface BoardFilters {
  /** Restrict to issues assigned to the signed-in viewer. */
  readonly mineOnly: boolean;
  /** Canonical pubkeys, plus `UNASSIGNED` for the null-assignee option. */
  readonly assignees: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<string>;
}

export const EMPTY_FILTERS: BoardFilters = {
  mineOnly: false,
  assignees: [],
  labels: [],
};

/** Whether any chip is on — drives chip highlighting and empty-state copy. */
export const hasActiveFilters = (filters: BoardFilters): boolean =>
  filters.mineOnly || filters.assignees.length > 0 || filters.labels.length > 0;

/**
 * Does this issue's assignee match the selection?
 *
 * An empty selection is "no constraint", not "match nothing" — otherwise a
 * board would render empty the moment a picker was opened and cleared.
 *
 * Selections are OR'd within the dimension. An issue has exactly one assignee,
 * so AND would match nothing by construction; labels follow the same rule for
 * consistency.
 */
export const filterByAssignee = (issue: Issue, assignees: ReadonlyArray<string>): boolean => {
  if (assignees.length === 0) return true;
  return issue.assignee_pubkey === null
    ? assignees.includes(UNASSIGNED)
    : assignees.includes(issue.assignee_pubkey);
};

/** Does this issue carry at least one of the selected labels? */
export const filterByLabels = (issue: Issue, labels: ReadonlyArray<string>): boolean => {
  if (labels.length === 0) return true;
  return labels.some((label) => issue.labels.includes(label));
};

/**
 * The composed predicate: every active dimension must pass (AND across chips).
 *
 * `viewer` is the signed-in pubkey, or null when signed out. A signed-out
 * viewer has no "mine" to filter to, so `mineOnly` is treated as inactive
 * rather than matching nothing — the chip is hidden in that state, and an
 * unexplained empty board is worse than an unfiltered one when a stale
 * persisted filter outlives a sign-out.
 */
export const matchesFilters = (
  issue: Issue,
  filters: BoardFilters,
  viewer: string | null,
): boolean => {
  if (filters.mineOnly && viewer !== null && issue.assignee_pubkey !== viewer) return false;
  return filterByAssignee(issue, filters.assignees) && filterByLabels(issue, filters.labels);
};
