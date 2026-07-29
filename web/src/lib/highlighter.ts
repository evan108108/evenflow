// getHighlighter — memoized, LAZY Shiki singleton.
//
// `import("./shiki-bundle")` runs only when the first ``` fence actually
// renders, so the highlighter (JS regex engine + exactly our sixteen
// grammars, via shiki/core fine-grained imports) lives in one async chunk
// and never touches the initial bundle.
//
// Languages outside LANGS fall back to plain <pre><code> — still readable,
// still copyable (CodeBlock handles that path without loading Shiki).

import type { HighlighterCore } from "shiki/core";

export const LANGS = [
  "ts", "js", "tsx", "jsx", "py", "rust", "swift", "go",
  "sh", "bash", "json", "yaml", "sql", "md", "css", "html",
] as const;

export type HighlightLang = (typeof LANGS)[number];

export const isHighlightLang = (lang: string): lang is HighlightLang =>
  (LANGS as ReadonlyArray<string>).includes(lang);

// Muted editorial theme anchored to Evenflow's palette: ink identifiers,
// soft-ink punctuation, muted teal keywords, muted terracotta strings,
// muted gold numbers, faint-ink italic comments.
export const EVENFLOW_SHIKI_THEME = {
  name: "evenflow-muted",
  colors: {
    "editor.background": "transparent",
    "editor.foreground": "#17233b",
  },
  settings: [
    { settings: { foreground: "#17233b" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#9aa1ad", fontStyle: "italic" },
    },
    {
      scope: ["keyword", "storage.type", "storage.modifier", "keyword.control"],
      settings: { foreground: "#3d7676" },
    },
    {
      scope: ["string", "string.quoted", "punctuation.definition.string"],
      settings: { foreground: "#a4644b" },
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.character"],
      settings: { foreground: "#9c7c3c" },
    },
    {
      scope: ["variable", "entity.name.function", "entity.name.type", "support.type", "support.function"],
      settings: { foreground: "#17233b" },
    },
    {
      scope: ["punctuation", "meta.brace", "keyword.operator"],
      settings: { foreground: "#5c6575" },
    },
  ],
} as const;

let singleton: Promise<HighlighterCore> | null = null;

/** Memoized async Shiki singleton — first call triggers the lazy chunk. */
export const getHighlighter = (): Promise<HighlighterCore> => {
  if (singleton === null) {
    singleton = import("./shiki-bundle").then((bundle) =>
      bundle.makeHighlighter(EVENFLOW_SHIKI_THEME),
    );
  }
  return singleton;
};

/** Highlight `code` as `lang`; caller guarantees lang ∈ LANGS. */
export const highlight = async (code: string, lang: HighlightLang): Promise<string> => {
  const highlighter = await getHighlighter();
  return highlighter.codeToHtml(code, { lang, theme: "evenflow-muted" });
};
