// The LAZY half of the markdown renderer — micromark + GFM + the unified/
// rehype sanitizer chain, statically imported HERE so Vite rolls the whole
// pipeline into one async chunk (dynamically imported from markdown.ts).
//
// renderMarkdown — GFM source → sanitized HTML string.
//
// Pipeline: micromark (+ GFM extension) renders to HTML with raw HTML
// disallowed, then rehype-parse → rehype-sanitize → rehype-stringify walks
// the output through a STRICT allowlist anyway — defense in depth, so a
// micromark quirk can never smuggle markup into innerHTML.
//
// After sanitization, the [[SHORT-ID]] cross-reference transform rewrites
// [[EFB-42]]-shaped tokens into issue short-links: /i/EFB-42 redirects
// server-side to the canonical /@org/board/issues/EFB-42 URL.

import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

// Strict allowlist: structural + inline markup only. `className` survives
// on code/pre so ```lang fences keep their language-XX class for the
// CodeBlock enhancer; checkboxes keep GFM task-list rendering.
const SCHEMA = {
  ...defaultSchema,
  tagNames: [
    "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "blockquote", "code", "pre",
    "a", "img", "strong", "em", "del",
    "table", "thead", "tbody", "tr", "td", "th",
    "hr", "br", "input", "span",
  ],
  attributes: {
    a: [["href", /^(https?:\/\/|\/|#)/], "title"],
    img: [["src", /^https?:\/\//], "alt", "title"],
    code: [["className", /^language-[\w-]+$/]],
    pre: [["className", /^language-[\w-]+$/]],
    input: [["type", "checkbox"], "checked", "disabled"],
    td: ["align"],
    th: ["align"],
    "*": [],
  },
  protocols: { href: ["http", "https"], src: ["http", "https"] },
} as typeof defaultSchema;

const sanitizer = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeSanitize, SCHEMA)
  .use(rehypeStringify);

export const SHORT_ID_RE = /\[\[([A-Z0-9]{2,5}-\d+)\]\]/g;

/** [[EFB-42]] → issue short-link anchor. Runs on sanitized HTML. */
const linkShortIds = (html: string): string =>
  html.replace(SHORT_ID_RE, (_, shortId: string) =>
    `<a class="issue-ref" href="/i/${shortId}">${shortId}</a>`,
  );

/** Render GFM markdown to sanitized HTML (synchronous). */
export const renderMarkdown = (source: string): string => {
  const raw = micromark(source, {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
    allowDangerousHtml: false,
  });
  const clean = String(sanitizer.processSync(raw));
  return linkShortIds(clean);
};
