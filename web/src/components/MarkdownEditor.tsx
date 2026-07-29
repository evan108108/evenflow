// MarkdownEditor — Write | Preview tabs over a toolbar'd textarea.
//
// The toolbar inserts/wraps GFM syntax at the cursor: selection-aware for
// the wrapping marks (**bold**, *italic*, `code`, [link](url)), line-start
// for the list marks (- item, - [ ] task). Preview renders through the
// same MarkdownView the read-only body uses, so what you preview is what
// ships.

import { For, Show, createSignal } from "solid-js";
import { MarkdownView } from "./MarkdownView";

interface ToolbarAction {
  readonly key: string;
  readonly label: string;
  readonly title: string;
  /** Wrap the selection (before/after) or prefix each selected line. */
  readonly apply:
    | { readonly wrap: readonly [string, string]; readonly placeholder: string }
    | { readonly linePrefix: string };
}

const TOOLBAR: ReadonlyArray<ToolbarAction> = [
  { key: "bold", label: "B", title: "Bold", apply: { wrap: ["**", "**"], placeholder: "bold" } },
  { key: "italic", label: "I", title: "Italic", apply: { wrap: ["*", "*"], placeholder: "italic" } },
  { key: "link", label: "link", title: "Link", apply: { wrap: ["[", "](url)"], placeholder: "text" } },
  { key: "code", label: "code", title: "Inline code", apply: { wrap: ["`", "`"], placeholder: "code" } },
  { key: "ul", label: "ul", title: "Bulleted list", apply: { linePrefix: "- " } },
  { key: "task", label: "task", title: "Task list", apply: { linePrefix: "- [ ] " } },
];

export const MarkdownEditor = (props: {
  value: string;
  onInput: (next: string) => void;
}) => {
  const [tab, setTab] = createSignal<"write" | "preview">("write");
  let textarea: HTMLTextAreaElement | undefined;

  const applyAction = (action: ToolbarAction) => {
    const el = textarea;
    if (el === undefined) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const value = props.value;
    let next: string;
    let cursor: number;
    if ("wrap" in action.apply) {
      const [before, after] = action.apply.wrap;
      const selected = value.slice(start, end) || action.apply.placeholder;
      next = value.slice(0, start) + before + selected + after + value.slice(end);
      cursor = start + before.length + selected.length;
    } else {
      const prefix = action.apply.linePrefix;
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const block = value.slice(lineStart, end);
      const prefixed = block === "" ? prefix : block.split("\n").map((l) => prefix + l).join("\n");
      next = value.slice(0, lineStart) + prefixed + value.slice(end);
      cursor = lineStart + prefixed.length;
    }
    props.onInput(next);
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <div class="markdown-editor">
      <div class="editor-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          classList={{ active: tab() === "write" }}
          onClick={() => setTab("write")}
        >
          Write
        </button>
        <button
          type="button"
          role="tab"
          classList={{ active: tab() === "preview" }}
          onClick={() => setTab("preview")}
        >
          Preview
        </button>
      </div>

      <Show
        when={tab() === "write"}
        fallback={
          <div class="editor-preview">
            <MarkdownView source={props.value} format="markdown" />
          </div>
        }
      >
        <div class="editor-toolbar">
          <For each={TOOLBAR}>
            {(action) => (
              <button
                type="button"
                data-action={action.key}
                title={action.title}
                onClick={() => applyAction(action)}
              >
                {action.label}
              </button>
            )}
          </For>
        </div>
        <textarea
          ref={textarea}
          class="editor-textarea"
          spellcheck={true}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
        />
      </Show>
    </div>
  );
};
