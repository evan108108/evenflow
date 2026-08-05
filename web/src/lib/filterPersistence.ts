// EFB-44 filter persistence — localStorage, scoped per board AND per viewer.
//
// Per-viewer rather than per-board-only because a selection is made of
// pubkeys: restoring one viewer's filters for the next person on a shared
// device would show them a board narrowed to someone they never picked,
// behind a chip that only reads "Assignee · 1". Confusing, and it leaks who
// the previous viewer was reading. A signed-out viewer gets its own `anon`
// scope so anonymous filtering persists without ever mixing with an identity.
//
// Consequence, accepted: switching accounts doesn't carry filters over, and
// the old key lingers. Writing nothing for an empty filter set (below) keeps
// that bounded to board/viewer pairs that actually filtered.

import { EMPTY_FILTERS, type BoardFilters } from "./boardFilters";

const PREFIX = "evenflow:board-filters";

export const filterStorageKey = (boardId: string, viewer: string | null): string =>
  `${PREFIX}:${boardId}:${viewer ?? "anon"}`;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Parse a stored blob back into filters.
 *
 * Anything unrecognised returns the empty set rather than throwing: a value
 * that predates a shape change — or that someone hand-edited — must not be
 * able to break the board it belongs to.
 */
export const parseFilters = (raw: string | null): BoardFilters => {
  if (raw === null) return EMPTY_FILTERS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_FILTERS;
    const { mineOnly, assignees, labels, text } = parsed as Record<string, unknown>;
    return {
      mineOnly: mineOnly === true,
      assignees: isStringArray(assignees) ? assignees : [],
      labels: isStringArray(labels) ? labels : [],
      // EFB-45: sprint is a filter dimension now, but deliberately NOT a
      // persisted one — it resets on reload exactly as the phase-21c scalar
      // did. Hard-coded null rather than read-and-ignore so a hand-edited or
      // future-shaped blob can never resurrect it.
      sprintId: null,
      text: typeof text === "string" ? text : "",
    };
  } catch {
    return EMPTY_FILTERS;
  }
};

const isEmpty = (f: BoardFilters): boolean =>
  !f.mineOnly &&
  f.assignees.length === 0 &&
  f.labels.length === 0 &&
  f.text.trim() === "";

/** Filters for this board+viewer, or the empty set. Never throws. */
export const readFilters = (boardId: string, viewer: string | null): BoardFilters => {
  try {
    return parseFilters(window.localStorage.getItem(filterStorageKey(boardId, viewer)));
  } catch {
    return EMPTY_FILTERS;
  }
};

/**
 * Persist filters, or clear the entry when nothing is active.
 *
 * Removing rather than storing `{}` means the overwhelmingly common
 * unfiltered case leaves no trace at all, so stale keys can only accumulate
 * for board/viewer pairs that genuinely filtered something.
 */
export const writeFilters = (boardId: string, viewer: string | null, filters: BoardFilters): void => {
  const key = filterStorageKey(boardId, viewer);
  try {
    if (isEmpty(filters)) window.localStorage.removeItem(key);
    // Serialise the persisted subset explicitly rather than the whole object:
    // sprintId is part of the shape but must not reach storage (EFB-45 lean a),
    // and `isEmpty` below likewise weighs only these three.
    else
      window.localStorage.setItem(
        key,
        JSON.stringify({
          mineOnly: filters.mineOnly,
          assignees: filters.assignees,
          labels: filters.labels,
          text: filters.text,
        }),
      );
  } catch {
    // Best-effort, same as the layout preference: the session keeps the signal.
  }
};
