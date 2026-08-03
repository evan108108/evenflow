// EFB-78 — where an issue lands when it arrives somewhere new.
//
// A Kanban column is a chronological trail: the thing that just moved to Done
// is what you want to see first. Before this, a transition wrote the column
// identity and left `position` alone, so an issue arrived carrying whatever
// order value it happened to hold in the column it left. EFB-74 moved to Done
// at position 64000 and landed below several older Done tickets — the
// just-shipped ticket was the one you had to scroll to find.
//
// WHY THIS IS A SHARED HELPER AND NOT FOUR PATCHES.
//
// Four call sites move an issue into a new column or container: the status and
// container primitives in `src/routes/issues.ts` (which between them serve
// PATCH, /transition, and the container verbs) and the `set_column` /
// `set_container` cases in `src/github/execute.ts`. The github pair are
// independent hand-written SQL, not calls into the route primitives.
//
// That exact shape is what `src/lib/status-change.ts` was extracted to end, and
// its header says why: two implementations of the same write is how EFB-33's
// fix reached issues.ts and never reached execute.ts, leaving the github path
// silently running the pre-fix bug. Patching four sites here would rebuild the
// structure that caused it. One helper means the next change to "where does an
// arriving issue go" cannot reach only half the callers.
//
// POSITION SEMANTICS. Display order is `position ASC`, NULLs last (see the
// rebalance path in routes/issues.ts). So smaller is higher, and "top" means
// strictly less than every other position in the destination.

import { Effect } from "effect";
import { Db, type DbError } from "../effects";

/**
 * Gap between adjacent hand-ordered issues.
 *
 * Lives here rather than in `routes/issues.ts` so this module doesn't import
 * from a route (which imports this one). `routes/issues.ts` re-exports it, so
 * existing importers are unaffected.
 *
 * Mirrored at `web/src/lib/order.ts` — keep the two in lockstep.
 */
export const POSITION_STEP = 1000;

/**
 * A position strictly above everything currently in the destination.
 *
 * `min - POSITION_STEP` rather than the `min - 1` the ticket sketches. Both
 * satisfy "above everything"; the step matches what this codebase already means
 * by one rank — `after.position - POSITION_STEP` is precisely how the reorder
 * path inserts before the first card — and it leaves room to drop a card
 * between the new arrival and the old top without an immediate rebalance, which
 * a gap of 1 would not.
 *
 * Rows with a NULL position sort last, so they are not part of the minimum: an
 * arrival only has to beat the positioned rows to sit above the whole column.
 * When nothing positioned is there to beat — an empty destination, or one
 * holding only un-backfilled legacy rows — 0 is returned, which is above every
 * NULL and leaves the negative range free for the arrivals after it.
 *
 * The moving issue is excluded from its own minimum. Without that, a container
 * move (where the issue is already among the rows being scanned) would compare
 * against itself and ratchet its own position down on every no-op-ish move.
 */
const topPosition = (
  scopeColumn: string,
  scopeValue: string,
  boardId: string,
  excludeIssueId: string,
): Effect.Effect<number, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    // One line, deliberately. tests/dbMock.ts dispatches on a literal SQL
    // prefix, so a wrapped string would make the match depend on this file's
    // indentation — and a mock miss there is silent, not an error.
    const row = yield* db.queryFirst<{ m: number | null }>(
      `SELECT MIN(position) AS m FROM issueCache WHERE board_id = ? AND ${scopeColumn} = ? AND id != ? AND position IS NOT NULL`,
      [boardId, scopeValue, excludeIssueId],
    );
    const min = row?.m;
    return min === null || min === undefined ? 0 : min - POSITION_STEP;
  });

/** A position that puts `issueId` above every other issue in `columnId`. */
export const topOfColumnPosition = (params: {
  readonly boardId: string;
  readonly columnId: string;
  readonly issueId: string;
}): Effect.Effect<number, DbError, Db> =>
  topPosition("column_id", params.columnId, params.boardId, params.issueId);

/** A position that puts `issueId` above every other issue in `container`. */
export const topOfContainerPosition = (params: {
  readonly boardId: string;
  readonly container: string;
  readonly issueId: string;
}): Effect.Effect<number, DbError, Db> =>
  topPosition("container", params.container, params.boardId, params.issueId);
