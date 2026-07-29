// The LAZY half of the highlighter: fine-grained Shiki core + exactly our
// sixteen grammars, statically imported HERE so Vite rolls them into one
// async chunk (imported dynamically from highlighter.ts) instead of
// emitting every bundled-shiki grammar — and nothing in this file ever
// reaches the initial bundle.

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import langTs from "@shikijs/langs/typescript";
import langJs from "@shikijs/langs/javascript";
import langTsx from "@shikijs/langs/tsx";
import langJsx from "@shikijs/langs/jsx";
import langPy from "@shikijs/langs/python";
import langRust from "@shikijs/langs/rust";
import langSwift from "@shikijs/langs/swift";
import langGo from "@shikijs/langs/go";
import langShell from "@shikijs/langs/shellscript";
import langJson from "@shikijs/langs/json";
import langYaml from "@shikijs/langs/yaml";
import langSql from "@shikijs/langs/sql";
import langMd from "@shikijs/langs/markdown";
import langCss from "@shikijs/langs/css";
import langHtml from "@shikijs/langs/html";

export type { HighlighterCore };

/** Build the highlighter with our grammar pack + the given inline theme. */
export const makeHighlighter = (theme: object): Promise<HighlighterCore> =>
  createHighlighterCore({
    themes: [theme as never],
    langs: [
      langTs, langJs, langTsx, langJsx, langPy, langRust, langSwift, langGo,
      langShell, langJson, langYaml, langSql, langMd, langCss, langHtml,
    ],
    engine: createJavaScriptRegexEngine(),
  });
