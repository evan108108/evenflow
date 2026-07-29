// MarkdownView — read-only issue body renderer.
//
// format='markdown': the lazily-loaded renderer produces sanitized HTML;
// ``` fences are lifted out of the HTML string and re-rendered through
// <CodeBlock> (which lazy-loads Shiki), everything between them lands via
// innerHTML. While the pipeline chunk is still in flight (first render
// ever), the raw source shows pre-wrapped — a sub-second flash at most.
// format='plain' (pre-18a rows): escaped text in a pre-wrap paragraph —
// exactly the old rendering, no pipeline load at all.

import { For, createResource } from "solid-js";
import type { BodyFormat } from "../lib/attachments";
import { getMarkdownRenderer, renderPlain } from "../lib/markdown";
import { CodeBlock } from "./CodeBlock";

type Segment =
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "code"; readonly code: string; readonly lang: string | null };

const FENCE_RE = /<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g;

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
};

/** Undo the pipeline's entity escaping (rehype-stringify emits numeric hex
 *  entities, micromark named ones). Single pass, so decoded output is
 *  never re-scanned — `&#x26;amp;` decodes to the literal `&amp;`. */
const unescapeHtml = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return NAMED_ENTITIES[entity.toLowerCase()] ?? full;
  });

/** Split sanitized HTML into innerHTML-able runs and CodeBlock segments. */
export const segmentHtml = (html: string): Segment[] => {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of html.matchAll(FENCE_RE)) {
    if (match.index > last) segments.push({ kind: "html", html: html.slice(last, match.index) });
    segments.push({
      kind: "code",
      code: unescapeHtml(match[2] ?? "").replace(/\n$/, ""),
      lang: match[1] ?? null,
    });
    last = match.index + match[0].length;
  }
  if (last < html.length) segments.push({ kind: "html", html: html.slice(last) });
  return segments;
};

export const MarkdownView = (props: { source: string; format: BodyFormat }) => {
  const [segments] = createResource(
    () => [props.source, props.format] as const,
    async ([source, format]): Promise<Segment[]> => {
      if (format === "plain") return [{ kind: "html", html: renderPlain(source) }];
      const render = await getMarkdownRenderer();
      return segmentHtml(render(source));
    },
  );
  return (
    <div class="markdown-body">
      <For
        each={segments() ?? [{ kind: "html", html: renderPlain(props.source) } as Segment]}
      >
        {(segment) =>
          segment.kind === "code" ? (
            <CodeBlock code={segment.code} lang={segment.lang} />
          ) : (
            <div class="markdown-run" innerHTML={segment.html} />
          )
        }
      </For>
    </div>
  );
};
