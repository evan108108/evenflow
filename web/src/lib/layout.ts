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

/**
 * Whether the board header renders in its mobile shape (EFB-67).
 *
 * Mobile header engages at the same threshold the board defaults to vertical
 * (AUTO_VERTICAL_MAX_PX = 640). Design invariant: header-mode and column-mode
 * switch together, so we never present mobile-density chrome over desktop-
 * density content. Landscape phones in 641–800 currently see columns + desktop
 * header; extending the mobile header up to that range needs its own design
 * pass on the mixed-density question (follow-up if it becomes a real ask).
 *
 * Deliberately NOT a CSS media query. See the note above `.vertical-split` in
 * board.css: window.innerWidth and media-query pixels disagree by the scrollbar
 * width, and one breakpoint in one place beats two that drift. This reuses an
 * existing constant rather than adding a fourth.
 *
 * STRICT `<`, matching resolveKanbanLayout's comparison exactly rather than
 * approximately. An inclusive `<=` here would put a 640px viewport on the
 * mobile header while the board still defaulted to columns — a one-pixel band
 * of mobile chrome over desktop content, which is the same inclusive-vs-
 * exclusive drift the `@media (max-width: 479px)` / FORCE_VERTICAL_MAX_PX = 480
 * pair already demonstrates elsewhere in this codebase. Sharing the symbol is
 * not enough; the comparison has to match too.
 */
export const isMobileHeader = (viewportWidth: number): boolean =>
  viewportWidth < AUTO_VERTICAL_MAX_PX;

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
