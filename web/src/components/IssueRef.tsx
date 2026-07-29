// The FLOW-42 reference chip — click copies the given text (the ref itself
// on cards, optionally a URL elsewhere) and flashes a tiny "copied" toast.
// Pointer events stop here so a copy click never opens/drags the card.

import { Show, createSignal } from "solid-js";

const TOAST_MS = 1200;

export const IssueRef = (props: {
  shortId: string;
  /** What lands on the clipboard; defaults to the short id itself. */
  copyText?: string;
  class?: string;
}) => {
  const [copied, setCopied] = createSignal(false);

  const copy = (e: Event) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(props.copyText ?? props.shortId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), TOAST_MS);
    });
  };

  return (
    <span class={`issue-ref-wrap ${props.class ?? ""}`}>
      <button
        class="issue-ref serif"
        title="Copy reference"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={copy}
      >
        {props.shortId}
      </button>
      <Show when={copied()}>
        <span class="copied-toast" role="status">
          copied
        </span>
      </Show>
    </span>
  );
};
