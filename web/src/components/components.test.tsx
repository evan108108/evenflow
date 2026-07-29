// Component shell tests: card click opens, modal submit shape, sheet close.

import { describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { Board, Issue } from "../lib/types";
import type { DndHandle } from "../lib/dnd";
import type { BoardStore } from "../pages/board/store";
import { IssueCard } from "./IssueCard";
import { IssueSheet } from "./IssueSheet";
import { NewBoardModal } from "./NewBoardModal";
import { NewIssueModal } from "./NewIssueModal";

const board: Board = {
  id: "b1",
  pubkey: "test:0",
  slug: "kb",
  title: "Board",
  description: null,
  columns: ["Backlog", "In Progress", "Done"],
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
  status: "Backlog",
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
      status: "Backlog",
      container: "backlog",
      estimate: 8,
      labels: ["polish", "joy"],
    });
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
});
