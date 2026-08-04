// /docs — the public developer reference (phase 19). No auth, no app
// chrome dependencies: getting started, the REST reference generated from
// docs/rest-spec.ts, the MCP tool reference, and the /evenflow skill.

import { For } from "solid-js";
import { SECTIONS } from "@docs-content/sections";
import { methodOf, pathOf, MCP_TOOLS, REST_SECTIONS } from "./docs/rest-spec";
import { IMPORT_PROMPTS, IMPORT_PROMPT_PREAMBLE } from "./docs/import-prompts";
import { CANONICAL_COLUMNS } from "../../../src/lib/csv-canonical";
import "../lib/board.css";

/**
 * Rendered from the schema's own column list rather than typed out, so the
 * header shown to users cannot drift from the one the endpoint accepts.
 */
const CANONICAL_HEADER = CANONICAL_COLUMNS.join(",");

const CURL_FIRST = `# 1. Mint a key at https://evenflow.work/settings/keys, then:
curl https://evenflow.work/api/v0/boards \\
  -H "Authorization: Bearer evk_your_key_here"`;

const MCP_CONNECT = `{
  "mcpServers": {
    "evenflow": {
      "type": "http",
      "url": "https://evenflow.work/mcp",
      "headers": { "Authorization": "Bearer evk_your_key_here" }
    }
  }
}`;

const MCP_CALL = `curl -X POST https://evenflow.work/mcp \\
  -H "Authorization: Bearer evk_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"kanban_issue_list",
                 "arguments":{"board_slug":"flow","container":"active"}}}'`;

export const Docs = () => (
  <main class="docs-page">
    <header class="docs-header">
      <a class="docs-wordmark" href="/">
        Evenflow
      </a>
      <h1>Developer docs</h1>
      <p class="muted">
        One REST API, one MCP endpoint, one slash command — all riding the same auth.
      </p>
      <nav class="docs-nav">
        <a href="#getting-started">Getting started</a>
        <a href="#rest">REST reference</a>
        <a href="#mcp">MCP</a>
        <a href="#import">Import</a>
        <a href="#skill">/evenflow skill</a>
        <a href="#attachment-privacy">Attachment storage</a>
      </nav>
    </header>

    {/* EFB-103 — the full documentation set. This page keeps the original
        developer reference below; these are the sections written for people
        (and agents) who arrive knowing nothing about Evenflow. */}
    <section class="docs-section docs-index">
      <h2>Documentation</h2>
      <ul class="docs-index-list">
        <For each={SECTIONS}>
          {(section) => (
            <li>
              <a href={`/docs/${section.id}`}>{section.title}</a>
              <span class="muted"> — {section.blurb}</span>
            </li>
          )}
        </For>
      </ul>
      <p class="muted">
        Reading this as an agent? The whole set is one text/plain document at{" "}
        <a href="/docs/llms.txt">/docs/llms.txt</a> — one request, no JavaScript.
      </p>
    </section>

    <section id="getting-started" class="docs-section">
      <h2>Getting started</h2>
      <p>
        Base URL: <code>https://evenflow.work/api/v0</code>. Authenticate every request with{" "}
        <code>Authorization: Bearer &lt;token&gt;</code>, where the token is either your session
        JWT or — better, for anything scripted — an API key minted at{" "}
        <a href="/settings/keys">/settings/keys</a>. Keys start with <code>evk_</code>, act as
        you, and can be revoked at any time. The plaintext is shown once at mint; Evenflow keeps
        only a hash.
      </p>
      <pre class="docs-code">{CURL_FIRST}</pre>
      <p class="muted">
        Reads on public boards work without any token. Errors are JSON:{" "}
        <code>{"{ error, reason }"}</code> — and upload rejections carry actionable{" "}
        <code>{"{ code, message, link }"}</code> copy.
      </p>
    </section>

    <section id="rest" class="docs-section">
      <h2>REST reference</h2>
      <For each={REST_SECTIONS}>
        {(section) => (
          <div class="docs-group">
            <h3>{section.title}</h3>
            <For each={section.endpoints}>
              {(endpoint) => (
                <article class="docs-endpoint">
                  <div class="endpoint-line">
                    <span class="method" data-method={methodOf(endpoint)}>
                      {methodOf(endpoint)}
                    </span>
                    <code class="path">{pathOf(endpoint)}</code>
                  </div>
                  <p>{endpoint.summary}</p>
                  <For each={endpoint.params ?? []}>
                    {(param) => (
                      <p class="docs-param">
                        <code>{param.name}</code> — {param.note}
                      </p>
                    )}
                  </For>
                  <p class="docs-param">
                    <span class="muted">returns</span> <code>{endpoint.response}</code>
                  </p>
                  <pre class="docs-code">{endpoint.curl}</pre>
                </article>
              )}
            </For>
          </div>
        )}
      </For>
    </section>

    <section id="mcp" class="docs-section">
      <h2>MCP</h2>
      <p>
        Evenflow speaks MCP (streamable HTTP, JSON-RPC 2.0) at{" "}
        <code>POST https://evenflow.work/mcp</code> — same Bearer auth as REST, so an{" "}
        <code>evk_</code> key is all a client needs. Claude Code / Desktop config:
      </p>
      <pre class="docs-code">{MCP_CONNECT}</pre>
      <p>Or raw JSON-RPC:</p>
      <pre class="docs-code">{MCP_CALL}</pre>
      <div class="docs-group">
        <h3>Tools</h3>
        <For each={MCP_TOOLS}>
          {(tool) => (
            <article class="docs-endpoint">
              <div class="endpoint-line">
                <code class="path">{tool.name}</code>
              </div>
              <p>{tool.summary}</p>
              <p class="docs-param">
                <span class="muted">arguments</span> <code>{tool.args}</code>
              </p>
              <pre class="docs-code">{tool.example}</pre>
            </article>
          )}
        </For>
      </div>
    </section>

    <section id="import" class="docs-section">
      <h2>Importing from another tracker</h2>
      <p>
        Evenflow accepts one CSV shape — its own. There's no Linear importer, no Jira importer,
        no GitHub importer, and there isn't going to be one: that would be a promise to track
        every exporter's column renames and status vocabularies forever, and it still fails for
        whoever arrives from the tracker nobody wrote an adapter for.
      </p>
      <p>
        So the conversion is done by the thing that's already good at it. Export from your
        tracker, hand the file to your AI assistant with the matching prompt below, and paste
        what comes back into <strong>Board settings → Import from CSV</strong>. The header is:
      </p>
      <pre class="docs-code">{CANONICAL_HEADER}</pre>
      <p class="muted">
        <code>labels</code> is semicolon-separated (commas are the field separator).{" "}
        <code>status</code> matches a column name on the destination board.{" "}
        <code>external_url</code> is the original permalink, and it's what makes re-importing the
        same file safe — rows already brought in are skipped rather than duplicated. An assignee
        that isn't a member of the board is dropped and the issue imports unassigned; Evenflow
        never invents a placeholder identity. Full reference:{" "}
        <a href="https://github.com/evan108108/evenflow/blob/main/docs/import-csv.md">
          docs/import-csv.md
        </a>
        .
      </p>

      <div class="docs-grid">
        <For each={IMPORT_PROMPTS}>
          {(prompt) => (
            <article class="docs-endpoint">
              <div class="endpoint-line">
                <code class="path">{prompt.vendor}</code>
              </div>
              <p>{prompt.blurb}</p>
              <pre class="docs-code">{`${IMPORT_PROMPT_PREAMBLE}\n\n${prompt.body}`}</pre>
            </article>
          )}
        </For>
      </div>
    </section>

    <section id="skill" class="docs-section">
      <h2>The /evenflow skill</h2>
      <p>
        Claude Code users can install the <code>/evenflow</code> skill: drop{" "}
        <code>SKILL.md</code> into <code>~/.claude/skills/evenflow/</code> and Claude learns the
        whole vocabulary above — "add a bug to my flow board", "what's active", "move FLOW-42 to
        done" — riding your <code>evk_</code> key through the MCP endpoint. The skill file ships
        in the Evenflow repo at <code>skills/evenflow/SKILL.md</code>.
      </p>
    </section>

    {/*
      EFB-57. The link target of the attachment-privacy notice on the issue
      sheet. Kept in sync with docs/attachment-privacy.md — if the two drift,
      the notice points at a page that no longer says what it promised.
    */}
    <section id="attachment-privacy" class="docs-section">
      <h2>How attachment storage works</h2>
      <p>
        A private board keeps its issues, comments and sprints to its members. It does{" "}
        <strong>not</strong> keep its attachment files private. Anyone who gets a file's link can
        open it — no account, no membership, no expiry.
      </p>
      <div class="docs-group">
        <h3>What membership does cover</h3>
        <p>
          On a private board, membership gates the board itself, its issues, comments and sprints,
          and the list of attachments on an issue — including each file's link. A non-member cannot
          browse your board and collect links.
        </p>
      </div>
      <div class="docs-group">
        <h3>Two ways a file gets out</h3>
        <p>
          <strong>Sharing the link.</strong> Paste an attachment link anywhere outside the board and
          the recipient can open the file. A forwarded link keeps working. This is the common case,
          and what the notice on the upload panel is about.
        </p>
        <p>
          <strong>Confirming a file exists.</strong> Attachment links are content-addressed — the
          address is a SHA-256 hash of the file's own bytes:
        </p>
        <pre class="docs-code">https://blossom.band/&lt;sha256-of-the-file&gt;</pre>
        <p>
          That sounds like "anyone with the same file can fetch yours," but computing the address
          requires the bytes, and someone who has the bytes already has the file. What it actually
          leaks is narrower: whether a given file is stored on the host at all. An existence oracle,
          not a file leak.
        </p>
        <p class="muted">
          Two caveats. A hit means "these bytes are on this host" — the default host is shared with
          other applications, so it doesn't show the upload came from Evenflow. And the oracle gets
          sharper for low-entropy files: if a document's content is guessable, someone can hash
          candidates until one hits, making it confirmation of content too. This matters when the
          fact of the file is itself sensitive.
        </p>
      </div>
      <div class="docs-group">
        <h3>Why it works this way</h3>
        <p>
          Attachments use Blossom (BUD-01/02), a content-addressed protocol. Content-addressing buys
          verifiability (the address is the hash), deduplication, and portability between hosts. The
          cost is that addresses are public and permanent by construction: an address derived from
          content cannot also be a secret, because anyone with the content can derive it. That trade
          is inherent to the model, which is why we document it rather than paper over it.
        </p>
      </div>
      <div class="docs-group">
        <h3>What you can do today</h3>
        <p>
          Don't upload genuinely sensitive files — credentials, contracts under NDA, personal data.
          Use storage that gates on identity for those. Treat an attachment link as the file itself:
          sharing the link is sharing the file, and the address is permanent, so there is no
          un-sharing. Deleting an attachment removes it from the issue and does not guarantee the
          bytes are gone from a host that already served them.
        </p>
        <p>
          Organizations needing different properties can bring their own storage — a custom Blossom
          host or an S3-compatible bucket — in the org's storage settings, which puts the access
          rules under your control. Inline image previews need the object readable without auth, so
          a fully locked-down bucket trades previews for privacy.
        </p>
      </div>
    </section>

    <footer class="docs-footer muted">
      <p>The Even Flow of Work.</p>
    </footer>
  </main>
);
