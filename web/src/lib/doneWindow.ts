// EFB-31's Done-window arithmetic, extracted in EFB-45.
//
// The window keeps the Done column from growing unbounded on kanban-mode
// boards. It used to be decided in two places: BoardPage computed the
// milliseconds, and StatusStack independently skipped the window when the
// scalar `filterSprintId` prop was set. EFB-45 deleted that scalar, which
// would have orphaned the skip — so the whole decision moved here, where the
// board's state owner can ask one question and get one answer.
//
// Pure so the guarantee keeps a test. The "a sprint filter already narrows the
// deck, don't window on top of it" rule is the no-regression case EFB-31
// shipped, and it must not quietly evaporate in an ownership migration.

const DAY_MS = 86_400_000;

/**
 * The Done-column window in ms, or null for "show every done card".
 *
 * Null in two distinct cases, both meaning "do not window":
 *  - the viewer lifted the window with the chip
 *  - a sprint filter is active, so the deck is already narrowed and windowing
 *    on top would double-filter the column toward empty
 */
export const effectiveDoneWindowMs = (
  lifted: boolean,
  sprintFilterActive: boolean,
  windowDays: number,
): number | null => {
  if (lifted || sprintFilterActive) return null;
  if (windowDays <= 0) return null;
  return windowDays * DAY_MS;
};
