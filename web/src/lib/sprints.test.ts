import { describe, expect, it } from "vitest";
import {
  FALLBACK_SPRINT_DAYS,
  activeSprintFilterId,
  currentSprint,
  effectiveSprintDays,
  sprintCountdown,
  sprintOptions,
} from "./sprints";
import type { SprintStatus } from "./types";

const DAY = 86_400_000;

const sprint = (
  id: string,
  status: SprintStatus,
  created_at_ms: number,
  started_at_ms: number | null = null,
) => ({ id, name: `Sprint ${id}`, status, created_at_ms, started_at_ms });

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

describe("currentSprint", () => {
  it("is null when nothing is active", () => {
    expect(currentSprint([])).toBeNull();
    expect(currentSprint([sprint("a", "planning", 1), sprint("b", "completed", 2)])).toBeNull();
  });

  it("picks the most recently started active sprint", () => {
    const chosen = currentSprint([
      sprint("old", "active", 1, 100),
      sprint("new", "active", 2, 500),
      sprint("planning", "planning", 3),
    ]);
    expect(chosen?.id).toBe("new");
  });

  it("does not mutate the caller's array", () => {
    const list = [sprint("a", "active", 1, 100), sprint("b", "active", 2, 500)];
    currentSprint(list);
    expect(list.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("sprintOptions", () => {
  it("lists every sprint newest-created first", () => {
    const opts = sprintOptions([
      sprint("oldest", "completed", 1),
      sprint("newest", "planning", 3),
      sprint("middle", "planning", 2),
    ]);
    expect(opts.map((o) => o.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("labels each sprint with its status, and the current one as current", () => {
    const opts = sprintOptions([
      sprint("running", "active", 2, 500),
      sprint("next", "planning", 1),
      sprint("done", "completed", 0),
    ]);
    expect(opts.map((o) => o.label)).toEqual([
      "Sprint running · current",
      "Sprint next · planning",
      "Sprint done · completed",
    ]);
  });

  // Only one sprint can be "the current one"; a second active sprint is
  // still active, and saying so is what makes the distinction useful.
  it("marks only the current sprint when several are active", () => {
    const opts = sprintOptions([sprint("a", "active", 2, 100), sprint("b", "active", 1, 500)]);
    expect(opts.map((o) => o.label)).toEqual(["Sprint a · active", "Sprint b · current"]);
  });

  it("has no None entry — that option is static in the markup", () => {
    expect(sprintOptions([sprint("a", "planning", 1)]).map((o) => o.id)).toEqual(["a"]);
    expect(sprintOptions([])).toEqual([]);
  });
});

describe("activeSprintFilterId", () => {
  const SPRINT = { id: "s1" };

  it("narrows to the active sprint when the chip is on", () => {
    expect(activeSprintFilterId(SPRINT, false)).toBe("s1");
  });

  it("shows everything when the chip is toggled off", () => {
    expect(activeSprintFilterId(SPRINT, true)).toBeNull();
  });

  // The regression this helper exists for. The inline form it replaced tested
  // `activeSprint() !== undefined`, but the sprint accessors return NULL for a
  // board with no active sprint — so the guard passed and `.id` was read off
  // null. Kanban-mode boards are precisely the no-sprint ones, so this is the
  // path EFB-31's Done window runs on.
  it("returns null for a board with no active sprint instead of throwing", () => {
    expect(activeSprintFilterId(null, false)).toBeNull();
    expect(activeSprintFilterId(null, true)).toBeNull();
  });

  it("tolerates undefined as well as null", () => {
    expect(activeSprintFilterId(undefined, false)).toBeNull();
  });
});
