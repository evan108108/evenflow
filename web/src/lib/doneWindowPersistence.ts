// EFB-31 done-window lift persistence — localStorage, scoped per board AND
// per viewer, mirroring EFB-44's filterPersistence scoping.
//
// Deliberately NOT a member of BoardFilters, despite both being "things the
// chip row toggles". Three reasons it cannot live there:
//
//  1. writeFilters() REMOVES the entry when isEmpty() is true, and isEmpty()
//     only weighs mineOnly/assignees/labels. A lifted window with no other
//     filter on would be classed empty and deleted — the lift would silently
//     fail to survive a refresh.
//  2. hasActiveFilters() drives chip highlighting and empty-state copy. A
//     lifted window would make the board report itself as filtered while
//     actually showing MORE than the default.
//  3. Every BoardFilters member NARROWS and is a pure issue-level predicate.
//     This one WIDENS, and it gates a column's render rather than an issue —
//     it can never be evaluated through matchesFilters(issue, ...).
//
// Same never-throw discipline as filterPersistence: storage can be disabled
// or full, and a board must never fail to render over a preference.

const PREFIX = "evenflow:done-window";

export const doneWindowStorageKey = (boardId: string, viewer: string | null): string =>
  `${PREFIX}:${boardId}:${viewer ?? "anon"}`;

/**
 * Is the Done window lifted for this board+viewer?
 *
 * Anything other than the exact stored marker reads as "not lifted" — the
 * windowed view is the safe default, since the failure mode is a shorter Done
 * column rather than an unbounded one, which is the whole point of the ticket.
 */
export const readDoneWindowLifted = (boardId: string, viewer: string | null): boolean => {
  try {
    return window.localStorage.getItem(doneWindowStorageKey(boardId, viewer)) === "1";
  } catch {
    return false;
  }
};

/**
 * Persist the lift, or clear the entry when back to windowed.
 *
 * Removing rather than storing "0" keeps the common (default) case leaving no
 * trace at all, so stale keys accumulate only for board/viewer pairs that
 * actually lifted the window — the same bounding filterPersistence uses.
 */
export const writeDoneWindowLifted = (
  boardId: string,
  viewer: string | null,
  lifted: boolean,
): void => {
  const key = doneWindowStorageKey(boardId, viewer);
  try {
    if (lifted) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // Best-effort, same as filters and the layout preference.
  }
};
