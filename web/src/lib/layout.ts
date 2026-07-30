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
/**
 * Vertical layout at this width or wider splits into two columns: the
 * status stack on the left, a Backlog + Icebox rail on the right. Below
 * it the same content renders as one stack (rail sections at the bottom).
 */
export const WIDE_VERTICAL_MIN_PX = 1024;

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

/**
 * Whether the vertical stack has room to put the Backlog + Icebox rail
 * beside it. Takes the EFFECTIVE layout — the columns layout has its own
 * full-width treatment and never gets a rail.
 */
export const isWideVertical = (layout: KanbanLayout, viewportWidth: number): boolean =>
  layout === "vertical" && viewportWidth >= WIDE_VERTICAL_MIN_PX;
