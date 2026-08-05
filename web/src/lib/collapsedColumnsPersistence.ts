// Which status columns are collapsed in the vertical kanban view, persisted
// per (boardId, viewerPubkey). Same shape as filterPersistence: identity is
// part of the key so signing in or out swaps to that viewer's preferences
// instead of leaking between users on a shared machine.
//
// On first visit for a (boardId, viewer) with no persisted state, the caller
// supplies a `defaults` array — typically the Done column's id — so common
// cases don't require a manual open-of-the-picker-close moment.

const KEY = (boardId: string, viewer: string | null): string =>
  `evenflow:board-collapsed:${boardId}:${viewer ?? "anon"}`;

export const readCollapsed = (
  boardId: string,
  viewer: string | null,
  defaults: readonly string[],
): ReadonlySet<string> => {
  try {
    const raw = window.localStorage.getItem(KEY(boardId, viewer));
    if (raw === null) return new Set(defaults);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(defaults);
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set(defaults);
  }
};

export const writeCollapsed = (
  boardId: string,
  viewer: string | null,
  collapsed: ReadonlySet<string>,
): void => {
  try {
    window.localStorage.setItem(KEY(boardId, viewer), JSON.stringify([...collapsed]));
  } catch {
    // localStorage errors (private mode, quota) shouldn't break the app.
  }
};
