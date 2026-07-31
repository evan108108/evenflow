// Sprint-length arithmetic (migration 0011): a sprint runs for its own
// planned_days when set, else the board's default_sprint_days. Boards
// cached from before the migration fall back to the historical two weeks.
//
// Also the sprint picker's option list — see sprintOptions below.

import type { SprintStatus } from "./types";

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

/** The minimum a sprint needs to be pickable. */
interface PickableSprint {
  readonly id: string;
  readonly name: string;
  readonly status: SprintStatus;
  readonly started_at_ms: number | null;
  readonly created_at_ms: number;
}

/**
 * The board's current sprint — the most recently started active one.
 * Mirrors BoardPage's activeSprint: null (never undefined) when there
 * isn't one, so callers can compare against null.
 */
/**
 * Which sprint the board views should narrow to, or null for "show everything".
 *
 * A named helper rather than an inline ternary because the inline form it
 * replaces tested the active sprint against `undefined` — but the sprint
 * accessors return `null` when a board has no active sprint, so that guard was
 * always true and the no-sprint case fell through to dereferencing `null.id`.
 * Boards without an active sprint are exactly the kanban-mode boards whose Done
 * column EFB-31 windows, so this path has to stay correct and covered.
 */
export const activeSprintFilterId = (
  activeSprint: { id: string } | null | undefined,
  sprintFilterOff: boolean,
): string | null =>
  activeSprint !== null && activeSprint !== undefined && !sprintFilterOff ? activeSprint.id : null;

export const currentSprint = <S extends PickableSprint>(sprints: readonly S[]): S | null =>
  [...sprints]
    .filter((s) => s.status === "active")
    .sort((a, b) => (b.started_at_ms ?? 0) - (a.started_at_ms ?? 0))[0] ?? null;

/**
 * Options for the sheet's sprint picker: every sprint on the board,
 * newest-created first, each labelled with the state you'd need to know
 * before moving a ticket into it. The current sprint reads "· current"
 * rather than "· active" — with several active sprints, which one the
 * board is actually running is the thing worth disambiguating.
 *
 * The "— None —" entry isn't here; it's a static option in the markup so
 * that unassigning doesn't depend on the list having loaded.
 */
export const sprintOptions = (
  sprints: readonly PickableSprint[],
): ReadonlyArray<{ id: string; label: string }> => {
  const current = currentSprint(sprints);
  return [...sprints]
    .sort((a, b) => b.created_at_ms - a.created_at_ms)
    .map((s) => ({
      id: s.id,
      label: `${s.name} · ${s.id === current?.id ? "current" : s.status}`,
    }));
};
