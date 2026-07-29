// Component shell tests: card click opens, modal submit shape, sheet close.

import { describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { Board, Issue } from "../lib/types";
import { ISSUE_TYPES, type Column } from "../lib/columns";
import type { DndHandle } from "../lib/dnd";
import type { BoardStore } from "../pages/board/store";
import { IssueCard } from "./IssueCard";
import { IssueSheet } from "./IssueSheet";
import { IssueTypeIcon } from "./IssueTypeIcon";
import { NewBoardModal } from "./NewBoardModal";
import { NewIssueModal } from "./NewIssueModal";

const col = (id: string, name: string, order: number, category: Column["category"], enabled = true): Column => ({
  id,
  name,
  order,
  enabled,
  category,
});

const board: Board = {
  id: "b1",
  pubkey: "test:0",
  slug: "kb",
  title: "Board",
  description: null,
  columns: [
    col("c1", "Backlog", 0, "todo"),
    col("c2", "In Progress", 1, "in_progress"),
    col("c3", "Done", 2, "done"),
    col("c4", "Hidden", 3, "blocked", false),
  ],
  labels: [],
  member_policy: "invite",
  is_encrypted: false,
  issue_prefix: "KB",
  next_issue_number: 8,
  created_at_ms: 1,
  updated_at_ms: 1,
};

const issue: Issue = {
  id: "i1",
  short_id: "KB-7",
  board_id: "b1",
  title: "An issue",
  body: null,
  body_format: "markdown",
  type: "task",
  status: "Backlog",
  column_id: "c1",
  container: "active",
  assignee_pubkey: null,
  priority: 2,
  estimate: 5,
  labels: ["infra"],
  github_links: [],
  created_at_ms: 1,
  updated_at_ms: 1,
  completed_at_ms: null,
};

/** dnd stub whose press immediately resolves as a click. */
const clickDnd: DndHandle = {
  draggingId: () => null,
  overZone: () => null,
  pos: () => ({ x: 0, y: 0 }),
  startDrag: (_e, _id, onClick) => onClick(),
};

const storeStub = {
  fetchComments: async () => [],
  fetchIssueActivity: async () => [],
  fetchAttachments: async () => [],
  uploadAttachment: async () => ({ attachment: null, rejection: null }),
  setAttachmentCover: async () => ({}),
  deleteAttachment: async () => ({ deleted: true }),
  refetchIssues: async () => undefined,
  transition: async () => undefined,
  moveContainer: async () => undefined,
  patchIssue: async () => null,
  postComment: async () => ({}),
  deleteComment: async () => ({ deleted: true }),
} as unknown as BoardStore;

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

describe("IssueTypeIcon", () => {
  it("renders a distinct mark for each of the six types", () => {
    for (const type of ISSUE_TYPES) {
      const { container, cleanup } = mount(() => <IssueTypeIcon type={type} />);
      const svg = container.querySelector("svg.issue-type-icon")!;
      expect(svg.getAttribute("data-type")).toBe(type);
      expect(svg.getAttribute("width")).toBe("14");
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.getAttribute("fill")).toBe("none");
      expect(svg.children.length).toBeGreaterThan(0);
      cleanup();
    }
  });

  it("honors the size prop", () => {
    const { container, cleanup } = mount(() => <IssueTypeIcon type="bug" size={18} />);
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("18");
    cleanup();
  });
});

describe("IssueCard", () => {
  it("renders chips + the short ref and opens on a click-shaped press", () => {
    const onOpen = vi.fn();
    const { container, cleanup } = mount(() => (
      <IssueCard issue={issue} dnd={clickDnd} onOpen={onOpen} />
    ));
    expect(container.textContent).toContain("An issue");
    expect(container.textContent).toContain("P2");
    expect(container.textContent).toContain("5");
    expect(container.textContent).toContain("infra");
    expect(container.querySelector(".issue-ref")!.textContent).toBe("KB-7");
    container
      .querySelector(".issue-card")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith("KB-7");
    cleanup();
  });

  it("shows the type icon to the left of the ref, with a hover label", () => {
    const bugIssue: Issue = { ...issue, type: "feature" };
    const { container, cleanup } = mount(() => (
      <IssueCard issue={bugIssue} dnd={clickDnd} onOpen={vi.fn()} />
    ));
    const row = container.querySelector(".card-ref-row")!;
    const badge = row.querySelector(".type-badge")!;
    expect(badge.getAttribute("title")).toBe("Type: Feature");
    expect(badge.querySelector("svg")!.getAttribute("data-type")).toBe("feature");
    // Badge precedes the short-id ref inside the row.
    expect(row.firstElementChild).toBe(badge);
    expect(row.querySelector(".issue-ref")!.textContent).toBe("KB-7");
    cleanup();
  });

  it("falls back to the UUID for issues awaiting backfill", () => {
    const onOpen = vi.fn();
    const legacy: Issue = { ...issue, short_id: null };
    const { container, cleanup } = mount(() => (
      <IssueCard issue={legacy} dnd={clickDnd} onOpen={onOpen} />
    ));
    expect(container.querySelector(".issue-ref")).toBeNull();
    container
      .querySelector(".issue-card")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(onOpen).toHaveBeenCalledWith("i1");
    cleanup();
  });
});

describe("NewBoardModal", () => {
  it("live-previews the derived prefix and submits it", async () => {
    const onCreate = vi.fn(async () => ({ slug: "evan-s-flow", issue_prefix: "EF" }));
    const onDone = vi.fn();
    const { container, cleanup } = mount(() => (
      <NewBoardModal onClose={() => undefined} onCreate={onCreate} onDone={onDone} />
    ));

    const title = container.querySelector<HTMLInputElement>("#nb-title")!;
    title.value = "Evan's Flow";
    title.dispatchEvent(new Event("input", { bubbles: true }));

    expect(container.querySelector<HTMLInputElement>("#nb-prefix")!.value).toBe("EF");
    expect(container.querySelector(".prefix-preview")!.textContent).toContain("EF-1");

    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(onCreate).toHaveBeenCalledWith({
      slug: "evan-s-flow",
      title: "Evan's Flow",
      issue_prefix: "EF",
    });
    expect(onDone).toHaveBeenCalledWith({ slug: "evan-s-flow", issue_prefix: "EF" });
    cleanup();
  });

  it("shows the finalized prefix when the server auto-suffixed", async () => {
    const onCreate = vi.fn(async () => ({ slug: "flow2", issue_prefix: "EF2" }));
    const onDone = vi.fn();
    const { container, cleanup } = mount(() => (
      <NewBoardModal onClose={() => undefined} onCreate={onCreate} onDone={onDone} />
    ));

    const title = container.querySelector<HTMLInputElement>("#nb-title")!;
    title.value = "Evan's Flow";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(onDone).not.toHaveBeenCalled();
    expect(container.textContent).toContain("EF2-1");
    container.querySelector<HTMLButtonElement>(".btn-solid")!.click();
    expect(onDone).toHaveBeenCalledWith({ slug: "flow2", issue_prefix: "EF2" });
    cleanup();
  });
});

describe("NewIssueModal", () => {
  it("submits the typed fields as the create payload", async () => {
    const onCreate = vi.fn(async () => undefined);
    const { container, cleanup } = mount(() => (
      <NewIssueModal board={board} onClose={() => undefined} onCreate={onCreate} />
    ));

    const title = container.querySelector<HTMLInputElement>("#ni-title")!;
    title.value = "Ship the butterflies";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    const estimate = container.querySelector<HTMLSelectElement>("#ni-estimate")!;
    estimate.value = "8";
    estimate.dispatchEvent(new Event("input", { bubbles: true }));
    const labels = container.querySelector<HTMLInputElement>("#ni-labels")!;
    labels.value = "polish, joy";
    labels.dispatchEvent(new Event("input", { bubbles: true }));

    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(onCreate).toHaveBeenCalledWith({
      title: "Ship the butterflies",
      type: "task",
      status: "Backlog",
      container: "backlog",
      estimate: 8,
      labels: ["polish", "joy"],
    });
    cleanup();
  });

  it("offers all six types between Title and Body, defaulting to task", async () => {
    const onCreate = vi.fn(async () => undefined);
    const { container, cleanup } = mount(() => (
      <NewIssueModal board={board} onClose={() => undefined} onCreate={onCreate} />
    ));

    const type = container.querySelector<HTMLSelectElement>("#ni-type")!;
    expect(type.value).toBe("task");
    expect([...type.options].map((o) => o.value)).toEqual([...ISSUE_TYPES]);
    // DOM order: the Type control sits between Title and Body.
    const ids = [...container.querySelectorAll("input, select, textarea")].map((el) => el.id);
    expect(ids.indexOf("ni-type")).toBeGreaterThan(ids.indexOf("ni-title"));
    expect(ids.indexOf("ni-type")).toBeLessThan(ids.indexOf("ni-body"));

    type.value = "bug";
    type.dispatchEvent(new Event("input", { bubbles: true }));
    const title = container.querySelector<HTMLInputElement>("#ni-title")!;
    title.value = "Squash it";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ type: "bug" }));
    cleanup();
  });

  it("only offers enabled columns as statuses", () => {
    const { container, cleanup } = mount(() => (
      <NewIssueModal board={board} onClose={() => undefined} onCreate={vi.fn(async () => undefined)} />
    ));
    const status = container.querySelector<HTMLSelectElement>("#ni-status")!;
    expect([...status.options].map((o) => o.value)).toEqual(["Backlog", "In Progress", "Done"]);
    cleanup();
  });

  it("does not submit without a title", async () => {
    const onCreate = vi.fn(async () => undefined);
    const { container, cleanup } = mount(() => (
      <NewIssueModal board={board} onClose={() => undefined} onCreate={onCreate} />
    ));
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(onCreate).not.toHaveBeenCalled();
    cleanup();
  });
});

describe("IssueSheet", () => {
  it("renders the issue and closes via the X and the overlay", async () => {
    const onClose = vi.fn();
    const { container, cleanup } = mount(() => (
      <IssueSheet
        issue={issue}
        board={board}
        store={storeStub}
        callerPubkey={"test:0"}
        commentsVersion={() => 0}
        onClose={onClose}
      />
    ));
    await flush();
    expect(container.querySelector<HTMLInputElement>(".title-input")!.value).toBe("An issue");
    expect(container.textContent).toContain("Quiet so far.");
    container.querySelector<HTMLButtonElement>(".close")!.click();
    container.querySelector<HTMLElement>(".sheet-overlay")!.click();
    expect(onClose).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("has a Type row that patches through the store", async () => {
    const patchIssue = vi.fn(async () => null);
    const store = { ...storeStub, patchIssue } as unknown as BoardStore;
    const { container, cleanup } = mount(() => (
      <IssueSheet
        issue={issue}
        board={board}
        store={store}
        callerPubkey={"test:0"}
        commentsVersion={() => 0}
        onClose={() => undefined}
      />
    ));
    await flush();
    const row = [...container.querySelectorAll(".sheet-row")].find((r) =>
      r.textContent!.includes("Type"),
    )!;
    expect(row.querySelector("svg.issue-type-icon")).not.toBeNull();
    const select = row.querySelector("select")!;
    expect(select.value).toBe("task");
    select.value = "improvement";
    select.dispatchEvent(new Event("input", { bubbles: true }));
    expect(patchIssue).toHaveBeenCalledWith("i1", { type: "improvement" });
    cleanup();
  });

  it("status dropdown transitions by column, listing enabled columns only", async () => {
    const transition = vi.fn(async () => undefined);
    const store = { ...storeStub, transition } as unknown as BoardStore;
    const { container, cleanup } = mount(() => (
      <IssueSheet
        issue={issue}
        board={board}
        store={store}
        callerPubkey={"test:0"}
        commentsVersion={() => 0}
        onClose={() => undefined}
      />
    ));
    await flush();
    const row = [...container.querySelectorAll(".sheet-row")].find((r) =>
      r.textContent!.includes("Status"),
    )!;
    const select = row.querySelector("select")!;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Backlog",
      "In Progress",
      "Done",
    ]);
    select.value = "c3";
    select.dispatchEvent(new Event("input", { bubbles: true }));
    expect(transition).toHaveBeenCalledWith(issue, board.columns[2]);
    cleanup();
  });
});
