// Which of the three board views a URL is showing, and how to build the
// URLs back.
//
// The issue sheet opens *over* a view rather than replacing it, so the
// view lives in the path alongside the issue ref: /backlog/issues/EFB-28
// is still the backlog. That means the view can't be read off the tail of
// the pathname — it's the first segment after the board's base path.

export type BoardView = "kanban" | "backlog" | "icebox";

const NAMED_VIEWS = ["backlog", "icebox"] as const;

const asView = (segment: string | undefined): BoardView =>
  NAMED_VIEWS.includes(segment as (typeof NAMED_VIEWS)[number])
    ? (segment as BoardView)
    : "kanban";

const segments = (path: string): string[] => path.split("/").filter((s) => s.length > 0);

// pathname arrives percent-encoded; base is built from raw params. They
// agree for ordinary slugs, so only decode when we have to.
const decode = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

/**
 * Read the active view out of a board pathname.
 *
 * `base` is the board's own prefix (`/@org/slug` or `/boards/slug`). It's
 * required rather than inferred so that a board *named* "backlog" isn't
 * mistaken for the backlog view — its kanban URL ends in /backlog too.
 *
 * If the pathname doesn't sit under `base` (encoding mismatch on an exotic
 * slug), fall back to reading position from the end, where the only shapes
 * are `…/<view>` and `…/<view>/issues/<ref>`.
 */
export const boardViewOf = (pathname: string, base: string): BoardView => {
  for (const candidate of [pathname, decode(pathname)]) {
    if (candidate.startsWith(base)) return asView(segments(candidate.slice(base.length))[0]);
  }
  const tail = segments(pathname);
  if (tail.length >= 2 && tail[tail.length - 2] === "issues") tail.splice(-2);
  return asView(tail[tail.length - 1]);
};

/** Where a view lives. Kanban is the board root — it has no suffix. */
export const viewPath = (base: string, view: BoardView): string =>
  view === "kanban" ? base : `${base}/${view}`;

/** Where an issue opened *from* a given view lives. */
export const issuePath = (base: string, view: BoardView, ref: string): string =>
  `${viewPath(base, view)}/issues/${ref}`;
