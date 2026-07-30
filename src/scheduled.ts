// Cron entrypoint (EFB-22). Evenflow's first scheduled handler.
//
// The tide's read path already rolls itself forward: the first `GET /tide` of
// a new day closes out the previous one. This exists for the boards nobody
// visited — without it a quiet board's history is a row of gaps, and gaps are
// indistinguishable from "the tide was zero".
//
// Kept thin on purpose. Everything it does is the same roll-forward the read
// path runs, so there is one implementation of "close out a day" and the cron
// can never drift from what a visit would have produced.
//
// Deliberately NOT a catch-up loop over every missed day: a reading is
// recomputed from audit rows on demand, so a board that was dark for a week
// loses substrate events for those days, not the numbers. Backfilling them
// would mean a burst of replaceable-event publishes to say what the next read
// already says correctly.

import { Effect, Exit } from "effect";
import { Db, bootstrap, type WorkerEnv } from "./effects";
import { DAY_MS, computeTide, dayRange, utcDayStart } from "./lib/tide/compute";
import { loadKanbanTideInput, loadSprintTideInput } from "./lib/tide/facts";
import { rollForwardClosedDay, type TideSubject } from "./lib/tide/snapshot";
import { publishTide } from "./lib/tide/publish";
import { parseBoardRow } from "./shapes";

/**
 * Two days: yesterday (the one being closed) and the day before it, which
 * `computeTide` needs as the baseline for `adds_today` / `drops_today`.
 */
const ROLL_FORWARD_DAYS = 2;

interface ActiveSprintRow {
  readonly sprint_id: string;
  readonly board_id: string;
  readonly sprint_created_at_ms: number;
  readonly completed_at_ms: number | null;
}

interface KanbanBoardRow {
  readonly id: string;
}

/** Close out yesterday for one subject, publishing if a day actually closed. */
const rollSubject = (
  subject: TideSubject,
  input: Parameters<typeof computeTide>[0],
  subjectStartedAtMs: number,
  nowMs: number,
) =>
  Effect.gen(function* () {
    const closed = yield* rollForwardClosedDay(
      subject,
      computeTide(input),
      nowMs,
      subjectStartedAtMs,
    );
    if (closed === null) return false;
    yield* publishTide({
      subject,
      snapshot_id: closed.snapshot_id,
      reading: closed.reading,
      at_ms: nowMs,
    });
    return true;
  });

/**
 * Roll every active sprint forward, then every board with no active sprint
 * (those run kanban-only, where `done_window_days` is the virtual sprint).
 *
 * One subject's failure must not strand the rest, so each is isolated: a
 * board with a corrupt row costs that board's snapshot, not the whole night.
 */
export const rollForwardAllTides = (nowMs: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const days = dayRange(utcDayStart(nowMs) - DAY_MS, ROLL_FORWARD_DAYS);
    let closed = 0;
    let failed = 0;

    const sprints = yield* db.queryAll<ActiveSprintRow>(
      `SELECT s.id AS sprint_id, s.board_id, s.created_at_ms AS sprint_created_at_ms,
              s.completed_at_ms
         FROM sprintCache s
        WHERE s.status = 'active'`,
    );
    const boardsWithActiveSprint = new Set(sprints.map((s) => s.board_id));

    for (const row of sprints) {
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          const boardRow = yield* db.queryFirst("SELECT * FROM boardCache WHERE id = ?", [
            row.board_id,
          ]);
          if (boardRow === null) return false;
          const board = parseBoardRow(boardRow);
          const input = yield* loadSprintTideInput(
            row.sprint_id,
            board.columns,
            row.completed_at_ms,
            days,
          );
          return yield* rollSubject(
            { board_id: row.board_id, sprint_id: row.sprint_id },
            input,
            row.sprint_created_at_ms,
            nowMs,
          );
        }),
      );
      if (Exit.isFailure(result)) {
        failed += 1;
        console.log(
          JSON.stringify({ warn: "tide-cron-subject-failed", sprint_id: row.sprint_id }),
        );
      } else if (result.value) closed += 1;
    }

    const boards = yield* db.queryAll<KanbanBoardRow>("SELECT id FROM boardCache");
    for (const board of boards) {
      if (boardsWithActiveSprint.has(board.id)) continue;
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          const boardRow = yield* db.queryFirst("SELECT * FROM boardCache WHERE id = ?", [
            board.id,
          ]);
          if (boardRow === null) return false;
          const shape = parseBoardRow(boardRow);
          const input = yield* loadKanbanTideInput(
            shape.id,
            shape.columns,
            shape.done_window_days,
            days,
          );
          return yield* rollSubject(
            { board_id: shape.id, sprint_id: null },
            input,
            shape.created_at_ms,
            nowMs,
          );
        }),
      );
      if (Exit.isFailure(result)) {
        failed += 1;
        console.log(JSON.stringify({ warn: "tide-cron-subject-failed", board_id: board.id }));
      } else if (result.value) closed += 1;
    }

    console.log(
      JSON.stringify({
        info: "tide-cron-complete",
        sprints: sprints.length,
        boards: boards.length,
        closed,
        failed,
      }),
    );
    return { closed, failed };
  });

/**
 * Cloudflare's scheduled entrypoint. The work runs inside `waitUntil` so the
 * handler returns immediately and the runtime still waits for it — a cron
 * that awaited inline would hold the invocation open for no benefit.
 */
export const scheduled = (
  event: ScheduledController,
  env: WorkerEnv,
  ctx: ExecutionContext,
): void => {
  ctx.waitUntil(
    Effect.runPromise(
      Effect.provide(rollForwardAllTides(event.scheduledTime), bootstrap(env)).pipe(
        Effect.catchAllDefect((defect) =>
          Effect.sync(() => {
            console.log(
              JSON.stringify({ warn: "tide-cron-defect", detail: String(defect) }),
            );
            return { closed: 0, failed: 0 };
          }),
        ),
      ),
    ),
  );
};
