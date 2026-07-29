// Markdown facade — the SYNC bits (plain-body rendering, the short-id
// regex) plus a memoized lazy loader for the real renderer. The
// micromark + unified/rehype pipeline weighs real kilobytes, so it lives
// in its own async chunk (markdown-bundle.ts) exactly like Shiki does:
// nothing markdown-shaped ships in the initial bundle.

export type MarkdownRenderer = (source: string) => string;

let renderer: Promise<MarkdownRenderer> | null = null;

/** Memoized async renderer — first call triggers the lazy pipeline chunk. */
export const getMarkdownRenderer = (): Promise<MarkdownRenderer> => {
  if (renderer === null) {
    renderer = import("./markdown-bundle").then((bundle) => bundle.renderMarkdown);
  }
  return renderer;
};

/** Plain-format bodies (pre-18a rows): escaped text, pre-wrap handled by CSS. */
export const renderPlain = (source: string): string => {
  const escaped = source
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<p class="plain-body">${escaped}</p>`;
};
