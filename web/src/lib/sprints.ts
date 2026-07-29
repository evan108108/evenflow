// Sprint-length arithmetic (migration 0011): a sprint runs for its own
// planned_days when set, else the board's default_sprint_days. Boards
// cached from before the migration fall back to the historical two weeks.

const DAY_MS = 86_400_000;

export const FALLBACK_SPRINT_DAYS = 14;

export const effectiveSprintDays = (
  sprint: { planned_days?: number | null },
  boardDefaultDays: number | undefined,
): number => sprint.planned_days ?? boardDefaultDays ?? FALLBACK_SPRINT_DAYS;

/**
 * Badge countdown for a started sprint. Overdue sprints just say so —
 * nothing auto-completes. Returns null until the sprint starts.
 */
export const sprintCountdown = (
  sprint: { planned_days?: number | null; started_at_ms: number | null },
  boardDefaultDays: number | undefined,
  now: number,
): { daysLeft: number; overdue: boolean } | null => {
  if (sprint.started_at_ms === null) return null;
  const remainingMs =
    sprint.started_at_ms + effectiveSprintDays(sprint, boardDefaultDays) * DAY_MS - now;
  if (remainingMs <= 0) return { daysLeft: 0, overdue: true };
  return { daysLeft: Math.ceil(remainingMs / DAY_MS), overdue: false };
};
