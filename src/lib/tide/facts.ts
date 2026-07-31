// EFB-22: gather the audit rows a tide replay needs out of D1.
//
// The split from compute.ts is deliberate — everything that touches the
// database lives here, everything that does arithmetic lives there. Only this
// half needs a Db; only that half needs testing against fixtures.
//
// Both scopes come out as the same `TideInput`, so the compute path has no
// idea whether it is replaying a sprint or a kanban board.
//
// DUPLICATES ARE EXCLUDED HERE, in the load, not in compute.ts (EFB-30).
// An issue with `duplicate_of_issue_id` set never enters `TideInput` at all,
// so it contributes 0 to committed_pts and 0 to done_pts on every day of the
// replay — including the days before it was marked. That retroactivity is the
// point, not a rounding error: a duplicate was never extra work, it was the
// discovery that the work already had an id. Leaving it in would inflate the
// commitment on every historical day and then "deliver" it for free the
// moment somebody noticed the duplication, which reads as a velocity spike
// earned by filing a ticket twice.
//
// The filter belongs in the query rather than in compute.ts because compute
// is a pure replay over facts and a duplicate has no facts worth replaying;
// filtering there would mean carrying rows through the whole pipeline in
// order to drop them at the end. Note it is a HARD exclusion, unlike the
// done-window test below: no day of the range ever sees the row.

import { Effect } from "effect";
import { Db, type DbError } from "../../effects";
import { isDoneStatus, type Column } from "../../columns";
import {
  DAY_MS,
  type EstimateChange,
  type ScopeWindow,
  type StatusChange,
  type TideInput,
  type TideIssueFacts,
} from "./compute";

/**
 * Max ids per `IN (...)` list. D1 rejects an over-long statement outright, and
 * the failure surfaces as an empty result rather than an error — so chunk
 * rather than trusting the caller's scope to stay small.
 */
const ID_CHUNK = 400;

interface IssueRow {
  readonly id: string;
  readonly estimate: number | null;
  readonly status: string;
  readonly created_at_ms: number;
}

interface MembershipRow {
  readonly issue_id: string;
  readonly added_at_ms: number;
  readonly removed_at_ms: number | null;
}

interface EstimateRow extends EstimateChange {
  readonly issue_id: string;
}

interface StatusRow extends StatusChange {
  readonly issue_id: string;
}

const chunk = <T>(items: ReadonlyArray<T>, size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const placeholders = (n: number): string => new Array(n).fill("?").join(",");

/** Run one query per id chunk and concatenate. Empty ids → no query at all. */
const queryByIds = <Row>(sql: (marks: string) => string, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (ids.length === 0) return [] as Row[];
    const db = yield* Db;
    const out: Row[] = [];
    for (const part of chunk(ids, ID_CHUNK)) {
      const rows = yield* db.queryAll<Row>(sql(placeholders(part.length)), part);
      out.push(...rows);
    }
    return out;
  });

const byIssue = <T extends { issue_id: string }>(
  rows: ReadonlyArray<T>,
): Map<string, T[]> => {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.issue_id);
    if (list === undefined) map.set(row.issue_id, [row]);
    else list.push(row);
  }
  return map;
};

const ascending = <T extends { occurred_at_ms: number }>(rows: T[]): T[] =>
  rows.sort((a, b) => a.occurred_at_ms - b.occurred_at_ms);

/** Pull the change history for a set of issues and attach it to their rows. */
const attachHistory = (
  issues: ReadonlyArray<IssueRow>,
  windowsOf: (issueId: string) => ScopeWindow[],
): Effect.Effect<TideIssueFacts[], DbError, Db> =>
  Effect.gen(function* () {
    const ids = issues.map((i) => i.id);
    const estimates = yield* queryByIds<EstimateRow>(
      (marks) =>
        `SELECT issue_id, occurred_at_ms, prev_estimate, next_estimate FROM issueEstimateHistory WHERE issue_id IN (${marks})`,
      ids,
    );
    const statuses = yield* queryByIds<StatusRow>(
      (marks) =>
        `SELECT issue_id, occurred_at_ms, from_status, to_status FROM statusChangeCache WHERE issue_id IN (${marks})`,
      ids,
    );
    const estimatesBy = byIssue(estimates);
    const statusesBy = byIssue(statuses);

    return issues.map((row) => ({
      issue_id: row.id,
      current_estimate: row.estimate,
      current_status: row.status,
      created_at_ms: row.created_at_ms,
      estimate_changes: ascending(estimatesBy.get(row.id) ?? []),
      status_changes: ascending(statusesBy.get(row.id) ?? []),
      windows: windowsOf(row.id),
    }));
  });

/**
 * Sprint scope: the membership audit trail IS the scope, so every issue that
 * was ever in the sprint is loaded, including ones removed long ago — their
 * windows keep them counted on the days they were actually committed.
 */
export const loadSprintTideInput = (
  sprintId: string,
  columns: ReadonlyArray<Column>,
  sprintCompletedAtMs: number | null,
  days: ReadonlyArray<number>,
): Effect.Effect<TideInput, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const memberships = yield* db.queryAll<MembershipRow>(
      "SELECT issue_id, added_at_ms, removed_at_ms FROM sprintMembership WHERE sprint_id = ?",
      [sprintId],
    );
    const windows = new Map<string, ScopeWindow[]>();
    for (const m of memberships) {
      const list = windows.get(m.issue_id);
      const w: ScopeWindow = { added_at_ms: m.added_at_ms, removed_at_ms: m.removed_at_ms };
      if (list === undefined) windows.set(m.issue_id, [w]);
      else list.push(w);
    }
    const issues = yield* queryByIds<IssueRow>(
      (marks) =>
        `SELECT id, estimate, status, created_at_ms FROM issueCache WHERE id IN (${marks}) AND duplicate_of_issue_id IS NULL`,
      [...windows.keys()],
    );
    const facts = yield* attachHistory(issues, (id) => windows.get(id) ?? []);
    return {
      columns,
      issues: facts,
      scope_closed_at_ms: sprintCompletedAtMs,
      done_window_ms: null,
      days,
    };
  });

/**
 * Kanban scope: the board is the virtual sprint, bounded by
 * `done_window_days`. Loading every issue the board ever had would be both
 * slow and pointless, so the query drops issues that are provably out of
 * scope for the whole window — currently parked in a Done column AND without
 * a status change recent enough for the window to still cover them. Anything
 * still open, or that moved recently, gets replayed properly.
 */
export const loadKanbanTideInput = (
  boardId: string,
  columns: ReadonlyArray<Column>,
  doneWindowDays: number,
  days: ReadonlyArray<number>,
): Effect.Effect<TideInput, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const doneWindowMs = doneWindowDays * DAY_MS;
    const rangeStart = days[0] ?? 0;
    const rangeEnd = (days[days.length - 1] ?? 0) + DAY_MS - 1;
    const activitySince = rangeStart - doneWindowMs;
    const openNames = columns
      .filter((col) => !isDoneStatus(columns, col.name))
      .map((col) => col.name);

    // No open columns at all (pathological board config) → the status test
    // can't help, so fall back to the activity test alone.
    const openTest =
      openNames.length === 0 ? "0 = 1" : `i.status IN (${placeholders(openNames.length)})`;
    const issues = yield* db.queryAll<IssueRow>(
      `SELECT i.id, i.estimate, i.status, i.created_at_ms
         FROM issueCache i
        WHERE i.board_id = ?
          AND i.created_at_ms <= ?
          AND i.duplicate_of_issue_id IS NULL
          AND (${openTest}
               OR EXISTS (SELECT 1 FROM statusChangeCache s
                           WHERE s.issue_id = i.id AND s.occurred_at_ms >= ?))`,
      [boardId, rangeEnd, ...openNames, activitySince],
    );
    const facts = yield* attachHistory(issues, (_id) => []);
    // Kanban has no membership rows: an issue is in scope from creation, and
    // the done-window test in compute.ts is what takes it back out.
    const withWindows = facts.map((f) => ({
      ...f,
      windows: [{ added_at_ms: f.created_at_ms, removed_at_ms: null }] as ScopeWindow[],
    }));
    return {
      columns,
      issues: withWindows,
      scope_closed_at_ms: null,
      done_window_ms: doneWindowMs,
      days,
    };
  });
