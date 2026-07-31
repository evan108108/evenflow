import { describe, expect, it } from "vitest";
import type { Issue } from "./types";
import {
  EMPTY_FILTERS,
  UNASSIGNED,
  filterByAssignee,
  filterByLabels,
  filterBySprint,
  hasActiveFilters,
  matchesFilters,
  predicateFor,
} from "./boardFilters";

const SONA = "nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2";
const EVAN = "google:104509077344032735108";

const issue = (over: Partial<Issue> = {}): Issue =>
  ({
    id: "i1",
    short_id: "EFB-1",
    board_id: "b1",
    title: "t",
    body: null,
    body_format: "markdown",
    type: "task",
    status: "Todo",
    column_id: "c1",
    container: "board",
    assignee_pubkey: null,
    priority: null,
    estimate: null,
    labels: [],
    github_links: [],
    created_at_ms: 0,
    updated_at_ms: 0,
    completed_at_ms: null,
    ...over,
  }) as Issue;

describe("filterByAssignee", () => {
  // Empty selection is "no constraint" — a cleared picker must not blank the board.
  it("passes everything when nothing is selected", () => {
    expect(filterByAssignee(issue({ assignee_pubkey: SONA }), [])).toBe(true);
    expect(filterByAssignee(issue({ assignee_pubkey: null }), [])).toBe(true);
  });

  it("matches the selected assignees and rejects the rest", () => {
    expect(filterByAssignee(issue({ assignee_pubkey: SONA }), [SONA])).toBe(true);
    expect(filterByAssignee(issue({ assignee_pubkey: EVAN }), [SONA])).toBe(false);
  });

  // An issue has one assignee, so a multi-select can only mean OR.
  it("ORs within the dimension", () => {
    expect(filterByAssignee(issue({ assignee_pubkey: EVAN }), [SONA, EVAN])).toBe(true);
  });

  // EFB-44: "Unassigned" is a first-class picker option, not the empty state.
  it("treats UNASSIGNED as a selectable option for null assignees", () => {
    expect(filterByAssignee(issue({ assignee_pubkey: null }), [UNASSIGNED])).toBe(true);
    expect(filterByAssignee(issue({ assignee_pubkey: SONA }), [UNASSIGNED])).toBe(false);
    expect(filterByAssignee(issue({ assignee_pubkey: null }), [SONA])).toBe(false);
  });

  it("composes UNASSIGNED with real pubkeys", () => {
    const sel = [UNASSIGNED, SONA];
    expect(filterByAssignee(issue({ assignee_pubkey: null }), sel)).toBe(true);
    expect(filterByAssignee(issue({ assignee_pubkey: SONA }), sel)).toBe(true);
    expect(filterByAssignee(issue({ assignee_pubkey: EVAN }), sel)).toBe(false);
  });

  // The sentinel must not be mistakable for a canonical provider:oauth_id.
  it("uses a sentinel that cannot collide with a real pubkey", () => {
    expect(UNASSIGNED).not.toContain(":");
  });
});

describe("filterByLabels", () => {
  it("passes everything when nothing is selected", () => {
    expect(filterByLabels(issue({ labels: ["bug"] }), [])).toBe(true);
    expect(filterByLabels(issue({ labels: [] }), [])).toBe(true);
  });

  it("matches an issue carrying any selected label", () => {
    expect(filterByLabels(issue({ labels: ["bug", "ui"] }), ["bug"])).toBe(true);
    expect(filterByLabels(issue({ labels: ["bug", "ui"] }), ["urgent", "ui"])).toBe(true);
    expect(filterByLabels(issue({ labels: ["bug"] }), ["urgent"])).toBe(false);
  });

  it("rejects an unlabelled issue once a label is selected", () => {
    expect(filterByLabels(issue({ labels: [] }), ["bug"])).toBe(false);
  });
});

describe("matchesFilters — mineOnly", () => {
  it("keeps only the viewer's issues", () => {
    const f = { ...EMPTY_FILTERS, mineOnly: true };
    expect(matchesFilters(issue({ assignee_pubkey: SONA }), f, SONA)).toBe(true);
    expect(matchesFilters(issue({ assignee_pubkey: EVAN }), f, SONA)).toBe(false);
    expect(matchesFilters(issue({ assignee_pubkey: null }), f, SONA)).toBe(false);
  });

  // Signed out there is no "mine". The chip is hidden, but a persisted filter
  // can outlive a sign-out — showing everything beats an unexplained empty board.
  it("is inactive for a signed-out viewer rather than matching nothing", () => {
    const f = { ...EMPTY_FILTERS, mineOnly: true };
    expect(matchesFilters(issue({ assignee_pubkey: EVAN }), f, null)).toBe(true);
    expect(matchesFilters(issue({ assignee_pubkey: null }), f, null)).toBe(true);
  });
});

describe("matchesFilters — composition", () => {
  it("passes everything when no filter is active (baseline)", () => {
    expect(matchesFilters(issue({ assignee_pubkey: EVAN, labels: ["x"] }), EMPTY_FILTERS, SONA)).toBe(
      true,
    );
  });

  // The brief's core requirement: chips AND together.
  it("ANDs across dimensions", () => {
    const f = { mineOnly: true, assignees: [], labels: ["bug"], sprintId: null };
    expect(matchesFilters(issue({ assignee_pubkey: SONA, labels: ["bug"] }), f, SONA)).toBe(true);
    // right label, wrong owner
    expect(matchesFilters(issue({ assignee_pubkey: EVAN, labels: ["bug"] }), f, SONA)).toBe(false);
    // right owner, wrong label
    expect(matchesFilters(issue({ assignee_pubkey: SONA, labels: ["ui"] }), f, SONA)).toBe(false);
  });

  it("narrows as an intersection when assignee and label are both set", () => {
    const f = { mineOnly: false, assignees: [EVAN], labels: ["ui"], sprintId: null };
    expect(matchesFilters(issue({ assignee_pubkey: EVAN, labels: ["ui", "bug"] }), f, SONA)).toBe(
      true,
    );
    expect(matchesFilters(issue({ assignee_pubkey: EVAN, labels: ["bug"] }), f, SONA)).toBe(false);
    expect(matchesFilters(issue({ assignee_pubkey: SONA, labels: ["ui"] }), f, SONA)).toBe(false);
  });

  // mineOnly and an explicit assignee selection are independent gates, so a
  // contradictory pair legitimately matches nothing.
  it("lets mineOnly and a conflicting assignee selection cancel out", () => {
    const f = { mineOnly: true, assignees: [EVAN], labels: [], sprintId: null };
    expect(matchesFilters(issue({ assignee_pubkey: SONA }), f, SONA)).toBe(false);
    expect(matchesFilters(issue({ assignee_pubkey: EVAN }), f, SONA)).toBe(false);
  });
});

describe("hasActiveFilters", () => {
  it("is false only for the empty set", () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, mineOnly: true })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, assignees: [UNASSIGNED] })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, labels: ["bug"] })).toBe(true);
  });
});

describe("filterBySprint", () => {
  it("is no constraint when null", () => {
    expect(filterBySprint(issue({ sprint_id: null }), null)).toBe(true);
    expect(filterBySprint(issue({ sprint_id: "s1" }), null)).toBe(true);
  });

  it("matches only that sprint's issues", () => {
    expect(filterBySprint(issue({ sprint_id: "s1" }), "s1")).toBe(true);
    expect(filterBySprint(issue({ sprint_id: "s2" }), "s1")).toBe(false);
    expect(filterBySprint(issue({ sprint_id: null }), "s1")).toBe(false);
  });
});

describe("predicateFor — scope limits sprint to the active funnel", () => {
  const sprintOnly = { ...EMPTY_FILTERS, sprintId: "s1" };

  it("narrows the active funnel by sprint", () => {
    const pred = predicateFor("active", sprintOnly, SONA);
    expect(pred).toBeDefined();
    expect(pred!(issue({ sprint_id: "s1" }))).toBe(true);
    expect(pred!(issue({ sprint_id: "s2" }))).toBe(false);
    expect(pred!(issue({ sprint_id: null }))).toBe(false);
  });

  // The rail and the Backlog view are deliberately ambient: a sprint-bound
  // backlog issue must still list there. Pre-EFB-45 this held because the
  // scalar prop was simply never forwarded to them.
  it("does not narrow an ambient funnel by sprint", () => {
    expect(predicateFor("ambient", sprintOnly, SONA)).toBeUndefined();
  });

  // THE INVARIANT A NAIVE REFACTOR BREAKS SILENTLY. A sprint board in its
  // default state has the chip on and nothing else set. If sprint were added
  // to the filter shape but not to the short-circuit, the predicate would come
  // back undefined here and sprint filtering would quietly stop working.
  it("builds a predicate when the sprint is the ONLY thing set", () => {
    expect(hasActiveFilters(sprintOnly)).toBe(true);
    expect(predicateFor("active", sprintOnly, SONA)).toBeDefined();
  });

  it("skips the pass entirely when nothing narrows", () => {
    expect(predicateFor("active", EMPTY_FILTERS, SONA)).toBeUndefined();
    expect(predicateFor("ambient", EMPTY_FILTERS, SONA)).toBeUndefined();
  });

  it("intersects sprint with the other dimensions on the active funnel", () => {
    const f = { ...EMPTY_FILTERS, sprintId: "s1", labels: ["bug"] };
    const pred = predicateFor("active", f, SONA);
    expect(pred!(issue({ sprint_id: "s1", labels: ["bug"] }))).toBe(true);
    expect(pred!(issue({ sprint_id: "s1", labels: ["ui"] }))).toBe(false);
    expect(pred!(issue({ sprint_id: "s2", labels: ["bug"] }))).toBe(false);
  });

  // Ambient funnels still see every non-sprint dimension — dropping sprint
  // must not drop the rest.
  it("still applies the other dimensions on an ambient funnel", () => {
    const f = { ...EMPTY_FILTERS, sprintId: "s1", labels: ["bug"] };
    const pred = predicateFor("ambient", f, SONA);
    expect(pred).toBeDefined();
    expect(pred!(issue({ sprint_id: "s2", labels: ["bug"] }))).toBe(true);
    expect(pred!(issue({ sprint_id: "s1", labels: ["ui"] }))).toBe(false);
  });
});

describe("hasActiveFilters — sprint dimension", () => {
  it("counts a sprint selection", () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, sprintId: "s1" })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, sprintId: null })).toBe(false);
  });
});
