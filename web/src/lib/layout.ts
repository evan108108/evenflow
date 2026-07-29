// Kanban layout preference (vertical Linear-style vs horizontal columns).
//
// Resolution order: an explicit stored preference always wins; with none
// stored, narrow viewports default to vertical. Separately, below
// FORCE_VERTICAL_MAX_PX the columns layout is unusable, so rendering is
// forced vertical WITHOUT touching the stored preference — widen the
// window and the preference is honored again.

export type KanbanLayout = "columns" | "vertical";

export const LAYOUT_STORAGE_KEY = "evenflow:kanban-layout";
/** No stored preference + viewport narrower than this → default vertical. */
export const AUTO_VERTICAL_MAX_PX = 640;
/** Narrower than this → always RENDER vertical, preference untouched. */
export const FORCE_VERTICAL_MAX_PX = 480;

/** The user's effective preference: stored value, else viewport default. */
export const resolveKanbanLayout = (
  stored: string | null,
  viewportWidth: number,
): KanbanLayout => {
  if (stored === "columns" || stored === "vertical") return stored;
  return viewportWidth < AUTO_VERTICAL_MAX_PX ? "vertical" : "columns";
};

/** What actually renders: the preference, unless the viewport can't fit columns. */
export const effectiveKanbanLayout = (
  preference: KanbanLayout,
  viewportWidth: number,
): KanbanLayout => (viewportWidth < FORCE_VERTICAL_MAX_PX ? "vertical" : preference);
