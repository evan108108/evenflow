// CodeBlock — one fenced code block. Renders plain monospace immediately,
// then (for languages in the Shiki pack) swaps in highlighted HTML once the
// lazy-loaded highlighter resolves. Languages outside the pack simply stay
// on the plain path — readable, copyable, zero Shiki cost. Copy button in
// the corner either way.

import { Show, createSignal, onMount } from "solid-js";
import { highlight, isHighlightLang } from "../lib/highlighter";

const COPIED_FLASH_MS = 1_400;

export const CodeBlock = (props: { code: string; lang: string | null }) => {
  const [highlighted, setHighlighted] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);

  onMount(() => {
    const lang = props.lang;
    if (lang !== null && isHighlightLang(lang)) {
      highlight(props.code, lang)
        .then(setHighlighted)
        .catch(() => undefined); // highlighter failure keeps the plain path
    }
  });

  const copy = () => {
    void navigator.clipboard.writeText(props.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_FLASH_MS);
    });
  };

  return (
    <div class="code-block" data-lang={props.lang ?? "plain"}>
      <button type="button" class="code-copy" onClick={copy}>
        {copied() ? "Copied" : "Copy"}
      </button>
      <Show
        when={highlighted()}
        fallback={
          <pre>
            <code>{props.code}</code>
          </pre>
        }
      >
        {(html) => <div class="shiki-host" innerHTML={html()} />}
      </Show>
    </div>
  );
};
