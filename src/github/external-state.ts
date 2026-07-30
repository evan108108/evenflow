// external_state — the pill vocabulary (phase 21, GitHub integration).
//
// Mirrored at web/src/lib/externalState.ts; the parsers here are the source
// of truth, keep the two in lockstep (same discipline as columns.ts).
//
// external_state is deliberately INDEPENDENT of column position. A ticket
// can read "PR in review" while sitting in Todo — that separation is the
// whole point of the feature. Automation that also moves the card is a
// RULE the board opts into, never a side effect of the pill.
//
// Per-PR truth vs the rolled-up pill:
//   issueCache.github_links[] holds {repo, pr, state} — one entry per PR,
//   the full picture. issueCache.external_state is the single pill, and it
//   is LAST-EVENT-WINS (Evan-approved for v1): the most recent delivery to
//   touch this ticket decides. The deciding delivery_id lands in the audit
//   row so a surprising pill is always traceable to the event that set it.

export const DEFAULT_EXTERNAL_STATES = [
  "pr_draft",
  "pr_review",
  "pr_changes_requested",
  "pr_approved",
  "pr_merged",
  "pr_closed",
  "ci_failed",
  "ci_passing",
] as const;

export type DefaultExternalState = (typeof DEFAULT_EXTERNAL_STATES)[number];

/** Display labels for the default vocabulary; custom values render as-is. */
export const EXTERNAL_STATE_LABELS: Record<string, string> = {
  pr_draft: "Draft PR",
  pr_review: "PR in review",
  pr_changes_requested: "Changes requested",
  pr_approved: "PR approved",
  pr_merged: "PR merged",
  pr_closed: "PR closed",
  ci_failed: "CI failed",
  ci_passing: "CI passing",
};

/**
 * Tone buckets drive pill colour without hardcoding the value list in CSS.
 * Unknown (custom) values fall back to "neutral".
 */
export const EXTERNAL_STATE_TONES: Record<string, "neutral" | "info" | "warn" | "good" | "bad"> = {
  pr_draft: "neutral",
  pr_review: "info",
  pr_changes_requested: "warn",
  pr_approved: "good",
  pr_merged: "good",
  pr_closed: "neutral",
  ci_failed: "bad",
  ci_passing: "good",
};

export const externalStateLabel = (value: string): string =>
  EXTERNAL_STATE_LABELS[value] ?? value;

export const externalStateTone = (value: string): "neutral" | "info" | "warn" | "good" | "bad" =>
  EXTERNAL_STATE_TONES[value] ?? "neutral";

export const EXTERNAL_STATE_MAX_LENGTH = 40;
export const MAX_EXTERNAL_STATE_VALUES = 32;
/** Same shape as a column category slug: lowercase, digits, underscore. */
export const EXTERNAL_STATE_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The vocabulary a board accepts. NULL config (the common case) = defaults.
 * Stored as a JSON string[] in boardCache.external_state_config.
 */
export const allowedExternalStates = (configJson: string | null): ReadonlyArray<string> => {
  if (configJson === null || configJson === "") return DEFAULT_EXTERNAL_STATES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return DEFAULT_EXTERNAL_STATES;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_EXTERNAL_STATES;
  const values = parsed.filter((v): v is string => typeof v === "string" && EXTERNAL_STATE_RE.test(v));
  return values.length === 0 ? DEFAULT_EXTERNAL_STATES : values;
};

/**
 * Validate a client-supplied external_state_config. Returns a rejection
 * reason (surfaced as `external_state_config-<reason>`) or null when valid.
 */
export const externalStateConfigProblem = (v: unknown): string | null => {
  if (!Array.isArray(v) || v.length === 0) return "shape";
  if (v.length > MAX_EXTERNAL_STATE_VALUES) return "too-many";
  for (const s of v) {
    if (typeof s !== "string") return "shape";
    if (!EXTERNAL_STATE_RE.test(s)) return "value";
  }
  if (new Set(v as string[]).size !== v.length) return "duplicate";
  return null;
};
