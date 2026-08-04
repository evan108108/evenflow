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

import { For, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { SECTIONS, sectionById } from "@docs-content/sections";
import type { Block } from "@docs-content/model";
import { apiRowsByFamily } from "@docs-content/api-reference";
import { TopBar } from "../components/TopBar";
import { CodeBlock } from "../components/CodeBlock";
import "../lib/board.css";

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
          return <p class="docs-p">{b.text}</p>;
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
    <a class="docs-sidebar-item docs-sidebar-llms" href="/docs/llms.txt">
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
