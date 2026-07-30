// EFB-22: the D1 cache half of the tide — reading a window, and closing out a
// day that has ended.
//
// Readings are always computed live from audit rows, never read back out of
// sprintTideSnapshot. The table is the cache and the substrate-publish ledger,
// not the answer: a snapshot row exists so the day has a durable 30560/30565
// event and an id to point at, while the numbers the API returns stay
// correct even for days that were never successfully published.
//
// Roll-forward is idempotent by construction — a day already holding a row is
// skipped — so the lazy path (first read of a new day) and the cron path can
// race without double-publishing.

import { Clock, Effect } from "effect";
import { Db, type DbError } from "../../effects";
import { DAY_MS, utcDayStart, type TideDay } from "./compute";

/** A sprint tide, or — with a null sprint — a board's kanban-only tide. */
export interface TideSubject {
  readonly board_id: string;
  readonly sprint_id: string | null;
}

const existingSnapshotId = (subject: TideSubject, dayStartMs: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row =
      subject.sprint_id === null
        ? yield* db.queryFirst<{ id: string }>(
            "SELECT id FROM sprintTideSnapshot WHERE board_id = ? AND sprint_id IS NULL AND day_start_ms = ?",
            [subject.board_id, dayStartMs],
          )
        : yield* db.queryFirst<{ id: string }>(
            "SELECT id FROM sprintTideSnapshot WHERE sprint_id = ? AND day_start_ms = ?",
            [subject.sprint_id, dayStartMs],
          );
    return row?.id ?? null;
  });

/**
 * Write one day's reading, replacing any existing row for that (subject, day).
 * Returns the row id so a successful substrate publish can stamp it.
 *
 * SELECT-then-write rather than ON CONFLICT: the uniqueness that matters here
 * is enforced by two *partial* indexes (one per scope), and spelling those
 * predicates back out as an upsert target is a good deal easier to get subtly
 * wrong than two plain statements.
 */
export const writeSnapshot = (
  subject: TideSubject,
  reading: TideDay,
  computedAtMs: number,
): Effect.Effect<string, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const existing = yield* existingSnapshotId(subject, reading.day_start_ms);
    if (existing !== null) {
      yield* db.execute(
        `UPDATE sprintTideSnapshot
            SET committed_pts = ?, done_pts = ?, remaining_pts = ?,
                adds_today = ?, drops_today = ?, computed_at_ms = ?
          WHERE id = ?`,
        [
          reading.committed_pts,
          reading.done_pts,
          reading.remaining_pts,
          reading.adds_today,
          reading.drops_today,
          computedAtMs,
          existing,
        ],
      );
      return existing;
    }
    const id = crypto.randomUUID();
    yield* db.execute(
      `INSERT INTO sprintTideSnapshot
         (id, sprint_id, board_id, day_start_ms, committed_pts, done_pts,
          remaining_pts, adds_today, drops_today, computed_at_ms, substrate_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        id,
        subject.sprint_id,
        subject.board_id,
        reading.day_start_ms,
        reading.committed_pts,
        reading.done_pts,
        reading.remaining_pts,
        reading.adds_today,
        reading.drops_today,
        computedAtMs,
      ],
    );
    return id;
  });

/** Stamp the 4a event id onto a snapshot after a successful publish. */
export const stampSubstrateEventId = (
  snapshotId: string,
  eventId: string,
): Effect.Effect<void, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.execute("UPDATE sprintTideSnapshot SET substrate_event_id = ? WHERE id = ?", [
      eventId,
      snapshotId,
    ]);
  });

export interface RolledForwardDay {
  readonly snapshot_id: string;
  readonly reading: TideDay;
}

/**
 * Close out the most recent finished day if it hasn't been closed already.
 * Null means "nothing to do", for any of three reasons: the requested window
 * was too short to contain yesterday, the day already has a row, or the day
 * ended before the sprint (or board) existed.
 *
 * That last guard is what keeps the first read on a fresh subject from
 * minting — and publishing — a 0/0/0 snapshot for a day it wasn't around for.
 * A day with no history is meant to have no bar, not a bar reading zero.
 *
 * Today is deliberately never written: it is still moving, and publishing a
 * replaceable event per read would put a 4a write on the read path.
 */
export const rollForwardClosedDay = (
  subject: TideSubject,
  readings: ReadonlyArray<TideDay>,
  nowMs: number,
  subjectStartedAtMs: number,
): Effect.Effect<RolledForwardDay | null, DbError, Db> =>
  Effect.gen(function* () {
    const yesterday = utcDayStart(nowMs) - DAY_MS;
    if (yesterday + DAY_MS - 1 < subjectStartedAtMs) return null;
    const reading = readings.find((d) => d.day_start_ms === yesterday);
    if (reading === undefined) return null;
    if ((yield* existingSnapshotId(subject, yesterday)) !== null) return null;
    const id = yield* writeSnapshot(subject, reading, nowMs);
    return { snapshot_id: id, reading };
  });

/** `rollForwardClosedDay` against the wall clock. */
export const rollForwardNow = (
  subject: TideSubject,
  readings: ReadonlyArray<TideDay>,
  subjectStartedAtMs: number,
): Effect.Effect<RolledForwardDay | null, DbError, Db> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* rollForwardClosedDay(subject, readings, now, subjectStartedAtMs);
  });
