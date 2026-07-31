// EFB-31: the Done column is windowed in kanban-mode, and the chip lifts it.
//
// Separate file from boardFilterWiring.test.tsx for the same reason that one
// is separate from components.test.tsx — parallel dispatches are in flight
// against both, and these need none of their fixtures.
//
// The window itself already shipped (KanbanView.inColumn); what was missing was
// any coverage of it, and any way to lift it. These tests pin both.

import { describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import type { Board, Issue } from "../../lib/types";
import type { Column } from "../../lib/columns";
import type { DndHandle } from "../../lib/dnd";
import type { BoardStore } from "./store";
import { KanbanView } from "./KanbanView";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 14;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;

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

const base: Issue = {
  id: "i0",
  short_id: "KB-0",
  board_id: "b1",
  title: "base",
  body: null,
  body_format: "markdown",
  type: "task",
  status: "Todo",
  column_id: "c1",
  container: "active",
  assignee_pubkey: null,
  priority: null,
  estimate: null,
  labels: [],
  github_links: [],
  sprint_id: null,
  created_at_ms: 1,
  updated_at_ms: 1,
  completed_at_ms: null,
};

/** A card sitting in Done, completed `daysAgo` days back. */
const done = (id: string, title: string, daysAgo: number, over: Partial<Issue> = {}): Issue => ({
  ...base,
  id,
  short_id: `KB-${id}`,
  title,
  status: "Done",
  column_id: "c2",
  completed_at_ms: Date.now() - daysAgo * DAY_MS,
  ...over,
});

const todo = (id: string, title: string, over: Partial<Issue> = {}): Issue => ({
  ...base,
  id,
  short_id: `KB-${id}`,
  title,
  ...over,
});

const clickDnd: DndHandle = {
  draggingId: () => null,
  overZone: () => null,
  pos: () => ({ x: 0, y: 0 }),
  startDrag: (_e, _id, onClick) => onClick(),
};

const stub = (issues: Issue[]) =>
  ({
    board: () => board,
    issues: () => issues,
    sprints: () => [],
    members: () => [],
    refetchIssues: async () => undefined,
    refreshStreams: async () => undefined,
    streamFor: () => ({
      key: "stub",
      loadNext: async () => undefined,
      hasMore: () => false,
      loading: () => false,
      started: () => true,
      reset: () => undefined,
    }),
  }) as unknown as BoardStore;

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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const titles = (root: Element) =>
  [...root.querySelectorAll(".issue-card .title")].map((el) => el.textContent);

const issues = [
  todo("1", "Still going"),
  done("2", "Finished yesterday", 1),
  done("3", "Finished last week", 6),
  done("4", "Finished last month", 40),
  done("5", "Finished last quarter", 95),
];

describe("Done window in kanban-mode", () => {
  it("hides done cards older than the window", async () => {
    const { container, cleanup } = mount(() => (
      <KanbanView
        store={stub(issues)}
        dnd={clickDnd}
        onOpen={() => undefined}
        layout="columns"
        filterSprintId={null}
        doneWindowMs={WINDOW_MS}
      />
    ));
    await flush();
    const shown = titles(container);
    expect(shown).toContain("Finished yesterday");
    expect(shown).toContain("Finished last week");
    expect(shown).not.toContain("Finished last month");
    expect(shown).not.toContain("Finished last quarter");
    cleanup();
  });

  // Non-done columns are never windowed — an in-progress card has no
  // completed_at_ms and must not be filtered out for lacking one.
  it("leaves other columns untouched", async () => {
    const { container, cleanup } = mount(() => (
      <KanbanView
        store={stub(issues)}
        dnd={clickDnd}
        onOpen={() => undefined}
        layout="columns"
        filterSprintId={null}
        doneWindowMs={WINDOW_MS}
      />
    ));
    await flush();
    expect(titles(container)).toContain("Still going");
    cleanup();
  });

  // The lift: BoardPage passes null for doneWindowMs when the chip is on.
  it("shows every done card when the window is lifted", async () => {
    const { container, cleanup } = mount(() => (
      <KanbanView
        store={stub(issues)}
        dnd={clickDnd}
        onOpen={() => undefined}
        layout="columns"
        filterSprintId={null}
        doneWindowMs={null}
      />
    ));
    await flush();
    const shown = titles(container);
    expect(shown).toContain("Finished last month");
    expect(shown).toContain("Finished last quarter");
    cleanup();
  });

  // A done card that predates completed_at_ms tracking has no timestamp. It
  // reads as infinitely old and windows out — the alternative, treating it as
  // fresh, would pin ancient cards to the top of Done forever.
  it("windows out a done card with no completion timestamp", async () => {
    const orphan = [done("6", "No timestamp", 0, { completed_at_ms: null })];
    const { container, cleanup } = mount(() => (
      <KanbanView
        store={stub(orphan)}
        dnd={clickDnd}
        onOpen={() => undefined}
        layout="columns"
        filterSprintId={null}
        doneWindowMs={WINDOW_MS}
      />
    ));
    await flush();
    expect(titles(container)).not.toContain("No timestamp");
    cleanup();
  });
});

describe("Done window does not apply in sprint-mode", () => {
  // The no-regression case from the brief. When a sprint filter is narrowing
  // the deck, the sprint governs Done — applying the board window on top would
  // double-filter and empty the column on sprint boards.
  it("ignores the window while a sprint filter is active", async () => {
    const sprintIssues = [
      done("7", "Old but in sprint", 40, { sprint_id: "s1" }),
      done("8", "Recent in sprint", 1, { sprint_id: "s1" }),
      done("9", "Old, other sprint", 40, { sprint_id: "s2" }),
    ];
    const { container, cleanup } = mount(() => (
      <KanbanView
        store={stub(sprintIssues)}
        dnd={clickDnd}
        onOpen={() => undefined}
        layout="columns"
        filterSprintId="s1"
        doneWindowMs={WINDOW_MS}
      />
    ));
    await flush();
    const shown = titles(container);
    expect(shown).toContain("Old but in sprint");
    expect(shown).toContain("Recent in sprint");
    expect(shown).not.toContain("Old, other sprint");
    cleanup();
  });
});
