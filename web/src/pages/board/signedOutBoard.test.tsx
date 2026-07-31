// EFB-47 — a signed-out visitor may read a PUBLIC board and mutate none of it.
//
// Two things are under test and they fail in different ways, so they are
// tested separately:
//
//   1. WHO GETS BOUNCED. Previously BoardPage.onMount returned early on a
//      null JWT, so store.load() never ran at all — meaning removing the
//      redirect alone would have left a signed-out visitor on a permanently
//      loading board rather than a rendered one. The rule now lives in
//      shouldRedirectAnonymous so it can be asserted without a router, the
//      Effect runtime and an AuthManager, whose combined weight is why this
//      branch went unverified long enough to ship the bug.
//
//   2. WHAT A VIEWER CAN REACH. Read-only is only true if every mutation
//      affordance is actually gone, so these assert absence rather than
//      presence — and each has a signed-in counterpart, because a gate that
//      hides the control from everybody would pass an absence-only test
//      while breaking the app.

import { describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import type { Board, Issue } from "../../lib/types";
import type { Column } from "../../lib/columns";
import type { DndHandle } from "../../lib/dnd";
import type { BoardStore } from "./store";
import { shouldRedirectAnonymous } from "../../lib/boardAccess";
import { BacklogView } from "./BacklogView";

const SIGNED_IN_JWT = "header.payload.sig";

const col = (id: string, name: string, order: number, category: Column["category"]): Column => ({
  id,
  name,
  order,
  enabled: true,
  category,
});

const board: Board = {
  id: "b1",
  pubkey: "test:0",
  slug: "kb",
  title: "Board",
  description: null,
  columns: [col("c1", "Todo", 0, "todo"), col("c2", "Done", 1, "done")],
  labels: [],
  member_policy: "invite",
  is_encrypted: false,
  issue_prefix: "KB",
  next_issue_number: 9,
  created_at_ms: 1,
  updated_at_ms: 1,
};

const issue: Issue = {
  id: "i1",
  short_id: "KB-1",
  board_id: "b1",
  title: "readable",
  body: null,
  body_format: "markdown",
  type: "task",
  status: "Todo",
  column_id: "c1",
  container: "backlog",
  assignee_pubkey: null,
  priority: null,
  estimate: null,
  labels: [],
  github_links: [],
  created_at_ms: 1,
  updated_at_ms: 1,
  completed_at_ms: null,
};

const sprint = {
  id: "s1",
  board_id: "b1",
  name: "Sprint 1",
  goal: null,
  status: "planning",
  planned_days: null,
  started_at_ms: null,
  completed_at_ms: null,
  created_at_ms: 1,
};

const stub = (issues: Issue[], sprints: unknown[] = []) =>
  ({
    board: () => board,
    issues: () => issues,
    sprints: () => sprints,
    members: () => [],
    refetchIssues: async () => undefined,
    refreshStreams: async () => undefined,
    patchSprint: async () => undefined,
    startSprint: async () => undefined,
    deleteSprint: async () => undefined,
    createSprint: async () => undefined,
    streamFor: () => ({
      key: "stub",
      loadNext: async () => undefined,
      hasMore: () => false,
      loading: () => false,
      started: () => true,
      reset: () => undefined,
    }),
  }) as unknown as BoardStore;

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

const buttonNamed = (root: Element, label: string): Element | undefined =>
  [...root.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label);

describe("EFB-47 — who gets redirected off a board", () => {
  // The whole point of the ticket: this case used to redirect.
  it("keeps an anonymous visitor when the board resolved (i.e. it is public)", () => {
    expect(shouldRedirectAnonymous(null, board)).toBe(false);
  });

  // Private and non-existent are the SAME observation to an anonymous
  // caller — the API returns 404 {reason:"board"} for both — so one case
  // covers both and the client must not try to tell them apart.
  it("redirects an anonymous visitor when the board did not come back", () => {
    expect(shouldRedirectAnonymous(null, null)).toBe(true);
  });

  it("never redirects a signed-in caller, even when the board is missing", () => {
    expect(shouldRedirectAnonymous(SIGNED_IN_JWT, null)).toBe(false);
    expect(shouldRedirectAnonymous(SIGNED_IN_JWT, board)).toBe(false);
  });
});

describe("EFB-47 — signed-out viewer reaches no mutation in BacklogView", () => {
  it("renders the board's content", () => {
    const { container, cleanup } = mount(() => (
      <BacklogView store={stub([issue], [sprint])} dnd={clickDnd} onOpen={() => undefined} readOnly />
    ));
    // Read access is the feature — assert it survives the gating.
    expect(container.textContent).toContain("readable");
    expect(container.querySelector<HTMLInputElement>(".sprint-name")!.value).toBe("Sprint 1");
    cleanup();
  });

  it("hides the pure-action controls", () => {
    const { container, cleanup } = mount(() => (
      <BacklogView store={stub([issue], [sprint])} dnd={clickDnd} onOpen={() => undefined} readOnly />
    ));
    expect(buttonNamed(container, "+ New sprint")).toBeUndefined();
    expect(buttonNamed(container, "Start sprint")).toBeUndefined();
    expect(buttonNamed(container, "Delete")).toBeUndefined();
    cleanup();
  });

  it("leaves the data-bearing fields visible but not editable", () => {
    const { container, cleanup } = mount(() => (
      <BacklogView store={stub([issue], [sprint])} dnd={clickDnd} onOpen={() => undefined} readOnly />
    ));
    // Name / days / goal carry information, so they are shown read-only
    // rather than removed — hiding them would cost the viewer real content.
    for (const sel of [".sprint-name", ".sprint-goal", ".sprint-days input"]) {
      const el = container.querySelector<HTMLInputElement>(sel)!;
      expect(el).not.toBeNull();
      expect(el.readOnly).toBe(true);
    }
    cleanup();
  });
});

describe("EFB-47 — signed-in is unchanged", () => {
  // Guards against the failure mode an absence-only suite cannot see: a gate
  // that hides the control from everyone.
  it("still offers every sprint control when not read-only", () => {
    const { container, cleanup } = mount(() => (
      <BacklogView store={stub([issue], [sprint])} dnd={clickDnd} onOpen={() => undefined} />
    ));
    expect(buttonNamed(container, "+ New sprint")).toBeDefined();
    expect(buttonNamed(container, "Start sprint")).toBeDefined();
    expect(buttonNamed(container, "Delete")).toBeDefined();
    for (const sel of [".sprint-name", ".sprint-goal", ".sprint-days input"]) {
      expect(container.querySelector<HTMLInputElement>(sel)!.readOnly).toBe(false);
    }
    cleanup();
  });

  // readOnly is optional; omitting it must mean "editable", not "locked".
  it("treats an omitted readOnly prop as signed-in", () => {
    const { container, cleanup } = mount(() => (
      <BacklogView store={stub([issue], [sprint])} dnd={clickDnd} onOpen={() => undefined} />
    ));
    expect(buttonNamed(container, "+ New sprint")).toBeDefined();
    cleanup();
  });
});
