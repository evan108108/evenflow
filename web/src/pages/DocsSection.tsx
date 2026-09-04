// /docs/<section> — one documentation section, rendered from the same content
// the Worker serves at /docs/llms.txt.
//
// The content is NOT written here. It lives in src/docs/sections.ts so the
// pages and the single-document form cannot disagree; this file only decides
// what a paragraph, a table and a code block look like. See src/docs/model.ts
// for why that split is load-bearing rather than tidy.
//
// Public: no auth, no fetch, no signed-in state. A signed-out reader — human
// or agent — gets the whole page.

import { For, Show, type JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import { SECTIONS, sectionById } from "@docs-content/sections";
import type { Block } from "@docs-content/model";
import { apiRowsByFamily } from "@docs-content/api-reference";
import { TopBar } from "../components/TopBar";
import { CodeBlock } from "../components/CodeBlock";
import "../lib/board.css";

/**
 * Turn bare http(s) URLs in paragraph text into clickable links. The docs
 * `p` block was originally rendered as plain text, so a paragraph that said
 * "mint one at https://evenflow.work/settings/keys" showed the URL literally
 * and left the reader to copy it — the exact reason /docs/mcp was reported as
 * unclear. Splitting on the URL pattern keeps the surrounding punctuation
 * intact (a trailing "." or ")" stays outside the anchor). Same-origin links
 * open in this tab; anything else opens in a new tab so a docs read doesn't
 * navigate away from the docs.
 */
const URL_RE = /\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;

const linkify = (text: string): JSX.Element => {
  const nodes: JSX.Element[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index;
    if (start > last) nodes.push(text.slice(last, start));
    const href = match[0];
    const sameOrigin = href.startsWith("https://evenflow.work") || href.startsWith("http://localhost");
    nodes.push(
      <a href={href} target={sameOrigin ? undefined : "_blank"} rel={sameOrigin ? undefined : "noreferrer"}>
        {href}
      </a>,
    );
    last = start + href.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length === 0 ? text : nodes;
};

/** The endpoint reference, straight off the manifest — never a curated list. */
const ApiReference = () => (
  <div class="docs-api">
    <For each={apiRowsByFamily()}>
      {(group) => (
        <section class="docs-api-family">
          <h3 id={`api-${group.family}`}>{group.family}</h3>
          <table class="docs-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Auth</th>
                <th>Scope required</th>
              </tr>
            </thead>
            <tbody>
              <For each={group.rows}>
                {(row) => (
                  <tr>
                    <td>
                      <code>{row.method}</code>
                    </td>
                    <td>
                      <code>{row.path}</code>
                      <Show when={row.orgPath !== null}>
                        <br />
                        <code class="muted">{row.orgPath}</code>
                      </Show>
                    </td>
                    <td>{row.auth}</td>
                    <td>{row.scope}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <details class="docs-curls">
            <summary>Runnable examples for {group.family}</summary>
            <For each={group.rows}>
              {(row) => (
                <div class="docs-curl">
                  <p class="muted">
                    <code>
                      {row.method} {row.path}
                    </code>
                  </p>
                  <CodeBlock code={row.curl} lang="bash" />
                </div>
              )}
            </For>
          </details>
        </section>
      )}
    </For>
  </div>
);

const RenderBlock = (props: { block: Block }) => (
  <Show when={props.block} keyed>
    {(b) => {
      switch (b.kind) {
        case "p":
          return <p class="docs-p">{linkify(b.text)}</p>;
        case "h":
          return <h3 class="docs-h">{b.text}</h3>;
        case "code":
          return <CodeBlock code={b.code} lang={b.lang} />;
        case "list":
          return (
            <ul class="docs-list">
              <For each={b.items}>{(i) => <li>{i}</li>}</For>
            </ul>
          );
        case "table":
          return (
            <table class="docs-table">
              <thead>
                <tr>
                  <For each={b.head}>{(h) => <th>{h}</th>}</For>
                </tr>
              </thead>
              <tbody>
                <For each={b.rows}>
                  {(row) => (
                    <tr>
                      <For each={row}>{(cell) => <td>{cell}</td>}</For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          );
        case "api-reference":
          return <ApiReference />;
      }
    }}
  </Show>
);

/** Sidebar shared by every docs page, so a reader can always reach the rest. */
export const DocsNav = (props: { current?: string | undefined }) => (
  <nav class="docs-sidebar" aria-label="Documentation">
    <a class="docs-sidebar-item" href="/docs" classList={{ current: props.current === undefined }}>
      Overview
    </a>
    <For each={SECTIONS}>
      {(s) => (
        <a
          class="docs-sidebar-item"
          href={`/docs/${s.id}`}
          classList={{ current: props.current === s.id }}
        >
          {s.title}
        </a>
      )}
    </For>
    <a class="docs-sidebar-item docs-sidebar-llms" href="/docs/llms.txt" rel="external" target="_blank">
      llms.txt ↓
    </a>
    {/* The way into the product. TopBar's brand points at /boards, which is
        behind auth, so a signed-out reader needs this explicitly. */}
    <a class="docs-sidebar-item docs-sidebar-signin" href="/signin">
      Sign in →
    </a>
  </nav>
);

export const DocsSection = () => {
  const params = useParams();
  const section = () => sectionById(params["section"] ?? "");

  // Belt-and-suspenders for the llms.txt link: solidjs-router intercepts
  // internal <a href> clicks by default, and a click on the sidebar's
  // llms.txt link used to land here with section="llms.txt" (no such
  // section → "No such page"), even though the Worker serves the text at
  // that exact URL. The anchor now sets rel="external" target="_blank",
  // but any residual same-tab navigation lands here — hard-redirect the
  // browser to the Worker path so the reader sees the file, not this
  // fallback. Same handling for any future .txt drop-in.
  const raw = () => params["section"] ?? "";
  if (typeof window !== "undefined" && raw().endsWith(".txt")) {
    window.location.replace(`/docs/${raw()}`);
  }

  return (
    <main class="docs-main">
      <TopBar home="/" crumbs={[{ label: "Docs", href: "/docs" }, { label: section()?.title ?? "Not found" }]} />
      <div class="docs-shell">
        <DocsNav current={section()?.id} />
        <article class="docs-body">
          <Show
            when={section()}
            fallback={
              <>
                <h1>No such page</h1>
                <p class="docs-p">
                  That documentation page does not exist. <a href="/docs">Start at the overview</a>.
                </p>
              </>
            }
          >
            {(s) => (
              <>
                <h1>{s().title}</h1>
                <p class="muted docs-blurb">{s().blurb}</p>
                <For each={s().blocks}>{(block) => <RenderBlock block={block} />}</For>
              </>
            )}
          </Show>
        </article>
      </div>
    </main>
  );
};
