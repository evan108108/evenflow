// The rules engine vocabulary: predicates, actions, presets, validation.
//
// Mirrored at web/src/lib/githubRules.ts for the editor; the parsers here
// are the source of truth (same discipline as columns.ts).
//
// A rule is {when: <predicate>, do: <action>}. Evaluation is
// FIRST-MATCH-PER-EVENT within a bucket: rules sort by priority ascending
// and the first ENABLED rule whose predicate matches is the only one that
// fires. That is a deliberate constraint — an event that fans out into
// several actions is much harder to reason about from an audit row, and
// "why did my ticket move twice" is the support question this design is
// built to never generate.
//
// Two buckets: 'match' rules fire against every ticket a delivery matched;
// 'no_match' rules fire once when a verified delivery matched zero tickets
// (the "PR with no ticket ref" bucket in the editor).

import { COLUMN_CATEGORIES, type ColumnCategory } from "../columns";
import { CONTAINERS, type Container } from "../shapes";
import { EXTERNAL_STATE_RE } from "./external-state";
import { TEMPLATE_MAX_LENGTH } from "./template";

// ── event vocabulary ──────────────────────────────────────────────────────

/** GitHub event types we understand. Anything else audits as unhandled. */
export const GITHUB_EVENTS = ["pull_request", "pull_request_review", "check_run"] as const;
export type GithubEvent = (typeof GITHUB_EVENTS)[number];

/** payload.action values that carry meaning for us, per event. */
export const PULL_REQUEST_ACTIONS = [
  "opened",
  "reopened",
  "synchronize",
  "converted_to_draft",
  "ready_for_review",
  "closed",
] as const;
export const REVIEW_ACTIONS = ["submitted", "dismissed"] as const;
export const CHECK_RUN_ACTIONS = ["completed", "created", "rerequested"] as const;

/** Review states we filter on (pull_request_review.review.state, lowercased). */
export const REVIEW_STATES = ["approved", "changes_requested", "commented"] as const;
/** check_run conclusions we filter on. */
export const CHECK_CONCLUSIONS = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "skipped",
] as const;

// ── predicate ─────────────────────────────────────────────────────────────

/**
 * All fields beyond `event` are OPTIONAL SUB-FILTERS, ANDed together. An
 * absent field means "don't care" — `{event: "pull_request"}` matches every
 * pull_request delivery.
 *
 * `merged` disambiguates the one GitHub action that means two different
 * things: `closed` with merged=true is a merge, merged=false is an abandon,
 * and the default preset must treat them differently.
 */
export interface RulePredicate {
  readonly event: GithubEvent;
  readonly action?: string;
  readonly merged?: boolean;
  readonly draft?: boolean;
  readonly review_state?: string;
  readonly conclusion?: string;
  /** Substring match on the check name, case-insensitive (e.g. "e2e"). */
  readonly check_name_contains?: string;
}

// ── actions ───────────────────────────────────────────────────────────────

export const ACTION_TYPES = [
  "transition_to_column",
  "set_external_state",
  "set_container",
  "add_comment",
  "assign",
  "add_label",
  "no_op",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type RuleAction =
  | { readonly type: "transition_to_column"; readonly column_id?: string; readonly category?: ColumnCategory }
  | { readonly type: "set_external_state"; readonly value: string }
  | { readonly type: "set_container"; readonly container: Container }
  | { readonly type: "add_comment"; readonly template: string }
  | { readonly type: "assign"; readonly who: "pr_author" | "fixed"; readonly pubkey?: string }
  | { readonly type: "add_label"; readonly label: string }
  | { readonly type: "no_op"; readonly note?: string };

export const RULE_BUCKETS = ["match", "no_match"] as const;
export type RuleBucket = (typeof RULE_BUCKETS)[number];

export interface Rule {
  readonly id: string;
  readonly board_id: string;
  readonly bucket: RuleBucket;
  readonly priority: number;
  readonly when: RulePredicate;
  /** One action or a list — a single matched rule runs every action in
   *  order, so "PR merged" can both set the pr_merged pill AND transition
   *  to Done in one atomic rule fire (first-match-per-event is preserved
   *  at the RULE level, not the action level). */
  readonly do: RuleAction | ReadonlyArray<RuleAction>;
  readonly enabled: boolean;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

// ── matching ──────────────────────────────────────────────────────────────

/**
 * The normalized facts a predicate is tested against. Extracted from the
 * raw GitHub payload ONCE (see engine.ts), so predicate logic never has to
 * know GitHub's field layout and stays trivially testable.
 */
export interface EventFacts {
  readonly event: string;
  readonly action: string | null;
  readonly merged: boolean | null;
  readonly draft: boolean | null;
  readonly review_state: string | null;
  readonly conclusion: string | null;
  readonly check_name: string | null;
}

export const predicateMatches = (p: RulePredicate, f: EventFacts): boolean => {
  if (p.event !== f.event) return false;
  if (p.action !== undefined && p.action !== f.action) return false;
  if (p.merged !== undefined && p.merged !== f.merged) return false;
  if (p.draft !== undefined && p.draft !== f.draft) return false;
  if (p.review_state !== undefined && p.review_state !== f.review_state) return false;
  if (p.conclusion !== undefined && p.conclusion !== f.conclusion) return false;
  if (p.check_name_contains !== undefined) {
    const name = f.check_name;
    if (name === null) return false;
    if (!name.toLowerCase().includes(p.check_name_contains.toLowerCase())) return false;
  }
  return true;
};

/**
 * First enabled rule in the bucket whose predicate matches, by ascending
 * priority. Null when nothing matches — the caller still writes an audit
 * row, because "nothing matched" is the answer users most need to see.
 */
export const firstMatchingRule = (
  rules: ReadonlyArray<Rule>,
  bucket: RuleBucket,
  facts: EventFacts,
): Rule | null => {
  const candidates = rules
    .filter((r) => r.enabled && r.bucket === bucket)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const rule of candidates) {
    if (predicateMatches(rule.when, facts)) return rule;
  }
  return null;
};

// ── validation ────────────────────────────────────────────────────────────

export const MAX_RULES_PER_BOARD = 50;
export const LABEL_MAX_LENGTH = 40;

/** Rejection reason (surfaced as `rule-<reason>`) or null when well-formed. */
export const predicateProblem = (v: unknown): string | null => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "when-shape";
  const p = v as Record<string, unknown>;
  if (!(GITHUB_EVENTS as ReadonlyArray<string>).includes(p["event"] as string)) return "when-event";
  for (const [key, val] of Object.entries(p)) {
    if (key === "event") continue;
    if (val === undefined) continue;
    switch (key) {
      case "action":
      case "review_state":
      case "conclusion":
      case "check_name_contains":
        if (typeof val !== "string" || val === "" || val.length > 80) return `when-${key}`;
        break;
      case "merged":
      case "draft":
        if (typeof val !== "boolean") return `when-${key}`;
        break;
      default:
        return "when-unknown-field";
    }
  }
  return null;
};

export const actionProblem = (v: unknown, allowedStates: ReadonlyArray<string>): string | null => {
  // A `do` may be a single action object or an ordered list of them; check
  // each item in the list, first bad one wins.
  if (Array.isArray(v)) {
    if (v.length === 0) return "do-empty-list";
    for (const item of v) {
      const problem = actionProblem(item, allowedStates);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (typeof v !== "object" || v === null) return "do-shape";
  const a = v as Record<string, unknown>;
  const type = a["type"];
  if (!(ACTION_TYPES as ReadonlyArray<string>).includes(type as string)) return "do-type";
  switch (type as ActionType) {
    case "transition_to_column": {
      const hasId = typeof a["column_id"] === "string" && a["column_id"] !== "";
      const hasCategory = (COLUMN_CATEGORIES as ReadonlyArray<string>).includes(
        a["category"] as string,
      );
      // Exactly one — both set is ambiguous, neither is a no-op wearing a
      // transition's clothes.
      if (hasId === hasCategory) return "do-transition-target";
      return null;
    }
    case "set_external_state": {
      const value = a["value"];
      if (typeof value !== "string" || !EXTERNAL_STATE_RE.test(value)) return "do-external-state";
      if (!allowedStates.includes(value)) return "do-external-state-not-allowed";
      return null;
    }
    case "set_container":
      if (!(CONTAINERS as ReadonlyArray<string>).includes(a["container"] as string)) {
        return "do-container";
      }
      return null;
    case "add_comment": {
      const t = a["template"];
      if (typeof t !== "string" || t.trim() === "") return "do-template";
      if (t.length > TEMPLATE_MAX_LENGTH) return "do-template-too-long";
      return null;
    }
    case "assign": {
      const who = a["who"];
      if (who === "pr_author") return null;
      if (who === "fixed") {
        const pk = a["pubkey"];
        return typeof pk === "string" && pk !== "" ? null : "do-assign-pubkey";
      }
      return "do-assign-who";
    }
    case "add_label": {
      const label = a["label"];
      if (typeof label !== "string" || label.trim() === "" || label.length > LABEL_MAX_LENGTH) {
        return "do-label";
      }
      return null;
    }
    case "no_op": {
      const note = a["note"];
      if (note !== undefined && (typeof note !== "string" || note.length > 200)) return "do-note";
      return null;
    }
  }
};

// ── presets ───────────────────────────────────────────────────────────────

export const RULE_PRESETS = ["defaults", "status_only", "custom", "off"] as const;
export type RulePreset = (typeof RULE_PRESETS)[number];

export interface PresetRuleV0 {
  readonly bucket: RuleBucket;
  readonly when: RulePredicate;
  readonly do: RuleAction;
}
export interface PresetRule {
  readonly bucket: RuleBucket;
  readonly when: RulePredicate;
  readonly do: RuleAction | ReadonlyArray<RuleAction>;
}

/**
 * The Evan-approved default preset, verbatim from the design.
 *
 * Ordering is load-bearing because matching is first-match-per-event: the
 * `closed`+merged and `closed`+unmerged rules must both sit ABOVE any
 * broader pull_request rule, and `converted_to_draft` must precede the
 * opened/reopened/synchronize group so a draft never reads "in review".
 *
 * Rule 1 of the design ("opened / synchronize / reopened") is three rules
 * here, not one: the predicate language has no OR, on purpose. Three
 * explicit rows are greppable in the editor and each audits independently.
 */
export const DEFAULT_PRESET_RULES: ReadonlyArray<PresetRule> = [
  // Draft handling first — a draft PR must never read "in review".
  {
    bucket: "match",
    when: { event: "pull_request", action: "converted_to_draft" },
    do: { type: "set_external_state", value: "pr_draft" },
  },
  {
    bucket: "match",
    when: { event: "pull_request", action: "opened", draft: true },
    do: { type: "set_external_state", value: "pr_draft" },
  },
  // Merged vs abandoned — both are action "closed"; `merged` splits them.
  {
    bucket: "match",
    when: { event: "pull_request", action: "closed", merged: true },
    do: [
      { type: "set_external_state", value: "pr_merged" },
      { type: "transition_to_column", category: "done" },
    ],
  },
  {
    bucket: "match",
    when: { event: "pull_request", action: "closed", merged: false },
    do: { type: "set_external_state", value: "pr_closed" },
  },
  // Opened / reopened / synchronize / ready_for_review → in review.
  //
  // EFB-72: opened / reopened / ready_for_review also MOVE the card, mirroring
  // what the merged rule above does on the closing edge. The pill alone was
  // most of the mechanism and none of the payoff — every PR still needed a
  // manual drag to In Review.
  //
  // `synchronize` is deliberately excluded: it fires on every push to the
  // branch, so transitioning there would drag the card back to In Review each
  // time someone pushed — overriding any manual move for the life of the PR.
  // The three rules that DO transition each fire once per state change.
  {
    bucket: "match",
    when: { event: "pull_request", action: "opened" },
    do: [
      { type: "set_external_state", value: "pr_review" },
      { type: "transition_to_column", category: "in_review" },
    ],
  },
  {
    bucket: "match",
    when: { event: "pull_request", action: "reopened" },
    do: [
      { type: "set_external_state", value: "pr_review" },
      { type: "transition_to_column", category: "in_review" },
    ],
  },
  {
    bucket: "match",
    when: { event: "pull_request", action: "synchronize" },
    do: { type: "set_external_state", value: "pr_review" },
  },
  {
    bucket: "match",
    when: { event: "pull_request", action: "ready_for_review" },
    do: [
      { type: "set_external_state", value: "pr_review" },
      { type: "transition_to_column", category: "in_review" },
    ],
  },
  // Reviews.
  {
    bucket: "match",
    when: { event: "pull_request_review", action: "submitted", review_state: "approved" },
    do: { type: "set_external_state", value: "pr_approved" },
  },
  {
    bucket: "match",
    when: { event: "pull_request_review", action: "submitted", review_state: "changes_requested" },
    do: { type: "set_external_state", value: "pr_changes_requested" },
  },
  // CI.
  {
    bucket: "match",
    when: { event: "check_run", action: "completed", conclusion: "failure" },
    do: {
      type: "add_comment",
      template:
        "Check '{{ check_run.name }}' failed on PR #{{ pull_request.number }}. See {{ check_run.html_url }}.",
    },
  },
  {
    bucket: "match",
    when: { event: "check_run", action: "completed", conclusion: "success" },
    do: { type: "set_external_state", value: "ci_passing" },
  },
];

/**
 * Status-only: identical vocabulary, every transition stripped. This is the
 * preset for a team that wants the pill but keeps column position strictly
 * hand-driven.
 */
export const STATUS_ONLY_PRESET_RULES: ReadonlyArray<PresetRule> = DEFAULT_PRESET_RULES.map(
  (r): PresetRule => {
    const actions = Array.isArray(r.do) ? r.do : [r.do];
    const withoutTransitions = actions.filter((a) => a.type !== "transition_to_column");
    // A rule that was JUST a transition needs a replacement action so the
    // preset still surfaces the state visibly — collapse to the set-pill
    // equivalent (pr_merged for the merged rule) rather than dropping the
    // rule entirely.
    if (withoutTransitions.length === 0) {
      return { ...r, do: { type: "set_external_state", value: "pr_merged" } };
    }
    return { ...r, do: withoutTransitions.length === 1 ? withoutTransitions[0]! : withoutTransitions };
  },
);

export const presetRules = (preset: RulePreset): ReadonlyArray<PresetRule> => {
  switch (preset) {
    case "defaults":
      return DEFAULT_PRESET_RULES;
    case "status_only":
      return STATUS_ONLY_PRESET_RULES;
    case "custom":
    case "off":
      return [];
  }
};
