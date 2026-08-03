// Unit tests for the GitHub integration's pure core: ref extraction,
// template rendering, predicate matching, preset ordering, secret crypto,
// and plan evaluation. No HTTP, no database — everything here is the layer
// the endpoint tests then exercise end to end.

import { describe, expect, it } from "vitest";
import { extractTicketRefs } from "../src/github/refs";
import { renderTemplate, templatePaths } from "../src/github/template";
import {
  DEFAULT_PRESET_RULES,
  STATUS_ONLY_PRESET_RULES,
  actionProblem,
  firstMatchingRule,
  predicateMatches,
  predicateProblem,
  presetRules,
  type EventFacts,
  type PresetRule,
  type Rule,
} from "../src/github/rules";
import {
  mintWebhookSecret,
  openWebhookSecret,
  sealWebhookSecret,
  signGithubBody,
  verifyGithubSignature,
} from "../src/github/secret";
import { evaluateDelivery, parseDelivery, type TargetIssue } from "../src/github/engine";
import {
  allowedExternalStates,
  externalStateConfigProblem,
  DEFAULT_EXTERNAL_STATES,
} from "../src/github/external-state";
import type { Column } from "../src/columns";
import { fixture, type FixtureName } from "./fixtures/github";


const COLUMNS: Column[] = [
  { id: "col-todo", name: "Todo", order: 0, enabled: true, category: "todo" },
  { id: "col-prog", name: "In Progress", order: 1, enabled: true, category: "in_progress" },
  { id: "col-rev", name: "In Review", order: 2, enabled: true, category: "in_review" },
  { id: "col-done", name: "Done", order: 3, enabled: true, category: "done" },
];

const MASTER = "a".repeat(64);

/** Turn preset entries into full Rule rows the matcher can consume. */
const asRules = (preset: ReadonlyArray<PresetRule>): Rule[] =>
  preset.map((r, i) => ({
    id: `r${i}`,
    board_id: "b1",
    bucket: r.bucket,
    priority: i * 10,
    when: r.when,
    do: r.do,
    enabled: true,
    created_at_ms: 1,
    updated_at_ms: 1,
  }));

const target = (over: Partial<TargetIssue> = {}): TargetIssue => ({
  id: "i1",
  short_id: "KB-7",
  title: "Wire the pill",
  column_id: "col-todo",
  container: "active",
  labels: [],
  external_state: null,
  ...over,
});

// ── ref extraction ────────────────────────────────────────────────────────

describe("extractTicketRefs", () => {
  it("finds a ref in the title", () => {
    expect(extractTicketRefs({ title: "KB-7 wire the pill" }).shortIds).toEqual(["KB-7"]);
  });

  it("finds a ref in a branch name with slashes", () => {
    const r = extractTicketRefs({ branch: "feature/KB-7-external-state" });
    expect(r.shortIds).toEqual(["KB-7"]);
  });

  it("uppercases and de-duplicates across sources", () => {
    const r = extractTicketRefs({
      title: "kb-7 thing",
      body: "Refs KB-7 and KB-9",
      branch: "feature/KB-7-x",
    });
    expect(r.shortIds).toEqual(["KB-7", "KB-9"]);
    expect(r.explicit).toBe(false);
  });

  it("an explicit evenflow: line wins outright and suppresses inference", () => {
    const r = extractTicketRefs({
      title: "KB-7 fix the thing",
      body: "This actually belongs elsewhere.\n\nevenflow: KB-9\n",
    });
    expect(r.shortIds).toEqual(["KB-9"]);
    expect(r.explicit).toBe(true);
  });

  it("accepts several ids on one explicit line", () => {
    const r = extractTicketRefs({ body: "evenflow: KB-1, KB-2" });
    expect(r.shortIds).toEqual(["KB-1", "KB-2"]);
  });

  it("does not split a longer prefix or truncate a longer number", () => {
    // XKB is itself a legal prefix, so "XKB-7" must yield XKB-7 — and
    // crucially NOT the KB-7 hiding inside it.
    expect(extractTicketRefs({ title: "see XKB-7" }).shortIds).toEqual(["XKB-7"]);
    expect(extractTicketRefs({ title: "KB-42" }).shortIds).toEqual(["KB-42"]);
  });

  it("ignores an ISO date", () => {
    // Without the trailing (?!-\d) guard this yields the plausible-looking
    // short id "2026-07".
    expect(extractTicketRefs({ title: "released 2026-07-30" }).shortIds).toEqual([]);
  });

  it("matches a ref followed by a dashed branch suffix", () => {
    expect(extractTicketRefs({ branch: "feature/KB-7-external-state" }).shortIds).toEqual(["KB-7"]);
  });

  it("returns nothing for a PR with no ref", () => {
    expect(extractTicketRefs({ title: "Bump dependencies", branch: "chore/deps" }).shortIds).toEqual(
      [],
    );
  });
});

// ── templates ─────────────────────────────────────────────────────────────

describe("renderTemplate", () => {
  const ctx = {
    check_run: { name: "worker-qa", html_url: "https://gh/runs/1" },
    pull_request: { number: 42, draft: false },
    review: null,
  };

  it("substitutes scalar paths", () => {
    const r = renderTemplate("Check '{{ check_run.name }}' failed on PR #{{ pull_request.number }}.", ctx);
    expect(r.text).toBe("Check 'worker-qa' failed on PR #42.");
    expect(r.unknownPaths).toEqual([]);
  });

  it("renders booleans as text", () => {
    expect(renderTemplate("draft={{ pull_request.draft }}", ctx).text).toBe("draft=false");
  });

  it("renders objects as a fenced JSON block", () => {
    const r = renderTemplate("{{ check_run }}", ctx);
    expect(r.text).toContain("```json");
    expect(r.text).toContain('"worker-qa"');
  });

  it("leaves an unknown path verbatim and reports it", () => {
    const r = renderTemplate("hi {{ nope.missing }} end", ctx);
    // Emptying it silently would produce a comment that reads fine and
    // says the wrong thing — the failure mode this behaviour prevents.
    expect(r.text).toBe("hi {{ nope.missing }} end");
    expect(r.unknownPaths).toEqual(["nope.missing"]);
  });

  it("treats a null-valued path as unknown", () => {
    expect(renderTemplate("{{ review.state }}", ctx).unknownPaths).toEqual(["review.state"]);
  });

  it("lists referenced paths", () => {
    expect(templatePaths("{{ a.b }} and {{ c }} and {{ a.b }}")).toEqual(["a.b", "c"]);
  });
});

// ── predicates ────────────────────────────────────────────────────────────

const facts = (over: Partial<EventFacts> = {}): EventFacts => ({
  event: "pull_request",
  action: "opened",
  merged: null,
  draft: false,
  review_state: null,
  conclusion: null,
  check_name: null,
  ...over,
});

describe("predicateMatches", () => {
  it("matches on event alone when no sub-filters are set", () => {
    expect(predicateMatches({ event: "pull_request" }, facts())).toBe(true);
  });

  it("ANDs sub-filters", () => {
    expect(predicateMatches({ event: "pull_request", action: "closed" }, facts())).toBe(false);
  });

  it("splits merged from unmerged on the same action", () => {
    const closedMerged = facts({ action: "closed", merged: true });
    const closedAbandoned = facts({ action: "closed", merged: false });
    const p = { event: "pull_request", action: "closed", merged: true } as const;
    expect(predicateMatches(p, closedMerged)).toBe(true);
    expect(predicateMatches(p, closedAbandoned)).toBe(false);
  });

  it("matches check names case-insensitively by substring", () => {
    const f = facts({ event: "check_run", action: "completed", check_name: "Worker-QA" });
    expect(predicateMatches({ event: "check_run", check_name_contains: "qa" }, f)).toBe(true);
    expect(predicateMatches({ event: "check_run", check_name_contains: "e2e" }, f)).toBe(false);
  });

  it("never matches a check_name filter when the event carries no name", () => {
    expect(predicateMatches({ event: "check_run", check_name_contains: "qa" }, facts({ event: "check_run" }))).toBe(false);
  });
});

describe("firstMatchingRule", () => {
  const rules = asRules(DEFAULT_PRESET_RULES);

  it("returns the lowest-priority match, not merely the first listed", () => {
    const shuffled = [...rules].reverse();
    const hit = firstMatchingRule(shuffled, "match", facts({ action: "closed", merged: true }));
    expect(hit?.do).toEqual([
      { type: "set_external_state", value: "pr_merged" },
      { type: "transition_to_column", category: "done" },
    ]);
  });

  it("skips disabled rules", () => {
    const disabled = rules.map((r) => ({ ...r, enabled: false }));
    expect(firstMatchingRule(disabled, "match", facts())).toBeNull();
  });

  it("does not cross buckets", () => {
    expect(firstMatchingRule(rules, "no_match", facts())).toBeNull();
  });
});

describe("default preset ordering", () => {
  const rules = asRules(DEFAULT_PRESET_RULES);

  it("a merged PR sets pr_merged AND transitions to done", () => {
    const hit = firstMatchingRule(rules, "match", facts({ action: "closed", merged: true }));
    expect(hit?.do).toEqual([
      { type: "set_external_state", value: "pr_merged" },
      { type: "transition_to_column", category: "done" },
    ]);
  });

  it("a closed-unmerged PR sets pr_closed and does NOT transition", () => {
    const hit = firstMatchingRule(rules, "match", facts({ action: "closed", merged: false }));
    expect(hit?.do).toEqual({ type: "set_external_state", value: "pr_closed" });
  });

  it("a PR opened as draft reads pr_draft, not pr_review", () => {
    const hit = firstMatchingRule(rules, "match", facts({ action: "opened", draft: true }));
    expect(hit?.do).toEqual({ type: "set_external_state", value: "pr_draft" });
  });

  it("a normal opened PR sets pr_review AND transitions to in_review", () => {
    const hit = firstMatchingRule(rules, "match", facts({ action: "opened", draft: false }));
    expect(hit?.do).toEqual([
      { type: "set_external_state", value: "pr_review" },
      { type: "transition_to_column", category: "in_review" },
    ]);
  });

  it("reopened and ready_for_review transition too — the same three-rule set", () => {
    for (const action of ["reopened", "ready_for_review"]) {
      const hit = firstMatchingRule(rules, "match", facts({ action, draft: false }));
      expect(hit?.do, action).toEqual([
        { type: "set_external_state", value: "pr_review" },
        { type: "transition_to_column", category: "in_review" },
      ]);
    }
  });

  // EFB-72's one deliberate exclusion. `synchronize` fires on every push to the
  // branch, so a transition here would drag the card back to In Review each
  // time someone pushed — overriding any manual move for the life of the PR.
  // This is the regression guard for that: the rule must stay pill-only.
  it("synchronize stays pill-only — never re-transitions on a push", () => {
    const hit = firstMatchingRule(rules, "match", facts({ action: "synchronize", draft: false }));
    expect(hit?.do).toEqual({ type: "set_external_state", value: "pr_review" });
  });

  it("an approved review reads pr_approved", () => {
    const hit = firstMatchingRule(
      rules,
      "match",
      facts({ event: "pull_request_review", action: "submitted", review_state: "approved", draft: null }),
    );
    expect(hit?.do).toEqual({ type: "set_external_state", value: "pr_approved" });
  });

  it("a failed check comments with the check name", () => {
    const hit = firstMatchingRule(
      rules,
      "match",
      facts({ event: "check_run", action: "completed", conclusion: "failure", draft: null }),
    );
    // `do` is single-action or array form since EFB-72 — unwrap before reading
    // `.type`, the same discipline planActions uses in engine.ts.
    const actions = hit === null ? [] : Array.isArray(hit.do) ? hit.do : [hit.do];
    expect(actions.map((a) => a.type)).toEqual(["add_comment"]);
  });

  it("status_only strips every transition", () => {
    const hasTransition = (r: { do: unknown }) => {
      const actions = Array.isArray(r.do) ? r.do : [r.do];
      return actions.some((a) => (a as { type: string }).type === "transition_to_column");
    };
    expect(DEFAULT_PRESET_RULES.some(hasTransition)).toBe(true);
    expect(STATUS_ONLY_PRESET_RULES.some(hasTransition)).toBe(false);
  });

  // EFB-72 drift guard, both directions. status_only is DERIVED from defaults
  // by filtering transitions out, so adding a transition to a defaults rule
  // silently changes what status_only strips. These two assertions pin the
  // pair: defaults.opened carries BOTH actions, status_only.opened carries
  // ONLY the pill — and it collapses back to single-action form rather than a
  // one-element array, which is the shape the seeder writes to the DB.
  it("adding the opened transition leaves status_only pill-only", () => {
    const openedIn = (preset: ReadonlyArray<PresetRule>) =>
      preset.find((r) => r.when.event === "pull_request" && r.when.action === "opened" && r.when.draft === undefined);

    expect(openedIn(DEFAULT_PRESET_RULES)?.do).toEqual([
      { type: "set_external_state", value: "pr_review" },
      { type: "transition_to_column", category: "in_review" },
    ]);
    expect(openedIn(STATUS_ONLY_PRESET_RULES)?.do).toEqual({
      type: "set_external_state",
      value: "pr_review",
    });
  });

  it("off and custom seed nothing", () => {
    expect(presetRules("off")).toEqual([]);
    expect(presetRules("custom")).toEqual([]);
  });
});

// ── validation ────────────────────────────────────────────────────────────

describe("rule validation", () => {
  it("rejects an unknown event", () => {
    expect(predicateProblem({ event: "deployment" })).toBe("when-event");
  });

  it("rejects an unknown sub-filter field", () => {
    expect(predicateProblem({ event: "pull_request", nope: "x" })).toBe("when-unknown-field");
  });

  it("accepts a well-formed predicate", () => {
    expect(predicateProblem({ event: "pull_request", action: "closed", merged: true })).toBeNull();
  });

  it("requires exactly one transition target", () => {
    const both = { type: "transition_to_column", column_id: "c", category: "done" };
    const neither = { type: "transition_to_column" };
    expect(actionProblem(both, DEFAULT_EXTERNAL_STATES)).toBe("do-transition-target");
    expect(actionProblem(neither, DEFAULT_EXTERNAL_STATES)).toBe("do-transition-target");
    expect(actionProblem({ type: "transition_to_column", category: "done" }, DEFAULT_EXTERNAL_STATES)).toBeNull();
  });

  it("rejects an external state outside the board's vocabulary", () => {
    expect(actionProblem({ type: "set_external_state", value: "pr_review" }, ["ci_failed"])).toBe(
      "do-external-state-not-allowed",
    );
  });

  it("requires a pubkey for a fixed assignment", () => {
    expect(actionProblem({ type: "assign", who: "fixed" }, DEFAULT_EXTERNAL_STATES)).toBe("do-assign-pubkey");
    expect(actionProblem({ type: "assign", who: "pr_author" }, DEFAULT_EXTERNAL_STATES)).toBeNull();
  });

  it("rejects an empty comment template", () => {
    expect(actionProblem({ type: "add_comment", template: "  " }, DEFAULT_EXTERNAL_STATES)).toBe("do-template");
  });
});

describe("external state config", () => {
  it("null config yields the defaults", () => {
    expect(allowedExternalStates(null)).toEqual(DEFAULT_EXTERNAL_STATES);
  });

  it("malformed JSON falls back to the defaults rather than throwing", () => {
    expect(allowedExternalStates("{not json")).toEqual(DEFAULT_EXTERNAL_STATES);
  });

  it("a custom vocabulary is honoured", () => {
    expect(allowedExternalStates('["blocked_upstream"]')).toEqual(["blocked_upstream"]);
  });

  it("rejects duplicates and bad shapes", () => {
    expect(externalStateConfigProblem(["a_b", "a_b"])).toBe("duplicate");
    expect(externalStateConfigProblem(["Bad-Value"])).toBe("value");
    expect(externalStateConfigProblem([])).toBe("shape");
  });
});

// ── secret crypto ─────────────────────────────────────────────────────────

describe("webhook secret", () => {
  it("seals and opens a round trip", async () => {
    const plain = mintWebhookSecret();
    const sealed = await sealWebhookSecret(MASTER, plain);
    expect(sealed).not.toBeNull();
    expect(sealed).not.toContain(plain);
    expect(await openWebhookSecret(MASTER, sealed)).toBe(plain);
  });

  it("uses a fresh IV per seal", async () => {
    const a = await sealWebhookSecret(MASTER, "same");
    const b = await sealWebhookSecret(MASTER, "same");
    expect(a).not.toBe(b);
  });

  it("fails closed on the wrong master key", async () => {
    const sealed = await sealWebhookSecret(MASTER, "s3cret");
    expect(await openWebhookSecret("b".repeat(64), sealed)).toBeNull();
  });

  it("returns null when the master key is absent or malformed", async () => {
    expect(await sealWebhookSecret(undefined, "x")).toBeNull();
    expect(await sealWebhookSecret("short", "x")).toBeNull();
  });

  it("verifies a signature it produced", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = await signGithubBody("topsecret", body);
    expect(await verifyGithubSignature("topsecret", body, sig)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, and a malformed header", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = await signGithubBody("topsecret", body);
    expect(await verifyGithubSignature("topsecret", `${body} `, sig)).toBe(false);
    expect(await verifyGithubSignature("othersecret", body, sig)).toBe(false);
    expect(await verifyGithubSignature("topsecret", body, "sha256=zz")).toBe(false);
    expect(await verifyGithubSignature("topsecret", body, "deadbeef")).toBe(false);
    expect(await verifyGithubSignature("topsecret", body, null)).toBe(false);
  });
});

// ── delivery parsing + evaluation ─────────────────────────────────────────

describe("parseDelivery", () => {
  it("normalizes a merged PR", () => {
    const d = parseDelivery("pull_request", fixture("pull_request.closed_merged"));
    expect(d.facts.action).toBe("closed");
    expect(d.facts.merged).toBe(true);
    expect(d.repo).toBe("evan108108/evenflow");
    expect(d.pr?.number).toBe(42);
    expect(d.refs.shortIds).toContain("KB-7");
  });

  it("lowercases the review state", () => {
    const d = parseDelivery("pull_request_review", fixture("pull_request_review.submitted_approved"));
    expect(d.facts.review_state).toBe("approved");
  });

  it("reads a check_run's PR from pull_requests[] and matches on branch alone", () => {
    const d = parseDelivery("check_run", fixture("check_run.completed_failure"));
    expect(d.facts.conclusion).toBe("failure");
    expect(d.facts.check_name).toBe("worker-qa");
    expect(d.pr?.number).toBe(42);
    expect(d.refs.shortIds).toEqual(["KB-7"]);
  });

  it("never throws on a malformed payload", () => {
    for (const bad of [null, 42, "str", {}, { pull_request: "nope" }, []]) {
      const d = parseDelivery("pull_request", bad);
      expect(d.refs.shortIds).toEqual([]);
    }
  });

  it("exposes only whitelisted fields to templates", () => {
    const d = parseDelivery("pull_request", fixture("pull_request.opened"));
    // The raw payload's repository object carries owner/ids we must not
    // expose to a template that renders into someone's board.
    expect(Object.keys(d.templateContext.repository as object)).toEqual(["full_name"]);
    expect(d.templateContext).not.toHaveProperty("sender");
  });
});

describe("evaluateDelivery", () => {
  const rules = asRules(DEFAULT_PRESET_RULES);

  const evaluate = (fixtureName: FixtureName, event: string, targets: TargetIssue[]) =>
    evaluateDelivery({
      delivery: parseDelivery(event, fixture(fixtureName)),
      rules,
      columns: COLUMNS,
      targets,
      unresolvedShortIds: [],
      authorPubkey: null,
    });

  it("records the PR link on every matched ticket, independent of any rule", () => {
    const plan = evaluate("pull_request.opened", "pull_request", [target()]);
    const link = plan.outcomes[0]?.effects.find((e) => e.kind === "record_pr_link");
    expect(link).toEqual({
      kind: "record_pr_link",
      repo: "evan108108/evenflow",
      pr: 42,
      state: "open",
    });
  });

  it("a merged PR plans a move to the done column", () => {
    const plan = evaluate("pull_request.closed_merged", "pull_request", [target()]);
    expect(plan.outcomes[0]?.effects).toContainEqual({
      kind: "set_column",
      column_id: "col-done",
      column_name: "Done",
    });
  });

  // ── EFB-72: the opened side transitions too ─────────────────────────────

  it("an opened PR plans the in_review move alongside the pill", () => {
    const plan = evaluate("pull_request.opened", "pull_request", [target()]);
    expect(plan.outcomes[0]?.effects).toContainEqual({
      kind: "set_external_state",
      value: "pr_review",
    });
    expect(plan.outcomes[0]?.effects).toContainEqual({
      kind: "set_column",
      column_id: "col-rev",
      column_name: "In Review",
    });
  });

  // ── EFB-73: a move out of the backlog carries the card into active ──────

  it("promotes a backlog ticket to active when a transition fires", () => {
    const plan = evaluate("pull_request.closed_merged", "pull_request", [
      target({ container: "backlog" }),
    ]);
    expect(plan.outcomes[0]?.effects).toContainEqual({
      kind: "set_column",
      column_id: "col-done",
      column_name: "Done",
    });
    expect(plan.outcomes[0]?.effects).toContainEqual({ kind: "set_container", container: "active" });
  });

  it("leaves an already-active ticket's container alone", () => {
    const plan = evaluate("pull_request.closed_merged", "pull_request", [
      target({ container: "active" }),
    ]);
    expect(plan.outcomes[0]?.effects.some((e) => e.kind === "set_container")).toBe(false);
  });

  // The deliberate divergence from the client, which DOES promote out of the
  // icebox on a manual drag. A human drag is an explicit un-park; a PR event
  // is not — someone may open a PR against an iceboxed ticket before the
  // human has decided to bring it back.
  it("never un-parks an iceboxed ticket — icebox is sticky under webhooks", () => {
    const plan = evaluate("pull_request.closed_merged", "pull_request", [
      target({ container: "icebox" }),
    ]);
    expect(plan.outcomes[0]?.effects).toContainEqual({
      kind: "set_column",
      column_id: "col-done",
      column_name: "Done",
    });
    expect(plan.outcomes[0]?.effects.some((e) => e.kind === "set_container")).toBe(false);
  });

  // No transition, no promotion. The container follows a move that actually
  // happened — a skipped transition must not drag the card out of the backlog.
  it("does not promote when the transition itself is skipped", () => {
    const plan = evaluate("pull_request.closed_merged", "pull_request", [
      target({ column_id: "col-done", container: "backlog" }),
    ]);
    expect(plan.outcomes[0]?.effects).toContainEqual({ kind: "skipped", reason: "already-in-column" });
    expect(plan.outcomes[0]?.effects.some((e) => e.kind === "set_container")).toBe(false);
  });

  it("skips the move when the board has no done column, keeping the link", () => {
    const noDone = COLUMNS.filter((c) => c.category !== "done");
    const plan = evaluateDelivery({
      delivery: parseDelivery("pull_request", fixture("pull_request.closed_merged")),
      rules,
      columns: noDone,
      targets: [target()],
      unresolvedShortIds: [],
      authorPubkey: null,
    });
    expect(plan.outcomes[0]?.effects).toContainEqual({
      kind: "skipped",
      reason: "no-column-in-category-done",
    });
  });

  it("skips a transition when the ticket is already in the target column", () => {
    const plan = evaluate("pull_request.closed_merged", "pull_request", [
      target({ column_id: "col-done" }),
    ]);
    expect(plan.outcomes[0]?.effects).toContainEqual({ kind: "skipped", reason: "already-in-column" });
  });

  it("applies to every matched ticket", () => {
    const plan = evaluate("pull_request.opened", "pull_request", [
      target(),
      target({ id: "i2", short_id: "KB-8" }),
    ]);
    expect(plan.outcomes).toHaveLength(2);
    expect(plan.matched_short_ids).toEqual(["KB-7", "KB-8"]);
  });

  it("a PR with no ref lands in the no_match bucket", () => {
    const plan = evaluate("pull_request.opened_no_ref", "pull_request", []);
    expect(plan.bucket).toBe("no_match");
    expect(plan.outcomes).toEqual([]);
    expect(plan.no_rule_matched).toBe(true);
  });

  it("reports when no rule matched even though a ticket did", () => {
    const plan = evaluateDelivery({
      delivery: parseDelivery("pull_request", fixture("pull_request.opened")),
      rules: [],
      columns: COLUMNS,
      targets: [target()],
      unresolvedShortIds: [],
      authorPubkey: null,
    });
    expect(plan.no_rule_matched).toBe(true);
    // The PR link is still recorded — it is a fact, not an automation.
    expect(plan.outcomes[0]?.effects).toHaveLength(1);
  });

  it("skips assign(pr_author) when the author maps to no member", () => {
    const withAssign = asRules([
      { bucket: "match", when: { event: "pull_request", action: "opened" }, do: { type: "assign", who: "pr_author" } },
    ]);
    const plan = evaluateDelivery({
      delivery: parseDelivery("pull_request", fixture("pull_request.opened")),
      rules: withAssign,
      columns: COLUMNS,
      targets: [target()],
      unresolvedShortIds: [],
      authorPubkey: null,
    });
    expect(plan.outcomes[0]?.effects).toContainEqual({ kind: "skipped", reason: "pr-author-unmapped" });
  });

  it("records merged/closed link state distinctly", () => {
    const merged = evaluate("pull_request.closed_merged", "pull_request", [target()]);
    const closed = evaluate("pull_request.closed_unmerged", "pull_request", [target()]);
    expect(merged.outcomes[0]?.effects[0]).toMatchObject({ state: "merged" });
    expect(closed.outcomes[0]?.effects[0]).toMatchObject({ state: "closed" });
  });
});
