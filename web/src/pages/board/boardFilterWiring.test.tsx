// EFB-44 wiring tests: the filter predicate actually reaches what the views
// render, in every surface the brief names — Kanban columns, the rail's
// Backlog and Icebox, and the Backlog view.
//
// Deliberately a separate file from components.test.tsx: the polish batch
// (EFB-34/35/37) is in flight against the shared component tests, and these
// need none of that file's fixtures.

import { describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import type { Board, Issue } from "../../lib/types";
import type { Column } from "../../lib/columns";
import type { DndHandle } from "../../lib/dnd";
import type { BoardStore } from "./store";
import { EMPTY_FILTERS, UNASSIGNED, matchesFilters } from "../../lib/boardFilters";
import { FilterPicker } from "../../components/FilterPicker";
import { BacklogView } from "./BacklogView";
import { KanbanView } from "./KanbanView";

const SONA = "nostr:049b628c";
const EVAN = "google:1045090";

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

const mine = (over: Partial<Issue>): Issue => ({ ...base, assignee_pubkey: SONA, ...over });
const theirs = (over: Partial<Issue>): Issue => ({ ...base, assignee_pubkey: EVAN, ...over });

const clickDnd: DndHandle = {
  draggingId: () => null,
  overZone: () => null,
  pos: () => ({ x: 0, y: 0 }),
  startDrag: (_e, _id, onClick) => onClick(),
};

const stub = (issues: Issue[], sprints: unknown[] = []) =>
  ({
    board: () => board,
    issues: () => issues,
    sprints: () => sprints,
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

const titles = (root: Element | Document, selector = ".issue-card .title") =>
  [...root.querySelectorAll(selector)].map((el) => el.textContent);

/** The predicate exactly as BoardPage builds it. */
const mineOnly = (viewer: string | null) => (issue: Issue) =>
  matchesFilters(issue, { ...EMPTY_FILTERS, mineOnly: true }, viewer);

describe("KanbanView columns honour the filter", () => {
  const issues = [
    mine({ id: "i1", short_id: "KB-1", title: "Mine active" }),
    theirs({ id: "i2", short_id: "KB-2", title: "Theirs active" }),
  ];

  it("renders every card when no predicate is supplied", async () => {
    const { container, cleanup } = mount(() => (
      <KanbanView store={stub(issues)} dnd={clickDnd} onOpen={() => undefined} layout="columns" />
    ));
    await flush();
    expect(titles(container).sort()).toEqual(["Mine active", "Theirs active"]);
    cleanup();
  });

  it("drops other people's cards when 'show my tickets' is on", async () => {
    const { container, cleanup } = mount(() => (
      <KanbanView
        store={stub(issues)}
        dnd={clickDnd}
        onOpen={() => undefined}
        layout="columns"
        matchesFilters={mineOnly(SONA)}
      />
    ));
    await flush();
    expect(titles(container)).toEqual(["Mine active"]);
    cleanup();
  });
});

describe("the filter reaches the rail's Backlog and Icebox", () => {
  const issues = [
    mine({ id: "i1", short_id: "KB-1", title: "Mine backlog", container: "backlog" }),
    theirs({ id: "i2", short_id: "KB-2", title: "Theirs backlog", container: "backlog" }),
    mine({ id: "i3", short_id: "KB-3", title: "Mine iced", container: "icebox" }),
    theirs({ id: "i4", short_id: "KB-4", title: "Theirs iced", container: "icebox" }),
  ];

  const railWith = (pred?: (issue: Issue) => boolean) =>
    mount(() => (
      <KanbanView
        store={stub(issues)}
        dnd={clickDnd}
        onOpen={() => undefined}
        layout="vertical"
        wideRail
        matchesFilters={pred}
      />
    ));

  it("filters the backlog rail section", async () => {
    const { container, cleanup } = railWith(mineOnly(SONA));
    await flush();
    const backlog = container.querySelector("[data-dropzone='move:promote_to_backlog']")!;
    expect(titles(backlog)).toEqual(["Mine backlog"]);
    cleanup();
  });

  // The icebox rail starts collapsed, so open it before counting cards.
  it("filters the icebox rail section", async () => {
    const { container, cleanup } = railWith(mineOnly(SONA));
    await flush();
    const icebox = container.querySelector("[data-dropzone='move:send_to_icebox']")!;
    icebox.querySelector<HTMLButtonElement>(".rail-collapse")!.click();
    await flush();
    expect(titles(icebox)).toEqual(["Mine iced"]);
    cleanup();
  });
});

describe("BacklogView honours the filter", () => {
  const issues = [
    mine({ id: "i1", short_id: "KB-1", title: "Mine backlog", container: "backlog" }),
    theirs({ id: "i2", short_id: "KB-2", title: "Theirs backlog", container: "backlog" }),
  ];

  it("renders both without a predicate and one with", async () => {
    const all = mount(() => (
      <BacklogView store={stub(issues)} dnd={clickDnd} onOpen={() => undefined} />
    ));
    await flush();
    expect(titles(all.container).sort()).toEqual(["Mine backlog", "Theirs backlog"]);
    all.cleanup();

    const filtered = mount(() => (
      <BacklogView
        store={stub(issues)}
        dnd={clickDnd}
        onOpen={() => undefined}
        matchesFilters={mineOnly(SONA)}
      />
    ));
    await flush();
    expect(titles(filtered.container)).toEqual(["Mine backlog"]);
    filtered.cleanup();
  });
});

// The brief's explicit requirement: the two mechanisms narrow independently
// and neither stomps the other. Sprint filter is still its own scalar prop.
describe("sprint filter and board filters compose", () => {
  const sprints = [
    {
      id: "s1",
      board_id: "b1",
      name: "Sprint 1",
      goal: null,
      status: "active" as const,
      started_at_ms: 1,
      completed_at_ms: null,
      created_at_ms: 1,
    },
  ];
  const issues = [
    mine({ id: "i1", short_id: "KB-1", title: "Mine in sprint", sprint_id: "s1" }),
    mine({ id: "i2", short_id: "KB-2", title: "Mine off sprint", sprint_id: null }),
    theirs({ id: "i3", short_id: "KB-3", title: "Theirs in sprint", sprint_id: "s1" }),
    theirs({ id: "i4", short_id: "KB-4", title: "Theirs off sprint", sprint_id: null }),
  ];

  const kanban = (over: { sprint?: string | null; pred?: (i: Issue) => boolean }) =>
    mount(() => (
      <KanbanView
        store={stub(issues, sprints)}
        dnd={clickDnd}
        onOpen={() => undefined}
        layout="columns"
        filterSprintId={over.sprint ?? null}
        matchesFilters={over.pred}
      />
    ));

  it("sprint filter alone keeps both owners' sprint cards", async () => {
    const { container, cleanup } = kanban({ sprint: "s1" });
    await flush();
    expect(titles(container).sort()).toEqual(["Mine in sprint", "Theirs in sprint"]);
    cleanup();
  });

  it("board filter alone keeps the viewer's cards on and off the sprint", async () => {
    const { container, cleanup } = kanban({ pred: mineOnly(SONA) });
    await flush();
    expect(titles(container).sort()).toEqual(["Mine in sprint", "Mine off sprint"]);
    cleanup();
  });

  it("together they intersect rather than override", async () => {
    const { container, cleanup } = kanban({ sprint: "s1", pred: mineOnly(SONA) });
    await flush();
    expect(titles(container)).toEqual(["Mine in sprint"]);
    cleanup();
  });
});

describe("FilterPicker", () => {
  const options = [
    { value: UNASSIGNED, label: "Unassigned" },
    { value: SONA, label: "Sona" },
    { value: EVAN, label: "Evan" },
  ];

  const picker = (
    selected: string[],
    onToggle: (value: string) => void = () => undefined,
    onClear: () => void = () => undefined,
  ) =>
    mount(() => (
      <FilterPicker
        label="Assignee"
        options={options}
        selected={selected}
        onToggle={onToggle}
        onClear={onClear}
        emptyLine="Nobody to filter by yet."
      />
    ));

  const openMenu = async (container: HTMLElement) => {
    container.querySelector<HTMLButtonElement>(".filter-chip")!.click();
    await flush();
  };

  it("stays closed until clicked, and closes again on a second click", async () => {
    const { container, cleanup } = picker([]);
    await flush();
    expect(container.querySelector(".filter-menu")).toBeNull();
    await openMenu(container);
    expect(container.querySelector(".filter-menu")).not.toBeNull();
    await openMenu(container);
    expect(container.querySelector(".filter-menu")).toBeNull();
    cleanup();
  });

  // The count carries the state so a long roster can't overflow the header.
  it("shows a count on the chip instead of the picked names", async () => {
    const bare = picker([]);
    await flush();
    expect(bare.container.querySelector(".filter-chip")!.textContent).toBe("Assignee");
    expect(bare.container.querySelector(".filter-chip")!.classList.contains("on")).toBe(false);
    bare.cleanup();

    const two = picker([SONA, EVAN]);
    await flush();
    expect(two.container.querySelector(".filter-chip")!.textContent).toBe("Assignee · 2");
    expect(two.container.querySelector(".filter-chip")!.classList.contains("on")).toBe(true);
    two.cleanup();
  });

  it("reflects the selection as checked boxes and reports toggles", async () => {
    const toggled: string[] = [];
    const { container, cleanup } = picker([SONA], (v: string) => toggled.push(v));
    await flush();
    await openMenu(container);
    const boxes = [...container.querySelectorAll<HTMLInputElement>(".filter-menu-item input")];
    expect(boxes.map((b) => b.checked)).toEqual([false, true, false]);
    boxes[2]!.click();
    await flush();
    expect(toggled).toEqual([EVAN]);
    cleanup();
  });

  it("offers Clear only while something is selected", async () => {
    const bare = picker([]);
    await flush();
    await openMenu(bare.container);
    expect(bare.container.querySelector(".filter-menu-clear")).toBeNull();
    bare.cleanup();

    let cleared = 0;
    const some = picker([SONA], () => undefined, () => {
      cleared += 1;
    });
    await flush();
    await openMenu(some.container);
    some.container.querySelector<HTMLButtonElement>(".filter-menu-clear")!.click();
    await flush();
    expect(cleared).toBe(1);
    some.cleanup();
  });

  it("explains itself when there is nothing to pick from", async () => {
    const { container, cleanup } = mount(() => (
      <FilterPicker
        label="Label"
        options={[]}
        selected={[]}
        onToggle={() => undefined}
        onClear={() => undefined}
        emptyLine="No labels on this board yet."
      />
    ));
    await flush();
    await openMenu(container);
    expect(container.querySelector(".filter-menu-empty")!.textContent).toBe(
      "No labels on this board yet.",
    );
    expect(container.querySelector(".filter-menu-item")).toBeNull();
    cleanup();
  });
});
