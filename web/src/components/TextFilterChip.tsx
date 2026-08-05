// EFB-112 — text-filter chip. Click opens a text input in a portaled popover.
// The query grammar (title:/body:/type:/short_id, -negation, "quoted phrase")
// lives in lib/textFilterQuery; this component owns only the input UX.

import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

const DEBOUNCE_MS = 100;

export const TextFilterChip = (props: {
  /** Current committed value — parent owns the persisted state. */
  value: string;
  onChange: (next: string) => void;
}) => {
  const [open, setOpen] = createSignal(false);
  const [draft, setDraft] = createSignal(props.value);
  const [anchor, setAnchor] = createSignal<{ left: number; top: number } | null>(null);
  let root: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  let debounce: number | null = null;

  const openMenu = () => {
    if (trigger) {
      const r = trigger.getBoundingClientRect();
      setAnchor({ left: r.left, top: r.bottom + 6 });
    }
    setDraft(props.value);
    setOpen(true);
    // Focus after the portaled node mounts.
    queueMicrotask(() => input?.focus());
  };

  const commit = (next: string) => {
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = null;
      props.onChange(next);
    }, DEBOUNCE_MS);
  };

  // If parent state changes underneath us (e.g. filter reset on sign-out),
  // pull the draft along so the input doesn't hold stale text next time.
  createEffect(() => setDraft(props.value));

  const onDocClick = (e: MouseEvent) => {
    if (!open()) return;
    const target = e.target as Node;
    if (root?.contains(target) || popover?.contains(target)) return;
    setOpen(false);
  };
  onMount(() => document.addEventListener("mousedown", onDocClick));
  onCleanup(() => {
    document.removeEventListener("mousedown", onDocClick);
    if (debounce !== null) window.clearTimeout(debounce);
  });

  const active = () => props.value.trim() !== "";
  const chipText = () => (active() ? `Text: ${props.value}` : "Text");

  return (
    <div class="filter-picker" ref={root}>
      <button
        type="button"
        class="filter-chip"
        classList={{ on: active() }}
        aria-haspopup="dialog"
        aria-expanded={open()}
        ref={trigger}
        title={
          active()
            ? "Text filter — click to edit or clear"
            : "Filter by title / body / type / EFB-#. Supports prefixes and quotes."
        }
        onClick={() => (open() ? setOpen(false) : openMenu())}
      >
        {chipText()}
      </button>
      <Show when={open()}>
        <Portal>
          <div
            class="filter-menu text-filter-popover"
            role="dialog"
            aria-label="Text filter"
            ref={popover}
            style={{
              position: "fixed",
              left: `${anchor()?.left ?? 0}px`,
              top: `${anchor()?.top ?? 0}px`,
              "min-width": "22rem",
              padding: "0.7rem",
            }}
          >
            <input
              ref={input}
              type="text"
              class="text-filter-input"
              value={draft()}
              placeholder='title:foo -body:legacy "phrase"'
              onInput={(e) => {
                const v = e.currentTarget.value;
                setDraft(v);
                commit(v);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setOpen(false);
                  return;
                }
                if (e.key === "Enter") {
                  if (debounce !== null) {
                    window.clearTimeout(debounce);
                    debounce = null;
                  }
                  props.onChange(draft());
                  setOpen(false);
                }
              }}
            />
            <div
              class="muted"
              style={{ "font-size": "0.78rem", "margin-top": "0.5rem", "line-height": "1.4" }}
            >
              <div>
                Prefixes: <code>title:</code> <code>body:</code> <code>type:</code>
              </div>
              <div>
                <code>-title:foo</code> negate · <code>"quoted phrase"</code> · bare{" "}
                <code>EFB-115</code>
              </div>
            </div>
            <Show when={active()}>
              <button
                type="button"
                class="filter-menu-clear"
                style={{ "margin-top": "0.5rem" }}
                onClick={() => {
                  if (debounce !== null) {
                    window.clearTimeout(debounce);
                    debounce = null;
                  }
                  setDraft("");
                  props.onChange("");
                  setOpen(false);
                }}
              >
                Clear
              </button>
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  );
};
