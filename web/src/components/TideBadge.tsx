// TideBadge (EFB-22) — replaces "The Current" on the board header.
//
// The Current counted points that crossed into a done column over a trailing
// 7 days: a throughput number that only ever went up. The tide is the sprint's
// actual position — points remaining, committed minus done. Shipping drops it,
// mid-sprint scope raises it, zero means the shore.
//
// Two modes, one component. With an active sprint (and the sprint filter on)
// it reads that sprint's tide; otherwise it reads the board's kanban-only
// tide, where `done_window_days` stands in as the virtual sprint. The server
// endpoints differ, everything downstream of the fetch does not.
//
// The first week after migration 0021 shows fewer than seven bars. That is
// expected — days that predate the migration have no reading and are simply
// absent — so the empty state says so rather than rendering a flat line that
// looks like a stalled sprint.

import { Show, createMemo, createResource } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";

/** Sparkline geometry, in the SVG's own viewBox units. */
const CHART_WIDTH = 90;
const CHART_HEIGHT = 24;
const CHART_PAD = 3;
const CHART_TOP = 21;
const CHART_SPAN = 16;

export const TIDE_WINDOW_DAYS = 7;

export interface TideDay {
  readonly day: string;
  readonly day_start_ms: number;
  readonly committed_pts: number;
  readonly done_pts: number;
  readonly remaining_pts: number;
  readonly adds_today: number;
  readonly drops_today: number;
}

export type TideDirection = "in" | "out" | "flat";

export interface TideReading {
  readonly days: ReadonlyArray<TideDay>;
  readonly today: TideDay | null;
  readonly direction: TideDirection;
}

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

/**
 * ↘ means the tide is going OUT — remaining is falling, the sprint is
 * burning down. That reads backwards for half a second, so the arrow never
 * ships without its word next to it in the tooltip.
 */
export const DIRECTION_GLYPH: Record<TideDirection, string> = {
  out: "↘",
  in: "↗",
  flat: "—",
};

const DIRECTION_WORD: Record<TideDirection, string> = {
  out: "going out — remaining is falling",
  in: "coming in — scope is rising",
  flat: "slack — remaining is holding steady",
};

/** How the number is derived, per mode. The badge shows a figure and an
 *  arrow; without this line you have to read the source to learn what it
 *  counts, which is the whole of EFB-25. */
const SPRINT_DERIVATION = "Points committed to the sprint, minus what's already done.";
const KANBAN_DERIVATION = "Open work, plus anything finished inside the board's Done window.";

/**
 * The hover explainer, as a pure function so it can be tested without
 * standing up the app runtime the badge's fetch needs.
 *
 * Stays inside the native `title=` attribute deliberately: Evenflow has no
 * Tooltip component, and a hover explainer is not worth inventing one for.
 * Newlines render as line breaks in the native tooltip, so the derivation,
 * the numbers, and the direction each get a line instead of one run-on
 * sentence.
 */
export const tideTitle = (
  reading: TideReading | null,
  sprintId: string | null,
  sprintName?: string | null,
): string => {
  const today = reading?.today ?? null;
  const windowDays = reading?.days ?? [];
  const scope = sprintId === null ? "the board's Done window" : (sprintName ?? "this sprint");
  const lines = [
    sprintId === null ? KANBAN_DERIVATION : SPRINT_DERIVATION,
    `${today?.remaining_pts ?? 0} remaining in ${scope} · ${today?.committed_pts ?? 0} committed · ${today?.done_pts ?? 0} done.`,
    `Today: ${today?.adds_today ?? 0} added, ${today?.drops_today ?? 0} dropped.`,
    `Tide is ${DIRECTION_WORD[reading?.direction ?? "flat"]}.`,
  ];
  // Same caveat the empty state carries — a short window is missing history,
  // not a stalled sprint.
  if (windowDays.length < TIDE_WINDOW_DAYS) {
    lines.push(
      `Showing ${windowDays.length} of ${TIDE_WINDOW_DAYS} days — earlier days have no reading yet.`,
    );
  }
  return lines.join("\n");
};

/**
 * Remaining points over the window. Scaled to the window's own max so a
 * 3-point sprint reads as legibly as a 300-point one; a window that never
 * leaves zero draws flat along the baseline instead of dividing by zero.
 */
export const sparklinePoints = (days: ReadonlyArray<TideDay>): string => {
  if (days.length === 0) return "";
  const max = Math.max(1, ...days.map((d) => d.remaining_pts));
  const step = days.length === 1 ? 0 : (CHART_WIDTH - CHART_PAD * 2) / (days.length - 1);
  return days
    .map((d, i) => {
      const x = CHART_PAD + i * step;
      const y = CHART_TOP - (d.remaining_pts / max) * CHART_SPAN;
      return `${x},${y}`;
    })
    .join(" ");
};

const TideSparkline = (props: { days: ReadonlyArray<TideDay> }) => (
  <svg
    width={CHART_WIDTH}
    height={CHART_HEIGHT}
    viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
    aria-label={`points remaining, last ${props.days.length} day${props.days.length === 1 ? "" : "s"}`}
  >
    <polyline
      points={sparklinePoints(props.days)}
      fill="none"
      stroke="var(--color-ink)"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      opacity="0.75"
    />
  </svg>
);

export interface TideBadgeProps {
  /** Board-scoped API prefix, e.g. `/api/v0/orgs/acme/boards/flow`. */
  readonly apiBase: string;
  /** Sprint to read, or null for the board's kanban-only tide. */
  readonly sprintId: string | null;
  /** Shown beside the label when scoped to a sprint. */
  readonly sprintName?: string | null;
  /** Bump to refetch — BoardPage raises it on any tide-relevant SSE event. */
  readonly refreshKey?: number;
}

export const TideBadge = (props: TideBadgeProps) => {
  const [reading] = createResource(
    () => ({
      apiBase: props.apiBase,
      sprintId: props.sprintId,
      key: props.refreshKey ?? 0,
    }),
    async (source) => {
      const path =
        source.sprintId === null
          ? `${source.apiBase}/tide?days=${TIDE_WINDOW_DAYS}`
          : `${source.apiBase}/sprints/${encodeURIComponent(source.sprintId)}/tide?days=${TIDE_WINDOW_DAYS}`;
      return api<TideReading>((c) => c.get<TideReading>(path));
    },
  );

  const days = createMemo(() => reading()?.days ?? []);
  const remaining = () => reading()?.today?.remaining_pts ?? 0;
  const direction = (): TideDirection => reading()?.direction ?? "flat";
  const committed = () => reading()?.today?.committed_pts ?? 0;

  const title = () => tideTitle(reading() ?? null, props.sprintId, props.sprintName);

  return (
    <div class="current tide" title={title()}>
      <span class="label">
        Sprint tide
        <Show when={props.sprintId !== null && (props.sprintName ?? null) !== null}>
          <span class="muted" style={{ "margin-left": "0.35rem", "font-size": "0.72rem" }}>
            · {props.sprintName}
          </span>
        </Show>
      </span>
      <Show
        when={!reading.loading && reading.error === undefined}
        fallback={<span class="muted tide-placeholder">…</span>}
      >
        <TideSparkline days={days()} />
        <span class="figure">{remaining()}</span>
        <span class="tide-direction" aria-label={`tide ${DIRECTION_WORD[direction()]}`}>
          {DIRECTION_GLYPH[direction()]}
        </span>
      </Show>
    </div>
  );
};
