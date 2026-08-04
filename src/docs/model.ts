/**
 * EFB-103: the documentation content model.
 *
 * WHY CONTENT LIVES HERE AND NOT IN THE SPA
 * -----------------------------------------
 * The docs have two audiences that want opposite shapes. A human wants seven
 * navigable pages with a sidebar. An agent wants ONE fetch — no JS, no
 * crawling seven client-rendered routes to learn an API.
 *
 * So the same content is served twice: as pages by the SPA, and as one
 * text/plain document at /docs/llms.txt by the Worker. Authoring it in a
 * structured, dependency-free module that BOTH can import is what stops those
 * two from drifting. The alternative — writing the pages in JSX and hand-
 * maintaining a parallel text dump — guarantees they disagree, and the one
 * that goes stale is the machine-readable one nobody looks at.
 *
 * DEPENDENCY-FREE ON PURPOSE, for the same reason src/apikey-policy.ts is:
 * the web build aliases this file, and esbuild erases a type import while tsc
 * still RESOLVES it. Importing anything Worker-shaped here would drag
 * D1Database and friends into a browser program that has no lib for them.
 * Nothing in this directory may import hono, effect, or the effects module.
 */

/** A run of documentation content. Rendered to HTML by the SPA, to Markdown for agents. */
export type Block =
  | { readonly kind: "p"; readonly text: string }
  | { readonly kind: "h"; readonly text: string }
  | { readonly kind: "code"; readonly lang: string; readonly code: string }
  | { readonly kind: "list"; readonly items: readonly string[] }
  | {
      readonly kind: "table";
      readonly head: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  /**
   * The API reference, rendered from the manifest rather than written out.
   *
   * A marker rather than content: whoever renders decides how to draw 107
   * endpoints. What matters is that neither renderer holds a hand-maintained
   * list — see src/docs/api-reference.ts.
   */
  | { readonly kind: "api-reference" };

export interface DocSection {
  /** URL segment: /docs/<id>. Also the anchor in the single-document form. */
  readonly id: string;
  readonly title: string;
  /** One line, shown under the title and in the index. */
  readonly blurb: string;
  readonly blocks: readonly Block[];
}

/** Escape a cell so a pipe in prose cannot break a Markdown table. */
const cell = (s: string): string => s.replaceAll("|", "\\|");

/**
 * Render blocks to Markdown — the form agents read.
 *
 * Markdown rather than JSON because the consumer is a language model, and
 * prose with fenced code is what it handles best. A JSON dump would be
 * machine-parseable in the narrow sense and worse to actually use.
 */
export const blocksToMarkdown = (
  blocks: readonly Block[],
  renderApiReference: () => string,
): string =>
  blocks
    .map((b) => {
      switch (b.kind) {
        case "p":
          return b.text;
        case "h":
          return `### ${b.text}`;
        case "code":
          return "```" + b.lang + "\n" + b.code + "\n```";
        case "list":
          return b.items.map((i) => `- ${i}`).join("\n");
        case "table":
          return [
            `| ${b.head.map(cell).join(" | ")} |`,
            `| ${b.head.map(() => "---").join(" | ")} |`,
            ...b.rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
          ].join("\n");
        case "api-reference":
          return renderApiReference();
      }
    })
    .join("\n\n");

/** The whole documentation set as one Markdown document. */
export const sectionsToMarkdown = (
  sections: readonly DocSection[],
  renderApiReference: () => string,
): string =>
  [
    "# Evenflow documentation",
    "",
    "The Even Flow of Work — a kanban whose API is a first-class surface.",
    "This document is the COMPLETE documentation set in one file, served at",
    "https://evenflow.work/docs/llms.txt so an agent can read it in a single",
    "request. The same content is at https://evenflow.work/docs as pages.",
    "",
    "Every endpoint below is generated from the server's own route manifest, so",
    "a URL documented here is a URL the server serves.",
    "",
    "## Contents",
    "",
    ...sections.map((s) => `- ${s.title} — ${s.blurb}`),
    "",
    ...sections.flatMap((s) => [
      `## ${s.title}`,
      "",
      s.blurb,
      "",
      blocksToMarkdown(s.blocks, renderApiReference),
      "",
    ]),
  ].join("\n");
