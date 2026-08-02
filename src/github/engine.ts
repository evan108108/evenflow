// Delivery normalization + rule evaluation.
//
// The split here is the load-bearing design decision: `parseDelivery` and
// `evaluateDelivery` are PURE. They touch no database, perform no writes,
// and return a PLAN describing what would happen. The webhook route runs
// the plan; the test panel renders it. Both call the identical function, so
// "what the panel says would happen" and "what happens" cannot drift —
// a panel that simulated the rules separately would be a second
// implementation certifying the first, which certifies nothing.

import { columnById, enabledColumns, type Column } from "../columns";
import { extractTicketRefs, type RefMatch } from "./refs";
import { renderTemplate } from "./template";
import {
  firstMatchingRule,
  type EventFacts,
  type Rule,
  type RuleAction,
  type RuleBucket,
} from "./rules";

// ── normalization ─────────────────────────────────────────────────────────

export interface PullRequestInfo {
  readonly number: number;
  readonly html_url: string | null;
  readonly title: string | null;
  readonly author_login: string | null;
  readonly branch: string | null;
  readonly merged: boolean | null;
  readonly draft: boolean | null;
}

export interface Delivery {
  readonly event: string;
  readonly facts: EventFacts;
  readonly refs: RefMatch;
  readonly repo: string | null;
  readonly pr: PullRequestInfo | null;
  /** What `{{ … }}` templates may reach. */
  readonly templateContext: Record<string, unknown>;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Normalize a raw GitHub payload. Never throws — a malformed or partial
 * payload yields nulls and simply matches nothing, because a webhook body
 * is attacker-shaped input and an exception here would turn a bad delivery
 * into a 500 that GitHub then retries forever.
 */
export const parseDelivery = (eventType: string, payload: unknown): Delivery => {
  const root = obj(payload) ?? {};
  const action = str(root["action"]);
  const repository = obj(root["repository"]);
  const repo = str(repository?.["full_name"]) ?? null;

  const prNode = obj(root["pull_request"]);
  const checkRun = obj(root["check_run"]);
  const review = obj(root["review"]);

  // check_run carries its PRs in an array with only number + head.ref —
  // no title, no body. Branch-name matching is all we get there.
  const checkPrs = Array.isArray(checkRun?.["pull_requests"])
    ? (checkRun?.["pull_requests"] as unknown[])
    : [];
  const firstCheckPr = obj(checkPrs[0]);

  const prSource = prNode ?? firstCheckPr;
  const head = obj(prSource?.["head"]);
  const user = obj(prSource?.["user"]);

  const pr: PullRequestInfo | null =
    prSource === null
      ? null
      : {
          number: int(prSource["number"]) ?? 0,
          html_url: str(prSource["html_url"]),
          title: str(prSource["title"]),
          author_login: str(user?.["login"]),
          branch: str(head?.["ref"]),
          merged: bool(prSource["merged"]),
          draft: bool(prSource["draft"]),
        };

  const facts: EventFacts = {
    event: eventType,
    action,
    merged: bool(prSource?.["merged"]),
    draft: bool(prSource?.["draft"]),
    review_state: str(review?.["state"])?.toLowerCase() ?? null,
    conclusion: str(checkRun?.["conclusion"]),
    check_name: str(checkRun?.["name"]),
  };

  const refs = extractTicketRefs({
    title: str(prSource?.["title"]),
    body: str(prSource?.["body"]),
    branch: str(head?.["ref"]),
  });

  // Deliberately a WHITELIST, not the raw payload: a template that can
  // reach every field of an attacker-controlled body is an exfiltration
  // surface into a comment on someone's board.
  const templateContext: Record<string, unknown> = {
    event: eventType,
    action,
    repository: repo === null ? null : { full_name: repo },
    pull_request:
      pr === null
        ? null
        : {
            number: pr.number,
            title: pr.title,
            html_url: pr.html_url,
            branch: pr.branch,
            author: pr.author_login,
            merged: pr.merged,
            draft: pr.draft,
          },
    check_run:
      checkRun === null
        ? null
        : {
            name: str(checkRun["name"]),
            conclusion: str(checkRun["conclusion"]),
            html_url: str(checkRun["html_url"]),
          },
    review:
      review === null
        ? null
        : {
            state: str(review["state"]),
            html_url: str(review["html_url"]),
            author: str(obj(review["user"])?.["login"]),
          },
  };

  return { event: eventType, facts, refs, repo, pr, templateContext };
};

// ── evaluation ────────────────────────────────────────────────────────────

/** A ticket a delivery resolved to. */
export interface TargetIssue {
  readonly id: string;
  readonly short_id: string;
  readonly title: string;
  readonly column_id: string | null;
  readonly container: string;
  readonly labels: ReadonlyArray<string>;
  readonly external_state: string | null;
}

export type PlannedEffect =
  | { readonly kind: "set_external_state"; readonly value: string }
  | { readonly kind: "set_column"; readonly column_id: string; readonly column_name: string }
  | { readonly kind: "set_container"; readonly container: string }
  | { readonly kind: "add_comment"; readonly body: string; readonly unknown_paths: ReadonlyArray<string> }
  | { readonly kind: "assign"; readonly pubkey: string }
  | { readonly kind: "add_label"; readonly label: string }
  | { readonly kind: "record_pr_link"; readonly repo: string; readonly pr: number; readonly state: string }
  | { readonly kind: "no_op"; readonly note: string | null }
  | { readonly kind: "skipped"; readonly reason: string };

export interface PlannedIssueOutcome {
  readonly issue_id: string;
  readonly short_id: string;
  readonly rule_id: string | null;
  readonly effects: ReadonlyArray<PlannedEffect>;
}

export interface EvaluationPlan {
  readonly bucket: RuleBucket;
  readonly facts: EventFacts;
  readonly matched_short_ids: ReadonlyArray<string>;
  /** Refs found in the PR text that no ticket on this board resolves to. */
  readonly unresolved_short_ids: ReadonlyArray<string>;
  readonly outcomes: ReadonlyArray<PlannedIssueOutcome>;
  /** Set when no rule matched at all — the audit row's headline. */
  readonly no_rule_matched: boolean;
}

export interface EvaluateInput {
  readonly delivery: Delivery;
  readonly rules: ReadonlyArray<Rule>;
  readonly columns: ReadonlyArray<Column>;
  readonly targets: ReadonlyArray<TargetIssue>;
  readonly unresolvedShortIds: ReadonlyArray<string>;
  /** GitHub login → evenflow pubkey, for assign(pr_author). */
  readonly authorPubkey: string | null;
}

/** Resolve a transition action to a concrete column, or explain why not. */
const resolveColumn = (
  action: Extract<RuleAction, { type: "transition_to_column" }>,
  columns: ReadonlyArray<Column>,
): { column: Column } | { reason: string } => {
  if (action.column_id !== undefined) {
    const col = columnById(columns, action.column_id);
    if (col === undefined) return { reason: "column-not-found" };
    if (!col.enabled) return { reason: "column-disabled" };
    return { column: col };
  }
  const category = action.category;
  if (category === undefined) return { reason: "no-target" };
  // "first column of the category", in display order — matches the design's
  // category variant. A board with no such column keeps the pill and skips
  // the move (default preset rule 5's "IFF the board has a done column").
  const col = enabledColumns(columns).find((c) => c.category === category);
  return col === undefined ? { reason: `no-column-in-category-${category}` } : { column: col };
};

/** A rule's `do` may be a single action or an ordered list; every action
 *  fires in sequence for the one matched rule, so "PR merged" can flip the
 *  pill AND transition in a single fire. */
const planActions = (
  actionOrList: RuleAction | ReadonlyArray<RuleAction>,
  input: EvaluateInput,
  issue: TargetIssue,
): PlannedEffect[] => {
  const list = Array.isArray(actionOrList) ? actionOrList : [actionOrList];
  const out: PlannedEffect[] = [];
  for (const action of list) out.push(...planAction(action, input, issue));
  return out;
};

const planAction = (
  action: RuleAction,
  input: EvaluateInput,
  issue: TargetIssue,
): PlannedEffect[] => {
  switch (action.type) {
    case "set_external_state":
      return [{ kind: "set_external_state", value: action.value }];
    case "transition_to_column": {
      const resolved = resolveColumn(action, input.columns);
      if ("reason" in resolved) return [{ kind: "skipped", reason: resolved.reason }];
      if (resolved.column.id === issue.column_id) {
        return [{ kind: "skipped", reason: "already-in-column" }];
      }
      // EFB-73: a column move out of the backlog carries the card into active.
      //
      // One rule, one mental model. Container promotion follows the TRANSITION,
      // not the target category. Custom rules stay predictable — a user who adds
      // a `to: category=blocked` rule gets the same backlog→active promotion the
      // client gives them on a manual drag; no special-case surprise.
      //
      // This mirrors web/src/pages/board/store.ts, where a rail drop promotes to
      // active before transitioning because `/transition` only touches status.
      // The server had no equivalent, so github-driven moves left tickets at
      // `column=Done, container=backlog` — Done cards sitting in the Backlog view.
      //
      // Planned here rather than inside execute.ts's `set_column` because
      // "a move out of backlog implies activation" is a decision about WHAT
      // should happen. The executor already knows how to apply `set_container`,
      // and routes/github.ts already turns it into an issue.container_changed
      // (EFB-66) — so planning the pair reuses both instead of teaching the
      // executor to return two actions from one effect.
      //
      // Icebox is sticky under webhooks even though the client promotes it — a
      // PR event isn't the deliberate un-park signal a human drag is. Someone
      // may open a PR against an iceboxed ticket before the human has decided
      // to bring it back.
      const promotes = issue.container === "backlog";
      return [
        { kind: "set_column", column_id: resolved.column.id, column_name: resolved.column.name },
        ...(promotes ? [{ kind: "set_container" as const, container: "active" }] : []),
      ];
    }
    case "set_container":
      return issue.container === action.container
        ? [{ kind: "skipped", reason: "already-in-container" }]
        : [{ kind: "set_container", container: action.container }];
    case "add_comment": {
      const rendered = renderTemplate(action.template, input.delivery.templateContext);
      return [
        { kind: "add_comment", body: rendered.text, unknown_paths: rendered.unknownPaths },
      ];
    }
    case "assign": {
      const pubkey = action.who === "pr_author" ? input.authorPubkey : (action.pubkey ?? null);
      if (pubkey === null) {
        return [
          {
            kind: "skipped",
            reason: action.who === "pr_author" ? "pr-author-unmapped" : "no-pubkey",
          },
        ];
      }
      return [{ kind: "assign", pubkey }];
    }
    case "add_label":
      return issue.labels.includes(action.label)
        ? [{ kind: "skipped", reason: "label-already-present" }]
        : [{ kind: "add_label", label: action.label }];
    case "no_op":
      return [{ kind: "no_op", note: action.note ?? null }];
  }
};

/**
 * Evaluate a delivery into a plan. PURE — the test panel calls exactly this
 * and renders the result without touching the database.
 */
export const evaluateDelivery = (input: EvaluateInput): EvaluationPlan => {
  const { delivery, rules, targets } = input;
  const bucket: RuleBucket = targets.length === 0 ? "no_match" : "match";
  const rule = firstMatchingRule(rules, bucket, delivery.facts);

  if (bucket === "no_match") {
    return {
      bucket,
      facts: delivery.facts,
      matched_short_ids: [],
      unresolved_short_ids: input.unresolvedShortIds,
      outcomes:
        rule === null
          ? []
          : [{ issue_id: "", short_id: "", rule_id: rule.id, effects: planActions(rule.do, input, {
              id: "", short_id: "", title: "", column_id: null, container: "backlog",
              labels: [], external_state: null,
            }) }],
      no_rule_matched: rule === null,
    };
  }

  const outcomes = targets.map((issue): PlannedIssueOutcome => {
    const effects: PlannedEffect[] = [];
    // Recording the PR link is unconditional on a matched ticket, not a
    // rule action: it is the raw fact of the association, and it is what
    // makes the card's PR hover-link work regardless of automation.
    if (delivery.pr !== null && delivery.repo !== null && delivery.pr.number > 0) {
      effects.push({
        kind: "record_pr_link",
        repo: delivery.repo,
        pr: delivery.pr.number,
        state: prLinkState(delivery),
      });
    }
    if (rule !== null) effects.push(...planActions(rule.do, input, issue));
    return {
      issue_id: issue.id,
      short_id: issue.short_id,
      rule_id: rule?.id ?? null,
      effects,
    };
  });

  return {
    bucket,
    facts: delivery.facts,
    matched_short_ids: targets.map((t) => t.short_id),
    unresolved_short_ids: input.unresolvedShortIds,
    outcomes,
    no_rule_matched: rule === null,
  };
};

/** The `state` recorded in github_links[] — the PR's own lifecycle, not the pill. */
export const prLinkState = (delivery: Delivery): string => {
  const f = delivery.facts;
  if (f.event === "pull_request" && f.action === "closed") return f.merged === true ? "merged" : "closed";
  if (f.draft === true) return "draft";
  return "open";
};
