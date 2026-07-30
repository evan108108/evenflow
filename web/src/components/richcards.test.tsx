// Phase 18a component tests: MarkdownEditor (tabs + toolbar), CodeBlock
// (lazy highlight swap + plain fallback + copy), IssueCard covers
// (overlay render / compact no-cover path), and AttachmentsPanel
// (editable vs read-only, actionable upload errors).

import { describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import type { Issue } from "../lib/types";
import type { Attachment } from "../lib/attachments";
import type { DndHandle } from "../lib/dnd";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { CodeBlock } from "./CodeBlock";
import { IssueCard } from "./IssueCard";
import { MarkdownEditor } from "./MarkdownEditor";

vi.mock("../lib/highlighter", () => ({
  isHighlightLang: (lang: string) => lang === "ts",
  highlight: vi.fn(async (code: string) => `<pre class="shiki"><code>HL:${code}</code></pre>`),
}));

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

const attachment = (over: Partial<Attachment> = {}): Attachment => ({
  id: "a1",
  issue_id: "i1",
  blob_url: "https://blossom.test/abc",
  sha256: "abc",
  filename: "shot.png",
  content_type: "image/png",
  size_bytes: 2048,
  storage_kind: "blossom_default",
  is_cover: false,
  uploaded_by: "test:0",
  uploaded_at_ms: 1,
  deleted_at_ms: null,
  ...over,
});

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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Retry flush until `pred` holds (bounded) — lazy-loaded chunks (the
 * markdown renderer, the shiki bundle) resolve across a variable number of
 * macrotasks, so any single-flush assertion on their output is a flake.
 */
const waitFor = async (pred: () => boolean, tries = 40) => {
  for (let i = 0; i < tries && !pred(); i++) await flush();
};

describe("MarkdownEditor", () => {
  const editable = () => {
    const [value, setValue] = createSignal("hello");
    const mounted = mount(() => <MarkdownEditor value={value()} onInput={setValue} />);
    return { ...mounted, value, setValue };
  };

  it("switches between Write and Preview, rendering markdown in Preview", async () => {
    const { container, setValue, cleanup } = editable();
    expect(container.querySelector(".editor-textarea")).not.toBeNull();

    setValue("## Acceptance\n- [x] Done\n\nSee [[EFB-1]]");
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs.find((t) => t.textContent === "Preview")!.click();
    // The renderer chunk lazy-loads on first preview — wait for the FULL
    // render (issue-ref anchors hydrate after the base markdown pass), not
    // just the first heading.
    await waitFor(
      () =>
        container.querySelector("h2") !== null &&
        container.querySelector("a.issue-ref") !== null,
    );

    expect(container.querySelector(".editor-textarea")).toBeNull();
    const preview = container.querySelector(".editor-preview")!;
    expect(preview.querySelector("h2")!.textContent).toBe("Acceptance");
    expect(preview.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(preview.querySelector("a.issue-ref")!.getAttribute("href")).toBe("/i/EFB-1");

    tabs.find((t) => t.textContent === "Write")!.click();
    await waitFor(() => container.querySelector(".editor-textarea") !== null);
    expect(container.querySelector(".editor-textarea")).not.toBeNull();
    cleanup();
  });

  it("toolbar wraps the selection in bold marks", async () => {
    const { container, value, cleanup } = editable();
    const textarea = container.querySelector<HTMLTextAreaElement>(".editor-textarea")!;
    textarea.setSelectionRange(0, 5);
    container.querySelector<HTMLButtonElement>('[data-action="bold"]')!.click();
    await flush();
    expect(value()).toBe("**hello**");
    cleanup();
  });

  it("toolbar task action prefixes the current line", async () => {
    const { container, value, cleanup } = editable();
    const textarea = container.querySelector<HTMLTextAreaElement>(".editor-textarea")!;
    textarea.setSelectionRange(5, 5);
    container.querySelector<HTMLButtonElement>('[data-action="task"]')!.click();
    await flush();
    expect(value()).toBe("- [ ] hello");
    cleanup();
  });
});

describe("CodeBlock", () => {
  it("swaps in highlighted HTML for pack languages", async () => {
    const { container, cleanup } = mount(() => <CodeBlock code="const x = 1;" lang="ts" />);
    await waitFor(() => container.querySelector(".shiki-host") !== null);
    expect(container.querySelector(".shiki-host")!.textContent).toBe("HL:const x = 1;");
    cleanup();
  });

  it("keeps the plain fallback for unknown languages", async () => {
    const { container, cleanup } = mount(() => <CodeBlock code="SELECT 1" lang="cobol" />);
    await flush();
    expect(container.querySelector(".shiki-host")).toBeNull();
    expect(container.querySelector("pre code")!.textContent).toBe("SELECT 1");
    cleanup();
  });

  it("copies the raw code", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { container, cleanup } = mount(() => <CodeBlock code="const x = 1;" lang="cobol" />);
    container.querySelector<HTMLButtonElement>(".code-copy")!.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("const x = 1;");
    expect(container.querySelector(".code-copy")!.textContent).toBe("Copied");
    vi.unstubAllGlobals();
    cleanup();
  });
});

describe("IssueCard covers", () => {
  it("renders the cover with the meta overlaid when cover_url is set", () => {
    const covered: Issue = { ...issue, cover_url: "https://blossom.test/cover" };
    const { container, cleanup } = mount(() => (
      <IssueCard issue={covered} dnd={clickDnd} onOpen={vi.fn()} />
    ));
    const card = container.querySelector(".issue-card")!;
    expect(card.classList.contains("has-cover")).toBe(true);
    const img = card.querySelector<HTMLImageElement>(".issue-cover img")!;
    expect(img.getAttribute("src")).toBe("https://blossom.test/cover");
    const overlay = card.querySelector(".cover-overlay")!;
    expect(overlay.querySelector(".title")!.textContent).toBe("An issue");
    expect(overlay.querySelector(".issue-ref")!.textContent).toBe("KB-7");
    expect(overlay.querySelector(".type-badge svg")!.getAttribute("data-type")).toBe("feature");
    cleanup();
  });

  it("stays compact without a cover — no cover container, no overlay", () => {
    const { container, cleanup } = mount(() => (
      <IssueCard issue={issue} dnd={clickDnd} onOpen={vi.fn()} />
    ));
    const card = container.querySelector(".issue-card")!;
    expect(card.classList.contains("has-cover")).toBe(false);
    expect(card.querySelector(".issue-cover")).toBeNull();
    expect(card.querySelector(".title")!.textContent).toBe("An issue");
    cleanup();
  });
});

describe("AttachmentsPanel", () => {
  it("editable mode: star sets cover, delete deletes, upload button present", () => {
    const onSetCover = vi.fn();
    const onDelete = vi.fn();
    const rows = [attachment(), attachment({ id: "a2", filename: "spec.pdf", content_type: "application/pdf" })];
    const { container, cleanup } = mount(() => (
      <AttachmentsPanel
        attachments={rows}
        readOnly={false}
        onUpload={async () => null}
        onSetCover={onSetCover}
        onDelete={onDelete}
      />
    ));
    expect(container.querySelectorAll(".attachment-row")).toHaveLength(2);
    expect(container.querySelector(".attachment-thumb")).not.toBeNull();
    expect(container.querySelector(".file-card")).not.toBeNull();
    // Only the image row offers a star.
    expect(container.querySelectorAll(".attachment-action.star")).toHaveLength(1);

    container.querySelector<HTMLButtonElement>(".attachment-action.star")!.click();
    expect(onSetCover).toHaveBeenCalledWith(rows[0], true);
    container.querySelector<HTMLButtonElement>(".attachment-action.delete")!.click();
    expect(onDelete).toHaveBeenCalledWith(rows[0]);
    expect([...container.querySelectorAll("button")].some((b) => b.textContent!.includes("Attach file"))).toBe(true);
    cleanup();
  });

  it("marks the current cover in the list", () => {
    const { container, cleanup } = mount(() => (
      <AttachmentsPanel
        attachments={[attachment({ is_cover: true })]}
        readOnly={false}
        onUpload={async () => null}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
      />
    ));
    expect(container.querySelector(".attachment-row.cover")).not.toBeNull();
    expect(container.querySelector(".cover-chip")!.textContent).toBe("cover");
    expect(container.querySelector(".attachment-action.star")!.textContent).toBe("★");
    cleanup();
  });

  it("read-only mode (anonymous public board): list only, zero mutation UI", () => {
    const { container, cleanup } = mount(() => (
      <AttachmentsPanel
        attachments={[attachment()]}
        readOnly={true}
        onUpload={async () => null}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
      />
    ));
    expect(container.querySelectorAll(".attachment-row")).toHaveLength(1);
    expect(container.querySelector(".attachment-action")).toBeNull();
    expect([...container.querySelectorAll("button")]).toHaveLength(0);
    cleanup();
  });

  it("surfaces the actionable upload rejection with its settings link", async () => {
    const onUpload = vi.fn(async () => ({
      message: "This file is 6.3MB — Evenflow's default storage caps at 5.0MB per file. Set up your own bucket to upload larger files.",
      link: "/@acme/settings/storage",
    }));
    const { container, cleanup } = mount(() => (
      <AttachmentsPanel
        attachments={[]}
        readOnly={false}
        onUpload={onUpload}
        onSetCover={vi.fn()}
        onDelete={vi.fn()}
      />
    ));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([new Uint8Array(8)], "big.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    await flush();
    const error = container.querySelector(".attachment-error")!;
    expect(error.textContent).toContain("caps at 5.0MB per file");
    expect(error.querySelector("a")!.getAttribute("href")).toBe("/@acme/settings/storage");
    cleanup();
  });
});
