// EFB-22 TideBadge — the pure bits of the badge.
//
// The fetch path needs the app runtime and an ApiClient layer, which the other
// component tests deliberately avoid standing up. What's worth pinning down
// here is the geometry and the direction vocabulary: the sparkline plots
// REMAINING (not throughput), and ↘ has to mean "going out", which reads
// backwards often enough to be worth a test.

import { describe, expect, it } from "vitest";
import { DIRECTION_GLYPH, sparklinePoints, type TideDay } from "./TideBadge";

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
