import { describe, expect, it } from "vitest";
import { FALLBACK_SPRINT_DAYS, effectiveSprintDays, sprintCountdown } from "./sprints";

const DAY = 86_400_000;

describe("effectiveSprintDays", () => {
  it("prefers the sprint override, then the board default, then the fallback", () => {
    expect(effectiveSprintDays({ planned_days: 7 }, 21)).toBe(7);
    expect(effectiveSprintDays({ planned_days: null }, 21)).toBe(21);
    expect(effectiveSprintDays({}, 21)).toBe(21);
    expect(effectiveSprintDays({ planned_days: null }, undefined)).toBe(FALLBACK_SPRINT_DAYS);
  });
});

describe("sprintCountdown", () => {
  it("is null before the sprint starts", () => {
    expect(sprintCountdown({ planned_days: 7, started_at_ms: null }, 14, 0)).toBeNull();
  });

  it("counts down against the effective length, ceiling partial days", () => {
    const start = 100 * DAY;
    // 7-day override, 2.5 days elapsed → 4.5 days left → shows 5.
    expect(sprintCountdown({ planned_days: 7, started_at_ms: start }, 14, start + 2.5 * DAY)).toEqual(
      { daysLeft: 5, overdue: false },
    );
    // No override: board default 21 governs.
    expect(
      sprintCountdown({ planned_days: null, started_at_ms: start }, 21, start + 20 * DAY),
    ).toEqual({ daysLeft: 1, overdue: false });
  });

  it("flags overdue at and past the boundary, never negative", () => {
    const start = 100 * DAY;
    expect(sprintCountdown({ planned_days: 7, started_at_ms: start }, 14, start + 7 * DAY)).toEqual({
      daysLeft: 0,
      overdue: true,
    });
    expect(
      sprintCountdown({ planned_days: 7, started_at_ms: start }, 14, start + 30 * DAY),
    ).toEqual({ daysLeft: 0, overdue: true });
  });
});
