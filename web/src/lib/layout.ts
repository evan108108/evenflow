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
 * Whether a board header of the given width renders in its mobile shape.
 *
 * ⚠️ DO NOT FEED `window.innerWidth` TO THIS on a page that can overflow
 * horizontally. Once a document overflows, Chromium reports `window.innerWidth`
 * as the SCROLLABLE width, not the layout viewport width. Measured on prod at a
 * 393px iPhone viewport while `.tabs-row` overflowed:
 *
 *     document.documentElement.clientWidth : 393
 *     window.visualViewport.width          : 393
 *     matchMedia("(max-width: 768px)")     : true
 *     window.innerWidth                    : 792   <- what EFB-67 v1 read
 *
 * EFB-67 v1 shipped as a regression because of exactly that: it selected the
 * header with `isMobileHeader(window.innerWidth)`, got 792 on a real phone, and
 * rendered the DESKTOP header inside 393px. Use
 * `matchMedia("(max-width: 768px)")` or `document.documentElement.clientWidth`.
 * The board header is now chosen by a CSS media query and no longer calls this.
 *
 * THE PROPERTY TEST BELOW STRESSES THE PREDICATE AND CANNOT PROTECT AGAINST A
 * CORRUPTED INPUT. It passed throughout v1. A pure function tested with clean
 * synthetic widths is not evidence about the number the caller actually has.
 *
 * Kept rather than deleted (EFB-67 v2): nothing else in the codebase records
 * the innerWidth hazard, and this is the site a future author reaching for
 * `window.innerWidth` would land on. The comment is the point.
 *
 * The old note here claimed innerWidth and media-query px "disagree by the
 * scrollbar width." On this page they disagreed by 399px. That claim is the
 * reason v1 avoided a media query, so it is corrected rather than removed.
 *
 * STRICT `<`, matching resolveKanbanLayout's comparison exactly rather than
 * approximately — an inclusive `<=` would put a 640px viewport on the mobile
 * header while the board still defaulted to columns.
 */
export const isMobileHeader = (viewportWidth: number): boolean =>
  viewportWidth < AUTO_VERTICAL_MAX_PX;

/**
 * The layout viewport width — the number every predicate in this file wants.
 *
 * This exists so the hazard documented above has ONE positive answer instead
 * of a prohibition each caller re-derives. `document.documentElement.clientWidth`
 * is the CSS layout viewport and stays correct while the document overflows
 * horizontally; `window.innerWidth` becomes the scrollable width and reported
 * 792 on a 393px phone (EFB-67 v1).
 *
 * EFB-77 routed the three BoardPage callers here. They were latent rather
 * than broken — the kanban's own widths did not overflow the page, so the
 * corrupted read never changed a branch — but "correct because nothing
 * currently overflows" is a property of today's CSS, not of the code, and
 * the layout decisions include deciding whether to overflow at all.
 *
 * Excludes the scrollbar, which is the desired behavior: it is the width
 * content actually gets, and it matches what CSS media queries compare
 * against, so JS and CSS breakpoints agree.
 */
export const layoutViewportWidth = (): number => document.documentElement.clientWidth;

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
