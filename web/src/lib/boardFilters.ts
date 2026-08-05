// Client-side board filters (EFB-44): "show my tickets", assignee, label.
//
// Pure predicates over already-loaded issues — filtering never round-trips to
// the server at this scale. Kept separate from boardView.ts, which is URL/view
// routing and shares no concern with issue selection.
//
// EFB-45: the sprint filter lives here too now. It used to ship as its own
// scalar `filterSprintId` prop (phase 21c) applied alongside this predicate,
// so the board carried two filter mechanisms at once.
//
// Sprint still reaches only ONE of the five filterable funnels —
// StatusStack.active. The rail's backlog and icebox and the Backlog view's two
// groupings stay ambient by design (see KanbanRail's comment: the rail has no
// sprint sections, so a sprint-bound backlog issue should still list there).
// That reach map used to be implicit in which props a component happened to
// forward, which meant any refactor touching the plumbing could silently widen
// or narrow it. It is now explicit in `predicateFor(scope, …)` — a derivation
// of state, and unit-testable.

import type { Issue } from "./types";
import { matchesTextFilter, parseTextFilter } from "./textFilterQuery";

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
  /** Sprint to narrow the active board to, or null for no sprint constraint.
   *  Unlike the others this is scope-limited — see `predicateFor`. */
  readonly sprintId: string | null;
  /** EFB-112 — free-form text query (title/body/type/short_id, negation,
   *  quoted phrases). Empty string = no constraint. */
  readonly text: string;
}

export const EMPTY_FILTERS: BoardFilters = {
  mineOnly: false,
  assignees: [],
  labels: [],
  sprintId: null,
  text: "",
};

/** The dimensions that narrow every funnel — everything except sprint. */
const hasAmbientFilters = (filters: BoardFilters): boolean =>
  filters.mineOnly ||
  filters.assignees.length > 0 ||
  filters.labels.length > 0 ||
  filters.text.trim() !== "";

/**
 * Is anything narrowing the board at all, sprint included?
 *
 * NOTE this has no caller in app code as of EFB-45. Its previous consumer was
 * BoardPage's predicate memo, whose short-circuit now lives inside
 * `predicateFor` (which needs the per-scope question, not this one). Kept as
 * the public "is this board filtered" question, and because EFB-44's tests for
 * it are part of the behaviour-preservation evidence for this refactor.
 *
 * Its doc used to claim it drove chip highlighting and empty-state copy. It
 * never did — each chip reads its own slice of the filter state directly.
 */
export const hasActiveFilters = (filters: BoardFilters): boolean =>
  hasAmbientFilters(filters) || filters.sprintId !== null;

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
  if (!filterByAssignee(issue, filters.assignees)) return false;
  if (!filterByLabels(issue, filters.labels)) return false;
  // Parse-per-issue on the flat helper — predicateFor below hoists the parse
  // out of the loop for the hot path. This entry point stays available for
  // ad-hoc callers that don't build a predicate.
  const text = filters.text.trim();
  if (text !== "" && !matchesTextFilter(issue, parseTextFilter(text))) return false;
  return true;
};

/**
 * Which funnel a predicate is being built for.
 *
 * `active` is the status stack — the one surface a sprint narrows. `ambient`
 * is everything else: the rail's backlog and icebox, and the Backlog view's
 * in-sprint and unassigned groupings. They see every dimension EXCEPT sprint.
 */
export type FilterScope = "active" | "ambient";

/** Does this issue belong to the filtered sprint? Null = no constraint. */
export const filterBySprint = (issue: Issue, sprintId: string | null): boolean =>
  sprintId === null || issue.sprint_id === sprintId;

/**
 * The predicate a funnel should run, or undefined when nothing narrows it.
 *
 * Undefined rather than a tautology so callers can skip the filter pass
 * entirely — and so an unfiltered board never pays to walk its own issue list.
 *
 * The scope check is what keeps sprint on one funnel. Note it is applied to
 * the SPRINT VALUE, not by branching the returned predicate: an ambient funnel
 * builds its predicate as though no sprint were selected, so a board narrowed
 * to a sprint still shows that sprint's backlog neighbours in the rail.
 */
export const predicateFor = (
  scope: FilterScope,
  filters: BoardFilters,
  viewer: string | null,
): ((issue: Issue) => boolean) | undefined => {
  const sprintId = scope === "active" ? filters.sprintId : null;
  if (sprintId === null && !hasAmbientFilters(filters)) return undefined;
  // Hoist the text-filter parse out of the per-issue loop.
  const textClauses = parseTextFilter(filters.text);
  return (issue: Issue) => {
    if (!filterBySprint(issue, sprintId)) return false;
    if (filters.mineOnly && viewer !== null && issue.assignee_pubkey !== viewer) return false;
    if (!filterByAssignee(issue, filters.assignees)) return false;
    if (!filterByLabels(issue, filters.labels)) return false;
    if (textClauses.length > 0 && !matchesTextFilter(issue, textClauses)) return false;
    return true;
  };
};
