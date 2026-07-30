// EFB-22 TideBadge — the pure bits of the badge.
//
// The fetch path needs the app runtime and an ApiClient layer, which the other
// component tests deliberately avoid standing up. What's worth pinning down
// here is the geometry and the direction vocabulary: the sparkline plots
// REMAINING (not throughput), and ↘ has to mean "going out", which reads
// backwards often enough to be worth a test.

import { describe, expect, it } from "vitest";
import {
  DIRECTION_GLYPH,
  TIDE_WINDOW_DAYS,
  sparklinePoints,
  tideTitle,
  type TideDay,
  type TideReading,
} from "./TideBadge";

const day = (remaining: number, i: number): TideDay => ({
  day: `2026-07-${String(20 + i).padStart(2, "0")}`,
  day_start_ms: Date.UTC(2026, 6, 20 + i),
  committed_pts: 10,
  done_pts: 10 - remaining,
  remaining_pts: remaining,
  adds_today: 0,
  drops_today: 0,
});

const ys = (points: string): number[] =>
  points.split(" ").map((p) => Number(p.split(",")[1]));

describe("sparklinePoints", () => {
  it("is empty for no days rather than drawing a stray segment", () => {
    expect(sparklinePoints([])).toBe("");
  });

  it("plots a burn-down as a descending line", () => {
    const points = sparklinePoints([10, 7, 4, 1].map(day));
    const heights = ys(points);
    // Falling remaining → increasing y (SVG y grows downward).
    expect(heights[0]).toBeLessThan(heights[3]!);
    expect([...heights].sort((a, b) => a - b)).toEqual(heights);
  });

  it("spans the full chart width regardless of how many days it has", () => {
    for (const count of [2, 5, 7]) {
      const xs = sparklinePoints(
        Array.from({ length: count }, (_, i) => day(5, i)),
      )
        .split(" ")
        .map((p) => Number(p.split(",")[0]));
      expect(xs[0]).toBe(3);
      expect(xs[xs.length - 1]).toBeCloseTo(87, 5);
    }
  });

  it("draws a flat all-zero window on the baseline instead of dividing by zero", () => {
    const points = sparklinePoints([0, 0, 0].map(day));
    expect(ys(points).every((y) => y === 21)).toBe(true);
  });

  it("scales to the window's own max, so a small sprint is still legible", () => {
    const small = ys(sparklinePoints([3, 0].map(day)));
    const large = ys(sparklinePoints([300, 0].map(day)));
    expect(small).toEqual(large);
  });
});

describe("DIRECTION_GLYPH", () => {
  it("points down when the tide is going out — remaining falling", () => {
    expect(DIRECTION_GLYPH.out).toBe("↘");
    expect(DIRECTION_GLYPH.in).toBe("↗");
    expect(DIRECTION_GLYPH.flat).toBe("—");
  });
});

describe("tideTitle (EFB-25)", () => {
  const today: TideDay = {
    day: "2026-07-30",
    day_start_ms: Date.UTC(2026, 6, 30),
    committed_pts: 20,
    done_pts: 8,
    remaining_pts: 12,
    adds_today: 3,
    drops_today: 1,
  };
  const full = (over: Partial<TideReading> = {}): TideReading => ({
    days: Array.from({ length: TIDE_WINDOW_DAYS }, (_, i) => day(12, i)),
    today,
    direction: "out",
    ...over,
  });

  it("leads with HOW the number is derived — the point of the ticket", () => {
    expect(tideTitle(full(), "sprint-1", "Sprint 1").split("\n")[0]).toBe(
      "Points committed to the sprint, minus what's already done.",
    );
    expect(tideTitle(full(), null).split("\n")[0]).toBe(
      "Open work, plus anything finished inside the board's Done window.",
    );
  });

  it("shows every number the ticket asks for: remaining, committed, done, adds, drops", () => {
    const text = tideTitle(full(), "sprint-1", "Sprint 1");
    expect(text).toContain("12 remaining in Sprint 1");
    expect(text).toContain("20 committed");
    expect(text).toContain("8 done");
    expect(text).toContain("3 added");
    expect(text).toContain("1 dropped");
  });

  it("names the direction in words, never the bare arrow", () => {
    expect(tideTitle(full(), null)).toContain("going out — remaining is falling");
    expect(tideTitle(full({ direction: "in" }), null)).toContain("coming in — scope is rising");
    expect(tideTitle(full({ direction: "flat" }), null)).toContain("holding steady");
  });

  it("falls back to 'this sprint' when the sprint has no name", () => {
    expect(tideTitle(full(), "sprint-1")).toContain("remaining in this sprint");
  });

  it("adds the short-window caveat only when the window is short", () => {
    const short = tideTitle(full({ days: [day(12, 0), day(12, 1)] }), null);
    expect(short).toContain(`Showing 2 of ${TIDE_WINDOW_DAYS} days`);
    expect(tideTitle(full(), null)).not.toContain("Showing");
  });

  it("degrades to zeros rather than NaN/undefined before the fetch lands", () => {
    const text = tideTitle(null, null);
    expect(text).toContain("0 remaining");
    expect(text).toContain("Today: 0 added, 0 dropped.");
    expect(text).not.toMatch(/NaN|undefined/);
  });
});
