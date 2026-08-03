// Client mirror of src/github/external-state.ts (phase 21).
//
// The server file is the source of truth — keep the two in lockstep, same
// discipline as lib/columns.ts. Only the presentation helpers live here;
// validation stays server-side where it is enforceable.

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

const LABELS: Record<string, string> = {
  pr_draft: "Draft PR",
  pr_review: "PR in review",
  pr_changes_requested: "Changes requested",
  pr_approved: "PR approved",
  pr_merged: "PR merged",
  pr_closed: "PR closed",
  ci_failed: "CI failed",
  ci_passing: "CI passing",
};

export type ExternalStateTone = "neutral" | "info" | "warn" | "good" | "bad";

const TONES: Record<string, ExternalStateTone> = {
  pr_draft: "neutral",
  pr_review: "info",
  pr_changes_requested: "warn",
  pr_approved: "good",
  pr_merged: "good",
  pr_closed: "neutral",
  ci_failed: "bad",
  ci_passing: "good",
};

/** Custom (per-board) values have no label; render the raw value. */
export const externalStateLabel = (value: string): string => LABELS[value] ?? value;

export const externalStateTone = (value: string): ExternalStateTone => TONES[value] ?? "neutral";

/**
 * The PR link a pill should point at: the most recently recorded link,
 * preferring one whose state still reads open/draft over a closed one.
 * Returns null when the ticket carries no links.
 */
export const primaryPrLink = (
  links: ReadonlyArray<{ repo: string; pr: number; state: string }>,
): { repo: string; pr: number; state: string } | null => {
  if (links.length === 0) return null;
  const live = links.filter((l) => l.state === "open" || l.state === "draft");
  return (live.at(-1) ?? links.at(-1)) ?? null;
};

export const prUrl = (link: { repo: string; pr: number }): string =>
  `https://github.com/${link.repo}/pull/${link.pr}`;

/**
 * EFB-93 — the OTHER vocabulary, and the reason it needs its own map.
 *
 * `github_links[].state` is the PR's own lifecycle — open / draft / merged /
 * closed, written by `prLinkState()` in src/github/engine.ts, which says so
 * outright: "the PR's own lifecycle, not the pill". `external_state` above is
 * a different alphabet (pr_review, ci_failed, …) describing the TICKET.
 *
 * The two share a look and nothing else. Routing a link state through
 * `externalStateTone` would not fail — `TONES` falls back to "neutral" and
 * `LABELS` falls back to the raw value — it would quietly render every PR as
 * an identical grey pill reading "open" / "merged", and still satisfy any test
 * that merely asserts a pill exists. A silent wrong answer, so: separate map,
 * same `external-state-pill tone-*` classes, no new component.
 *
 * Tones follow GitHub's own convention, which is what a reader already expects.
 */
const PR_LINK_STATE_LABELS: Record<string, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

const PR_LINK_STATE_TONES: Record<string, ExternalStateTone> = {
  open: "info",
  draft: "neutral",
  merged: "good",
  closed: "neutral",
};

/** A state the engine has not taught us yet renders as-is rather than blank. */
export const prLinkStateLabel = (state: string): string => PR_LINK_STATE_LABELS[state] ?? state;

export const prLinkStateTone = (state: string): ExternalStateTone =>
  PR_LINK_STATE_TONES[state] ?? "neutral";
