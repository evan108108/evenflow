// Sprint tide computation (EFB-22).
//
// The tide is points remaining — committed minus done — sampled once per UTC
// day. This module is deliberately PURE: it takes plain fact objects and
// returns plain readings, no Db and no Effect. Everything here is replay over
// audit rows, so keeping it pure is what makes it unit-testable against
// fixtures instead of a live database.
//
// Replay, not snapshot. Every value is reconstructed "as of" an instant from
// three audit trails — sprintMembership (scope), statusChangeCache (done-ness)
// and issueEstimateHistory (points). Reading today's issueCache row instead
// would let a re-estimate rewrite history: bump a 3pt issue to 8pt in week two
// and every earlier day silently redraws as if it had always been 8pt.
//
// Two scopes share the code path:
//   * sprint — scope is the membership windows for one sprint.
//   * kanban — no sprint, so the board is the virtual sprint: every issue is
//     in scope from creation until it has been Done for longer than the
//     board's done_window_days. That mirrors what the Kanban Done column
//     actually shows, and it is what stops `committed_pts` from growing
//     without bound over the life of a board.

import { isDoneStatus, type Column } from "../../columns";

export const DAY_MS = 86_400_000;
export const DEFAULT_TIDE_DAYS = 7;
export const MAX_TIDE_DAYS = 90;

/**
 * Points per day of slope needed to call the tide moving rather than flat.
 * Below this the arrow reads "—": day-to-day noise on a small sprint should
 * not flicker the badge between ↗ and ↘.
 */
export const TIDE_DIRECTION_PT_PER_DAY = 1;

/** "out" = burning down (↘), "in" = scope rising (↗), "flat" = neither (—). */
export type TideDirection = "in" | "out" | "flat";

export interface TideDay {
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly day_start_ms: number;
  readonly committed_pts: number;
  readonly done_pts: number;
  readonly remaining_pts: number;
  readonly adds_today: number;
  readonly drops_today: number;
}

export interface EstimateChange {
  readonly occurred_at_ms: number;
  readonly prev_estimate: number | null;
  readonly next_estimate: number | null;
}

export interface StatusChange {
  readonly occurred_at_ms: number;
  readonly from_status: string | null;
  readonly to_status: string | null;
}

/** A half-open scope interval: in scope from `added_at_ms` until `removed_at_ms`. */
export interface ScopeWindow {
  readonly added_at_ms: number;
  readonly removed_at_ms: number | null;
}

/** Everything replay needs about one issue. Change arrays MUST be ascending. */
export interface TideIssueFacts {
  readonly issue_id: string;
  readonly current_estimate: number | null;
  readonly current_status: string;
  readonly created_at_ms: number;
  readonly estimate_changes: ReadonlyArray<EstimateChange>;
  readonly status_changes: ReadonlyArray<StatusChange>;
  readonly windows: ReadonlyArray<ScopeWindow>;
}

export interface TideInput {
  readonly columns: ReadonlyArray<Column>;
  readonly issues: ReadonlyArray<TideIssueFacts>;
  /**
   * Completing a sprint stamps `removed_at_ms` on every membership row at
   * once, done and carried alike. Evaluated naively, the sprint's last day
   * would read 0/0/0 — not "shore reached", just "scope evaporated". Freezing
   * evaluation an instant before completion keeps the final composition.
   * Null while the sprint is still active.
   */
  readonly scope_closed_at_ms: number | null;
  /** Kanban scope only: how long a Done issue stays counted. Null for sprints. */
  readonly done_window_ms: number | null;
  /** UTC midnights to report, ascending. */
  readonly days: ReadonlyArray<number>;
}

export const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

export const dayKey = (dayStartMs: number): string =>
  new Date(dayStartMs).toISOString().slice(0, 10);

/** The last representable instant of a day — what "as of end of day" means. */
const dayEndInstant = (dayStartMs: number): number => dayStartMs + DAY_MS - 1;

/** Ascending list of the `count` UTC midnights ending with `endDayStartMs`. */
export const dayRange = (endDayStartMs: number, count: number): number[] => {
  const days: number[] = [];
  for (let i = count - 1; i >= 0; i -= 1) days.push(endDayStartMs - i * DAY_MS);
  return days;
};

/**
 * Points in force at `atMs`. The estimate history stores the value on each
 * side of a change, so rewinding is "the `prev_estimate` of the first change
 * that happened after the instant we care about". Unestimated counts as 0 —
 * an issue with no points cannot move the tide.
 */
export const estimateAt = (facts: TideIssueFacts, atMs: number): number => {
  for (const change of facts.estimate_changes) {
    if (change.occurred_at_ms > atMs) return change.prev_estimate ?? 0;
  }
  return facts.current_estimate ?? 0;
};

/**
 * Rows in `statusChangeCache` that actually move the status. Container moves
 * (backlog/icebox promotions) write a row with BOTH `from_status` and
 * `to_status` null — they record a container transition, not a status one.
 * Treating those as status changes makes an issue appear to revert to
 * whatever it reads today the moment it's moved between containers, which
 * silently understates `done_pts` for every day in between.
 */
const statusTransitions = (facts: TideIssueFacts): ReadonlyArray<StatusChange> =>
  facts.status_changes.filter((c) => c.to_status !== null);

/**
 * Status in force at `atMs`. Three cases: after some transitions (the latest
 * `to_status` wins), before every recorded one (the first transition's
 * `from_status` — the state it moved away from), or no history at all
 * (whatever the issue reads today).
 */
export const statusAt = (facts: TideIssueFacts, atMs: number): string => {
  const changes = statusTransitions(facts);
  if (changes.length === 0) return facts.current_status;
  let latest: string | undefined;
  for (const change of changes) {
    if (change.occurred_at_ms > atMs) break;
    if (change.to_status !== null) latest = change.to_status;
  }
  if (latest === undefined) {
    return changes[0]?.from_status ?? facts.current_status;
  }
  return latest;
};

const isDoneAt = (
  columns: ReadonlyArray<Column>,
  facts: TideIssueFacts,
  atMs: number,
): boolean => isDoneStatus(columns, statusAt(facts, atMs));

/**
 * When the issue entered the Done run it is sitting in at `atMs`, or null if
 * it is not Done then. Re-opening and re-closing restarts the clock, which is
 * what keeps a re-opened issue from instantly aging back out of the kanban
 * Done window.
 */
const doneSinceMs = (
  columns: ReadonlyArray<Column>,
  facts: TideIssueFacts,
  atMs: number,
): number | null => {
  const changes = statusTransitions(facts);
  const first = changes[0];
  let done =
    first === undefined
      ? isDoneStatus(columns, facts.current_status)
      : isDoneStatus(columns, first.from_status ?? facts.current_status);
  // Predating every change, we only know done-ness, never when it started.
  let since: number | null = done ? facts.created_at_ms : null;
  for (const change of changes) {
    if (change.occurred_at_ms > atMs) break;
    if (change.to_status === null) continue;
    const nowDone = isDoneStatus(columns, change.to_status);
    if (nowDone && !done) since = change.occurred_at_ms;
    else if (!nowDone) since = null;
    done = nowDone;
  }
  return done ? since : null;
};

const inScopeAt = (input: TideInput, facts: TideIssueFacts, atMs: number): boolean => {
  const at =
    input.scope_closed_at_ms === null ? atMs : Math.min(atMs, input.scope_closed_at_ms - 1);
  const windowed = facts.windows.some(
    (w) => w.added_at_ms <= at && (w.removed_at_ms === null || w.removed_at_ms > at),
  );
  if (!windowed) return false;
  if (input.done_window_ms === null) return true;
  const since = doneSinceMs(input.columns, facts, at);
  return since === null || at - since < input.done_window_ms;
};

interface DayTotals {
  readonly committed: number;
  readonly done: number;
  readonly inScope: ReadonlySet<string>;
}

const totalsAt = (input: TideInput, atMs: number): DayTotals => {
  let committed = 0;
  let done = 0;
  const inScope = new Set<string>();
  for (const facts of input.issues) {
    if (!inScopeAt(input, facts, atMs)) continue;
    inScope.add(facts.issue_id);
    const pts = estimateAt(facts, atMs);
    committed += pts;
    if (isDoneAt(input.columns, facts, atMs)) done += pts;
  }
  return { committed, done, inScope };
};

/**
 * Replay one reading per requested day.
 *
 * `adds_today` / `drops_today` are reconciling by construction: scope entries
 * and exits are counted directly, then whatever movement in `committed_pts`
 * they fail to explain — a mid-sprint re-estimate — is folded into whichever
 * side it belongs on. That preserves the invariant
 *
 *   remaining(D) === remaining(D-1) + adds(D) - drops(D) - (done(D) - done(D-1))
 *
 * which `tests/tide-compute.test.ts` asserts on every generated day. Deriving
 * the two counters independently would let them drift from `committed_pts`
 * and quietly stop adding up.
 */
export const computeTide = (input: TideInput): TideDay[] => {
  const out: TideDay[] = [];
  for (const dayStart of input.days) {
    const end = dayEndInstant(dayStart);
    const prevEnd = dayStart - 1;
    const today = totalsAt(input, end);
    const yesterday = totalsAt(input, prevEnd);

    let scopeAdds = 0;
    let scopeDrops = 0;
    for (const facts of input.issues) {
      const wasIn = yesterday.inScope.has(facts.issue_id);
      const isIn = today.inScope.has(facts.issue_id);
      if (isIn && !wasIn) scopeAdds += estimateAt(facts, end);
      else if (wasIn && !isIn) scopeDrops += estimateAt(facts, prevEnd);
    }
    const unexplained = today.committed - yesterday.committed - (scopeAdds - scopeDrops);

    out.push({
      day: dayKey(dayStart),
      day_start_ms: dayStart,
      committed_pts: today.committed,
      done_pts: today.done,
      remaining_pts: today.committed - today.done,
      adds_today: scopeAdds + Math.max(unexplained, 0),
      drops_today: scopeDrops + Math.max(-unexplained, 0),
    });
  }
  return out;
};

/**
 * Which way the tide is running across the window. Slope is measured
 * end-to-end rather than on the last hop so a single quiet day doesn't read
 * as the tide turning.
 */
export const tideDirection = (days: ReadonlyArray<TideDay>): TideDirection => {
  if (days.length < 2) return "flat";
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return "flat";
  const slope = (last.remaining_pts - first.remaining_pts) / (days.length - 1);
  if (slope <= -TIDE_DIRECTION_PT_PER_DAY) return "out";
  if (slope >= TIDE_DIRECTION_PT_PER_DAY) return "in";
  return "flat";
};
