// Phase 21 client tests: the external_state pill on a card, and the
// vocabulary helpers it renders through.

import { describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import type { Issue } from "../lib/types";
import type { DndHandle } from "../lib/dnd";
import { IssueCard } from "./IssueCard";
import { describeActions } from "./GithubSection";
import {
  externalStateLabel,
  externalStateTone,
  primaryPrLink,
  prUrl,
} from "../lib/externalState";

const issue: Issue = {
  id: "i1",
  short_id: "KB-7",
  board_id: "b1",
  title: "An issue",
  body: null,
  body_format: "markdown",
  type: "feature",
  status: "Todo",
  column_id: "c1",
  container: "active",
  assignee_pubkey: null,
  priority: null,
  estimate: null,
  labels: [],
  github_links: [],
  created_at_ms: 1,
  updated_at_ms: 1,
  completed_at_ms: null,
};

const clickDnd: DndHandle = {
  draggingId: () => null,
  overZone: () => null,
  pos: () => ({ x: 0, y: 0 }),
  startDrag: (_e, _id, onClick) => onClick(),
};

const mount = (component: () => unknown) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(component as () => any, container);
  return {
    container,
    cleanup: () => {
      dispose();
      container.remove();
    },
  };
};

const card = (over: Partial<Issue>) =>
  mount(() => (
    <IssueCard issue={{ ...issue, ...over }} dnd={clickDnd} onOpen={() => undefined} compact />
  ));

describe("external state vocabulary", () => {
  it("labels the default values in prose", () => {
    expect(externalStateLabel("pr_changes_requested")).toBe("Changes requested");
    expect(externalStateLabel("ci_failed")).toBe("CI failed");
  });

  it("renders an unknown custom value verbatim rather than blank", () => {
    expect(externalStateLabel("blocked_upstream")).toBe("blocked_upstream");
    expect(externalStateTone("blocked_upstream")).toBe("neutral");
  });

  it("tones map failure and success apart", () => {
    expect(externalStateTone("ci_failed")).toBe("bad");
    expect(externalStateTone("pr_approved")).toBe("good");
  });

  it("prefers a live PR over a closed one when choosing the link", () => {
    const links = [
      { repo: "o/r", pr: 1, state: "merged" },
      { repo: "o/r", pr: 2, state: "open" },
    ];
    expect(primaryPrLink(links)?.pr).toBe(2);
  });

  it("falls back to the last link when none are live", () => {
    const links = [
      { repo: "o/r", pr: 1, state: "closed" },
      { repo: "o/r", pr: 2, state: "merged" },
    ];
    expect(primaryPrLink(links)?.pr).toBe(2);
  });

  it("has no link when the ticket carries none", () => {
    expect(primaryPrLink([])).toBeNull();
  });

  it("builds a github PR url", () => {
    expect(prUrl({ repo: "evan108108/evenflow", pr: 42 })).toBe(
      "https://github.com/evan108108/evenflow/pull/42",
    );
  });
});

describe("IssueCard external_state pill", () => {
  it("renders no pill when the issue has no external state", () => {
    const { container, cleanup } = card({});
    expect(container.querySelector(".external-state-pill")).toBeNull();
    cleanup();
  });

  it("renders the labelled pill with its tone class", () => {
    const { container, cleanup } = card({ external_state: "ci_failed" });
    const pill = container.querySelector(".external-state-pill")!;
    expect(pill.textContent).toBe("CI failed");
    expect(pill.classList.contains("tone-bad")).toBe(true);
    cleanup();
  });

  it("links the pill to the PR when one is recorded", () => {
    const { container, cleanup } = card({
      external_state: "pr_review",
      github_links: [{ repo: "evan108108/evenflow", pr: 42, state: "open" }],
    });
    const pill = container.querySelector(".external-state-pill")!;
    expect(pill.getAttribute("href")).toBe("https://github.com/evan108108/evenflow/pull/42");
    expect(pill.getAttribute("target")).toBe("_blank");
    expect(pill.getAttribute("title")).toContain("evan108108/evenflow#42");
    cleanup();
  });

  it("renders an unlinked pill when no PR link exists", () => {
    const { container, cleanup } = card({ external_state: "pr_review" });
    const pill = container.querySelector(".external-state-pill")!;
    expect(pill.getAttribute("href")).toBeNull();
    expect(pill.classList.contains("is-link")).toBe(false);
    cleanup();
  });

  it("the pill sits outside the chip row — it is not a board-local attribute", () => {
    const { container, cleanup } = card({ external_state: "pr_merged", labels: ["infra"] });
    expect(container.querySelector(".chips .external-state-pill")).toBeNull();
    expect(container.querySelector(".card-external-state .external-state-pill")).not.toBeNull();
    cleanup();
  });

  it("a pill click does not start a card drag", () => {
    let opened = false;
    const { container, cleanup } = mount(() => (
      <IssueCard
        issue={{ ...issue, external_state: "pr_review", github_links: [{ repo: "o/r", pr: 1, state: "open" }] }}
        dnd={clickDnd}
        onOpen={() => {
          opened = true;
        }}
        compact
      />
    ));
    const pill = container.querySelector<HTMLElement>(".external-state-pill")!;
    pill.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    // stopPropagation keeps the card's open handler out of it — otherwise
    // following the PR link would also pop the issue sheet.
    expect(opened).toBe(false);
    cleanup();
  });
});

// ── the rules table's action column ──────────────────────────────────────
//
// `do` accepts an array, and this renderer read it as a single action — so the
// defaults preset's merged rule (array-form on every board since the engine
// learned multi-action rules) rendered as a bare "?". EFB-72 turns three more
// rules into arrays, so the same bug would have hidden four rules instead of one.
describe("describeActions", () => {
  it("describes a single action", () => {
    expect(describeActions({ type: "set_external_state", value: "pr_review" })).toBe(
      "set pill → PR in review",
    );
  });

  it("describes every action in an array, in order", () => {
    expect(
      describeActions([
        { type: "set_external_state", value: "pr_review" },
        { type: "transition_to_column", category: "in_review" },
      ]),
    ).toBe('set pill → PR in review, then move to first "in_review" column');
  });

  it("never renders a known action list as an unknown", () => {
    const merged = [
      { type: "set_external_state", value: "pr_merged" },
      { type: "transition_to_column", category: "done" },
    ];
    expect(describeActions(merged)).not.toContain("?");
  });
});
