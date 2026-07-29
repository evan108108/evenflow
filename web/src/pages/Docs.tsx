// /docs — the public developer reference (phase 19). No auth, no app
// chrome dependencies: getting started, the REST reference generated from
// docs/rest-spec.ts, the MCP tool reference, and the /evenflow skill.

import { For } from "solid-js";
import { MCP_TOOLS, REST_SECTIONS } from "./docs/rest-spec";
import "../lib/board.css";

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
        <a href="#skill">/evenflow skill</a>
      </nav>
    </header>

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
                    <span class="method" data-method={endpoint.method}>
                      {endpoint.method}
                    </span>
                    <code class="path">{endpoint.path}</code>
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

    <footer class="docs-footer muted">
      <p>The Even Flow of Work.</p>
    </footer>
  </main>
);
