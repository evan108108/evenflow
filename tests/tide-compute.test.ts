// EFB-22: sprint tide replay.
//
// compute.ts is pure, so these are fixture tests over hand-built audit rows —
// membership windows, status changes and estimate changes — with the expected
// readings worked out by hand in each case.
//
// The invariant check at the bottom is the load-bearing one: it asserts
// remaining/adds/drops/done actually reconcile on every generated day, which
// is what catches a re-estimate silently unbalancing the counters.

import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  TIDE_DIRECTION_PT_PER_DAY,
  computeTide,
  dayKey,
  dayRange,
  estimateAt,
  statusAt,
  tideDirection,
  utcDayStart,
  type TideInput,
  type TideIssueFacts,
} from "../src/lib/tide/compute";
import type { Column } from "../src/columns";

const COLUMNS: Column[] = [
  { id: "c-todo", name: "Todo", order: 0, enabled: true, category: "todo" },
  { id: "c-doing", name: "In Progress", order: 1, enabled: true, category: "in_progress" },
  { id: "c-done", name: "Done", order: 2, enabled: true, category: "done" },
];

// A fixed UTC midnight to anchor every fixture: 2026-07-20T00:00:00Z.
const D0 = Date.UTC(2026, 6, 20);
const day = (n: number) => D0 + n * DAY_MS;
/** Mid-afternoon on day n — inside the day, never on a boundary. */
const midday = (n: number) => day(n) + 12 * 60 * 60 * 1000;

const issue = (over: Partial<TideIssueFacts> & { issue_id: string }): TideIssueFacts => ({
  current_estimate: null,
  current_status: "Todo",
  created_at_ms: day(0),
  estimate_changes: [],
  status_changes: [],
  windows: [{ added_at_ms: day(0), removed_at_ms: null }],
  ...over,
});

const sprintInput = (
  issues: TideIssueFacts[],
  days: number[],
  over: Partial<TideInput> = {},
): TideInput => ({
  columns: COLUMNS,
  issues,
  scope_closed_at_ms: null,
  done_window_ms: null,
  days,
  ...over,
});

// ── day helpers ───────────────────────────────────────────────────────────

describe("day helpers", () => {
  it("floors to UTC midnight and formats the key", () => {
    expect(utcDayStart(midday(3))).toBe(day(3));
    expect(utcDayStart(day(3))).toBe(day(3));
    expect(dayKey(D0)).toBe("2026-07-20");
  });

  it("builds an ascending range ending on the given day", () => {
    expect(dayRange(day(4), 3)).toEqual([day(2), day(3), day(4)]);
    expect(dayRange(day(0), 1)).toEqual([day(0)]);
  });
});

// ── point-in-time replay ──────────────────────────────────────────────────

describe("estimateAt", () => {
  const f = issue({
    issue_id: "i1",
    current_estimate: 8,
    estimate_changes: [
      { occurred_at_ms: midday(1), prev_estimate: null, next_estimate: 3 },
      { occurred_at_ms: midday(3), prev_estimate: 3, next_estimate: 8 },
    ],
  });

  it("rewinds to the value in force at the instant, not today's value", () => {
    expect(estimateAt(f, midday(0))).toBe(0); // unestimated before the first change
    expect(estimateAt(f, midday(2))).toBe(3); // after the first change, before the second
    expect(estimateAt(f, midday(4))).toBe(8); // no later change → current
  });

  it("treats unestimated as zero points", () => {
    expect(estimateAt(issue({ issue_id: "i2" }), midday(9))).toBe(0);
  });
});

describe("statusAt", () => {
  const f = issue({
    issue_id: "i1",
    current_status: "Done",
    status_changes: [
      { occurred_at_ms: midday(1), from_status: "Todo", to_status: "In Progress" },
      { occurred_at_ms: midday(2), from_status: "In Progress", to_status: "Done" },
    ],
  });

  it("returns the status the issue moved away from when the instant predates all history", () => {
    expect(statusAt(f, midday(0))).toBe("Todo");
  });

  it("returns the latest transition at or before the instant", () => {
    expect(statusAt(f, midday(1) + 1)).toBe("In Progress");
    expect(statusAt(f, midday(5))).toBe("Done");
  });

  it("falls back to the current status with no recorded changes", () => {
    expect(statusAt(issue({ issue_id: "i2", current_status: "Todo" }), midday(3))).toBe("Todo");
  });
});

// ── the sprint burndown ───────────────────────────────────────────────────

describe("computeTide — sprint scope", () => {
  it("burns down as issues reach Done", () => {
    // Three issues, 5+3+2 = 10 pts, committed day 0. One ships day 1, one day 3.
    const issues = [
      issue({
        issue_id: "a",
        current_estimate: 5,
        current_status: "Done",
        status_changes: [{ occurred_at_ms: midday(1), from_status: "Todo", to_status: "Done" }],
      }),
      issue({
        issue_id: "b",
        current_estimate: 3,
        current_status: "Done",
        status_changes: [{ occurred_at_ms: midday(3), from_status: "Todo", to_status: "Done" }],
      }),
      issue({ issue_id: "c", current_estimate: 2 }),
    ];
    const out = computeTide(sprintInput(issues, dayRange(day(3), 4)));

    expect(out.map((d) => d.remaining_pts)).toEqual([10, 5, 5, 2]);
    expect(out.map((d) => d.done_pts)).toEqual([0, 5, 5, 8]);
    expect(out.every((d) => d.committed_pts === 10)).toBe(true);
    expect(out.map((d) => d.day)).toEqual([
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
    ]);
  });

  it("counts a mid-sprint add as adds_today and raises remaining", () => {
    const issues = [
      issue({ issue_id: "a", current_estimate: 5 }),
      issue({
        issue_id: "late",
        current_estimate: 4,
        windows: [{ added_at_ms: midday(2), removed_at_ms: null }],
      }),
    ];
    const out = computeTide(sprintInput(issues, dayRange(day(3), 4)));

    expect(out.map((d) => d.remaining_pts)).toEqual([5, 5, 9, 9]);
    expect(out.map((d) => d.adds_today)).toEqual([5, 0, 4, 0]);
    expect(out.map((d) => d.drops_today)).toEqual([0, 0, 0, 0]);
  });

  it("counts an issue pulled out of the sprint as drops_today", () => {
    const issues = [
      issue({ issue_id: "a", current_estimate: 5 }),
      issue({
        issue_id: "yanked",
        current_estimate: 4,
        windows: [{ added_at_ms: day(0), removed_at_ms: midday(2) }],
      }),
    ];
    const out = computeTide(sprintInput(issues, dayRange(day(3), 4)));

    expect(out.map((d) => d.remaining_pts)).toEqual([9, 9, 5, 5]);
    expect(out.map((d) => d.drops_today)).toEqual([0, 0, 4, 0]);
  });

  it("re-opening an issue raises remaining again", () => {
    const issues = [
      issue({
        issue_id: "a",
        current_estimate: 5,
        current_status: "In Progress",
        status_changes: [
          { occurred_at_ms: midday(1), from_status: "Todo", to_status: "Done" },
          { occurred_at_ms: midday(3), from_status: "Done", to_status: "In Progress" },
        ],
      }),
    ];
    const out = computeTide(sprintInput(issues, dayRange(day(3), 4)));

    expect(out.map((d) => d.remaining_pts)).toEqual([5, 0, 0, 5]);
  });

  it("does not let a re-estimate rewrite earlier days", () => {
    // Estimated 3 on day 0, re-estimated to 8 on day 2. Days 0-1 must still
    // read 3 — this is the whole reason issueEstimateHistory exists.
    const issues = [
      issue({
        issue_id: "a",
        current_estimate: 8,
        estimate_changes: [{ occurred_at_ms: midday(2), prev_estimate: 3, next_estimate: 8 }],
      }),
    ];
    const out = computeTide(sprintInput(issues, dayRange(day(3), 4)));

    expect(out.map((d) => d.remaining_pts)).toEqual([3, 3, 8, 8]);
    // The +5 has to land somewhere or the counters stop reconciling.
    expect(out.map((d) => d.adds_today)).toEqual([3, 0, 5, 0]);
  });

  it("reports zeroes, not a crash, for a sprint with no audit rows", () => {
    const out = computeTide(sprintInput([], dayRange(day(2), 3)));
    expect(out).toHaveLength(3);
    for (const d of out) {
      expect(d).toMatchObject({
        committed_pts: 0,
        done_pts: 0,
        remaining_pts: 0,
        adds_today: 0,
        drops_today: 0,
      });
    }
    expect(tideDirection(out)).toBe("flat");
  });

  it("freezes a completed sprint's final composition instead of reading zero", () => {
    // Completing stamps removed_at_ms on every membership row at once.
    const completedAt = midday(2);
    const issues = [
      issue({
        issue_id: "a",
        current_estimate: 5,
        current_status: "Done",
        status_changes: [{ occurred_at_ms: midday(1), from_status: "Todo", to_status: "Done" }],
        windows: [{ added_at_ms: day(0), removed_at_ms: completedAt }],
      }),
      issue({
        issue_id: "b",
        current_estimate: 3,
        windows: [{ added_at_ms: day(0), removed_at_ms: completedAt }],
      }),
    ];
    const frozen = computeTide(
      sprintInput(issues, dayRange(day(3), 4), { scope_closed_at_ms: completedAt }),
    );
    expect(frozen.map((d) => d.committed_pts)).toEqual([8, 8, 8, 8]);
    expect(frozen.map((d) => d.remaining_pts)).toEqual([8, 3, 3, 3]);

    // Without the freeze the same rows collapse to nothing after completion.
    const naive = computeTide(sprintInput(issues, dayRange(day(3), 4)));
    expect(naive.map((d) => d.committed_pts)).toEqual([8, 8, 0, 0]);
  });
});

// ── the kanban virtual sprint ─────────────────────────────────────────────

describe("computeTide — kanban scope", () => {
  const doneWindow = 2 * DAY_MS;

  it("drops an issue out of scope once it has been Done longer than the window", () => {
    const issues = [
      issue({
        issue_id: "shipped",
        current_estimate: 5,
        current_status: "Done",
        status_changes: [{ occurred_at_ms: midday(0), from_status: "Todo", to_status: "Done" }],
      }),
      issue({ issue_id: "open", current_estimate: 3 }),
    ];
    const out = computeTide(
      sprintInput(issues, dayRange(day(4), 5), { done_window_ms: doneWindow }),
    );

    // Done midday(0): in scope on days 0-1, aged out from day 2 on.
    expect(out.map((d) => d.committed_pts)).toEqual([8, 8, 3, 3, 3]);
    expect(out.map((d) => d.done_pts)).toEqual([5, 5, 0, 0, 0]);
    expect(out.map((d) => d.remaining_pts)).toEqual([3, 3, 3, 3, 3]);
    expect(out[2]?.drops_today).toBe(5);
  });

  it("restarts the window clock when an issue is re-opened and closed again", () => {
    const issues = [
      issue({
        issue_id: "yo-yo",
        current_estimate: 5,
        current_status: "Done",
        status_changes: [
          { occurred_at_ms: midday(0), from_status: "Todo", to_status: "Done" },
          { occurred_at_ms: midday(1), from_status: "Done", to_status: "In Progress" },
          { occurred_at_ms: midday(2), from_status: "In Progress", to_status: "Done" },
        ],
      }),
    ];
    const out = computeTide(
      sprintInput(issues, dayRange(day(4), 5), { done_window_ms: doneWindow }),
    );

    // Second close on day 2 → still in scope days 2-3, out on day 4.
    expect(out.map((d) => d.committed_pts)).toEqual([5, 5, 5, 5, 0]);
  });
});

// ── direction ─────────────────────────────────────────────────────────────

describe("tideDirection", () => {
  const withRemaining = (values: number[]) =>
    computeTide(
      sprintInput(
        values.map((v, i) =>
          issue({
            issue_id: `pad-${i}`,
            current_estimate: v,
            windows: [{ added_at_ms: day(i), removed_at_ms: day(i) + DAY_MS }],
          }),
        ),
        dayRange(day(values.length - 1), values.length),
      ),
    );

  it("is flat with fewer than two days", () => {
    expect(tideDirection([])).toBe("flat");
    expect(tideDirection(withRemaining([5]))).toBe("flat");
  });

  it("reads out when remaining falls faster than the threshold", () => {
    const days = withRemaining([10, 7, 4]);
    expect(days.map((d) => d.remaining_pts)).toEqual([10, 7, 4]);
    expect(tideDirection(days)).toBe("out");
  });

  it("reads in when remaining climbs faster than the threshold", () => {
    expect(tideDirection(withRemaining([2, 5, 9]))).toBe("in");
  });

  it("reads flat inside the threshold band", () => {
    // Slope of exactly the threshold counts as moving; anything under is flat.
    expect(tideDirection(withRemaining([5, 5, 4]))).toBe("flat");
    expect(tideDirection(withRemaining([6, 5, 4]))).toBe("out");
    expect(TIDE_DIRECTION_PT_PER_DAY).toBe(1);
  });
});

// ── the reconciliation invariant ──────────────────────────────────────────

describe("computeTide invariant", () => {
  it("keeps remaining/adds/drops/done reconciled across a messy sprint", () => {
    const issues = [
      issue({
        issue_id: "a",
        current_estimate: 8,
        current_status: "Done",
        estimate_changes: [{ occurred_at_ms: midday(2), prev_estimate: 3, next_estimate: 8 }],
        status_changes: [{ occurred_at_ms: midday(4), from_status: "Todo", to_status: "Done" }],
      }),
      issue({
        issue_id: "b",
        current_estimate: 2,
        current_status: "In Progress",
        status_changes: [
          { occurred_at_ms: midday(1), from_status: "Todo", to_status: "Done" },
          { occurred_at_ms: midday(3), from_status: "Done", to_status: "In Progress" },
        ],
      }),
      issue({
        issue_id: "c",
        current_estimate: 5,
        windows: [{ added_at_ms: midday(2), removed_at_ms: midday(5) }],
      }),
      issue({ issue_id: "d" }), // unestimated, never moves
    ];
    const days = dayRange(day(6), 7);
    const out = computeTide(sprintInput(issues, days));

    for (let i = 1; i < out.length; i += 1) {
      const prev = out[i - 1]!;
      const cur = out[i]!;
      const predicted =
        prev.remaining_pts + cur.adds_today - cur.drops_today - (cur.done_pts - prev.done_pts);
      expect(cur.remaining_pts, `day ${cur.day} must reconcile`).toBe(predicted);
    }
    // Sanity: the fixture actually exercises movement, so the loop isn't vacuous.
    expect(out.some((d) => d.adds_today > 0)).toBe(true);
    expect(out.some((d) => d.drops_today > 0)).toBe(true);
    expect(out.some((d) => d.done_pts > 0)).toBe(true);
  });
});
