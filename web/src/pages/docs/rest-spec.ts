// API reference data for /docs.
//
// The PROSE here is hand-written — a summary, what each parameter means, the
// response shape. The METHOD and PATH are not: they resolve through
// src/routes-manifest.ts from a route id, so a documented endpoint cannot
// describe a URL the server does not serve.
//
// EFB-98 made that necessary rather than tidy. Every path in this file was
// stale — it advertised /orgs/:org/boards/:slug and
// /issues/:ref/promote_to_active, one of which had been renamed and the other
// deleted. A docs page is a URL-DISPENSING SURFACE: a reader copies the curl
// and gets a 404, which is the same failure that opened this ticket, pointed
// at a human instead of a script. Deriving the path means it cannot happen
// again without the build breaking.
//
// This is the documented SUBSET, not an exhaustive dump — the manifest is the
// exhaustive list. MCP_TOOLS mirrors src/routes/mcp.ts; keep in lockstep.

export interface RestEndpoint {
  /** Route id in src/routes-manifest.ts. Method and path derive from it. */
  readonly id: RouteId;
  readonly summary: string;
  readonly params?: ReadonlyArray<{ name: string; note: string }>;
  readonly response: string;
  readonly curl: string;
}

export interface RestSection {
  readonly title: string;
  /**
   * Optional setup guidance shown ABOVE the endpoint list — a place for
   * things that are not endpoints but that a caller needs to get right
   * before endpoints matter (e.g. how to configure the third-party side of
   * a webhook). Currently used only by the GitHub section so the docs page
   * and the per-board settings screen (GithubSection.tsx) state the same
   * setup requirements — two copies drift the first time a required event
   * is added and the drift is invisible.
   */
  readonly preamble?: RestSectionPreamble;
  readonly endpoints: ReadonlyArray<RestEndpoint>;
}

export interface RestSectionPreamble {
  readonly heading: string;
  readonly steps: ReadonlyArray<{ readonly label: string; readonly value: string; readonly note?: string }>;
}

import { API_BASE, route, type RouteId } from "@routes-manifest";

const KEY = "evk_your_key_here";
const BASE = `https://evenflow.work${API_BASE}`;

/** The method a documented endpoint uses, straight off the manifest. */
export const methodOf = (e: RestEndpoint) => route(e.id).method;

/** The path a documented endpoint uses, straight off the manifest. */
export const pathOf = (e: RestEndpoint) => route(e.id).path;

export const REST_SECTIONS: ReadonlyArray<RestSection> = [
  {
    title: "Boards",
    endpoints: [
      {
        id: "board.list",
        summary: "Every board you can see, newest-updated first.",
        params: [
          { name: "limit", note: "page size, default 20, max 100" },
          { name: "after", note: "keyset cursor: last board id of the previous page" },
        ],
        response: "{ boards: Board[], total }",
        curl: `curl ${BASE}/boards -H "Authorization: Bearer ${KEY}"`,
      },
      {
        id: "board.get",
        summary: "One board, with your effective role.",
        response: "{ board, org, role }",
        curl: `curl ${BASE}/org/acme/board/flow -H "Authorization: Bearer ${KEY}"`,
      },
      {
        id: "board.create",
        summary: "Create a board. Columns default to Todo / In Progress / In Review / Done.",
        params: [
          { name: "slug", note: "required, [A-Za-z0-9_-]{1,64}" },
          { name: "title", note: "required" },
          { name: "columns", note: "optional Column[] {id,name,order,enabled,category} or string[] of names" },
        ],
        response: "{ board, org }",
        curl: `curl -X POST ${BASE}/org/acme/boards -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"slug":"flow","title":"Flow"}'`,
      },
      {
        id: "board.update",
        summary:
          "Update title/description/columns/visibility. Deleting a column that still has issues needs column_move_map.",
        params: [
          { name: "columns", note: "full Column[] — ≤12, ≥1 enabled, unique ids, contiguous order" },
          { name: "column_move_map", note: "{deleted_column_id: surviving_enabled_column_id}" },
          { name: "visibility", note: "'private' | 'public'" },
        ],
        response: "{ board }",
        curl: `curl -X PATCH ${BASE}/org/acme/board/flow -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"visibility":"public"}'`,
      },
    ],
  },
  {
    title: "Issues",
    endpoints: [
      {
        id: "issue.list",
        summary:
          "Issues on a board, newest-updated first. Filters compose. Unknown query params are rejected — see the note below.",
        params: [
          { name: "status | container | assignee | label", note: "optional filters, combinable" },
          { name: "column_id | sprint_id | q", note: "column stream, sprint, title/body substring" },
          { name: "limit / after", note: "keyset pagination" },
          {
            name: "(anything else)",
            note: '400 {"error":"invalid-query","reason":"<key>-unknown"} — a misspelled or invented param fails loudly instead of being ignored',
          },
        ],
        response: "{ issues: Issue[], total, has_more } — each issue carries cover_url when a cover is set",
        curl: `curl "${BASE}/org/acme/board/flow/issues" -H "Authorization: Bearer ${KEY}"`,
      },
      {
        id: "issue.get",
        summary: "One issue by UUID or short id (FLOW-42). ?include= expands related records.",
        params: [{ name: "include", note: "comma list: comments, attachments" }],
        response: "{ issue, comments?, attachments? }",
        curl: `curl "${BASE}/issue/FLOW-42" -H "Authorization: Bearer ${KEY}"`,
      },
      {
        id: "issue.create",
        summary: "Create an issue. type ∈ task|feature|bug|story|improvement|chore (default task).",
        params: [
          { name: "title", note: "required" },
          { name: "body", note: "GFM markdown" },
          { name: "type / status / container / estimate / priority / labels", note: "optional" },
        ],
        response: "{ issue } — short_id like FLOW-42 is minted here",
        curl: `curl -X POST ${BASE}/org/acme/board/flow/issues -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"title":"Ship it","type":"feature"}'`,
      },
      {
        id: "issue.update",
        summary: "Partial update: title, body, body_format, type, status (by name), assignee, priority, estimate, labels.",
        response: "{ issue }",
        curl: `curl -X PATCH ${BASE}/issue/FLOW-42 -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"type":"bug"}'`,
      },
      {
        id: "issue.transition",
        summary: "Move between columns. column_id (stable across renames) wins over the legacy name form `to`.",
        params: [
          { name: "column_id", note: "preferred — a Column.id from the board" },
          { name: "to", note: "legacy exact column name" },
        ],
        response: "{ issue }",
        curl: `curl -X POST ${BASE}/issue/FLOW-42/transition -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"to":"Done"}'`,
      },
      {
        id: "issue.container.set",
        summary: "Container verbs: promote_to_active, promote_to_backlog, send_to_icebox. Idempotent.",
        response: "{ issue }",
        curl: `curl -X POST ${BASE}/issue/FLOW-42/container -H "Authorization: Bearer ${KEY}"`,
      },
    ],
  },
  {
    title: "Comments",
    endpoints: [
      {
        id: "comment.list",
        summary: "Thread in chronological order, forward keyset pagination.",
        response: "{ comments: Comment[], total, has_more }",
        curl: `curl ${BASE}/issue/FLOW-42/comments -H "Authorization: Bearer ${KEY}"`,
      },
      {
        id: "comment.create",
        summary: "Post a comment; in_reply_to threads under another comment.",
        response: "{ comment }",
        curl: `curl -X POST ${BASE}/issue/FLOW-42/comments -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"body":"On it."}'`,
      },
    ],
  },
  {
    title: "Attachments",
    endpoints: [
      {
        id: "attachment.create",
        summary:
          "Upload (multipart `file` field, or JSON base64). 5MB/file, 20/issue, images+pdf+text+zip+json only.",
        params: [{ name: "file_b64 / filename / content_type", note: "JSON body form" }],
        response: "{ attachment } — or an actionable {code, message, link} rejection",
        curl: `curl -X POST ${BASE}/org/acme/board/flow/issue/FLOW-42/attachments -H "Authorization: Bearer ${KEY}" -F "file=@shot.png"`,
      },
      {
        id: "attachment.update",
        summary: "{is_cover: true} makes an image the card cover (one per issue).",
        response: "{ attachment }",
        curl: `curl -X PATCH ${BASE}/attachment/FLOW-42 -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"is_cover":true}'`,
      },
      {
        id: "attachment.delete",
        summary: "Soft delete — the row hides, the blob stays on Blossom.",
        response: "{ deleted: true }",
        curl: `curl -X DELETE ${BASE}/attachment/FLOW-42 -H "Authorization: Bearer ${KEY}"`,
      },
      {
        id: "attachment.download",
        summary:
          "Pull the bytes. Auth is `viewer` on the attachment's board. Works uniformly across default Blossom and BYO S3 — for BYO S3, the server signs a GET on the org's stored credentials and streams the bytes back with the original Content-Type and a Content-Disposition attachment filename. Do NOT fetch the row's `blob_url` directly on a BYO S3 attachment — that URL is private and needs SigV4 the caller does not have.",
        response: "raw file bytes",
        curl: `curl -OJ ${BASE}/attachment/ATTACHMENT_ID/download -H "Authorization: Bearer ${KEY}"`,
      },
    ],
  },
  {
    title: "API keys",
    endpoints: [
      {
        id: "key.create",
        summary: "Mint a key (JWT session required — keys can't mint keys). Plaintext returns ONCE.",
        params: [{ name: "name", note: "required, ≤60 chars" }],
        response: "{ key, plaintext }",
        curl: `curl -X POST ${BASE}/keys -H "Authorization: Bearer YOUR_JWT" -H "Content-Type: application/json" -d '{"name":"CI"}'`,
      },
      {
        id: "key.list",
        summary: "Your keys — name, display prefix, created/last-used/revoked. Never the secret.",
        response: "{ keys: Key[] }",
        curl: `curl ${BASE}/keys -H "Authorization: Bearer YOUR_JWT"`,
      },
      {
        id: "key.delete",
        summary: "Soft-revoke. Requests with the key 401 immediately after.",
        response: "{ revoked: true }",
        curl: `curl -X DELETE ${BASE}/key/FLOW-42 -H "Authorization: Bearer YOUR_JWT"`,
      },
      {
        id: "key.rotate",
        summary:
          "Replace a key's secret without downtime. Mints a successor (same owner, same name) and returns its plaintext ONCE; the old key keeps working for 24 hours, then 401s for good. No body — the name is inherited so audit rows keep attributing to the same actor. JWT session required, like every mint. 400 if the key is already rotated or revoked.",
        response: "{ key, plaintext }",
        curl: `curl -X POST ${BASE}/key/FLOW-42/rotate -H "Authorization: Bearer YOUR_JWT"`,
      },
    ],
  },
  {
    title: "GitHub integration",
    preamble: {
      heading: "Configuring the webhook in GitHub",
      steps: [
        {
          label: "Payload URL",
          value: `${new URL(BASE).origin}/api/v0/webhooks/github/<board_id>`,
          note: "The exact URL is shown on the board's GitHub settings page after you mint a secret.",
        },
        {
          label: "Content type",
          value: "application/json",
          note: "GitHub's default is x-www-form-urlencoded, which will not work.",
        },
        {
          label: "Events",
          value: "Pull requests, Pull request reviews, Check runs",
          note: "Pick “Let me select individual events” and check exactly those three. Anything else is dropped.",
        },
        {
          label: "Secret",
          value: "the plaintext returned by POST /board/:slug/github/secret",
          note: "Shown once. Rotating invalidates the old secret immediately.",
        },
      ],
    },
    endpoints: [
      {
        id: "github.config.get",
        summary: "Repo binding, whether a webhook secret exists, the active preset, and the rule set. Admin only. The secret itself is never returned.",
        response: "{ config: GithubConfig, rules: Rule[] }",
        curl: `curl ${BASE}/board/flow/github -H "Authorization: Bearer ${KEY}"`,
      },
      {
        id: "github.config.set",
        summary: "Connect a repo and/or choose a preset. Switching to a non-custom preset re-seeds the rule set; 'custom' leaves your edits alone.",
        params: [
          { name: "repo", note: '"owner/name", or null to clear' },
          { name: "preset", note: "defaults | status_only | custom | off" },
          { name: "external_states", note: "string[] to narrow the pill vocabulary, or null for the defaults" },
        ],
        response: "{ config, rules, seeded }",
        curl: `curl -X PUT ${BASE}/board/flow/github -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"repo":"you/repo","preset":"defaults"}'`,
      },
      {
        id: "github.secret.set",
        summary: "Mint (or rotate) the webhook secret. Plaintext returns ONCE — paste it into GitHub's Secret field. Rotating invalidates the old one immediately.",
        response: "{ secret, webhook_url }",
        curl: `curl -X POST ${BASE}/board/flow/github/secret -H "Authorization: Bearer ${KEY}"`,
      },
      {
        id: "github.rules.set",
        summary: "Replace the whole rule set (priority order included) and flip the board to the 'custom' preset. Rejected atomically if any rule is invalid.",
        params: [{ name: "rules", note: "Rule[] — each { bucket?, priority?, when, do, enabled? }" }],
        response: "{ rules: Rule[] }",
        curl: `curl -X PUT ${BASE}/board/flow/github/rules -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"rules":[{"when":{"event":"pull_request","action":"opened"},"do":{"type":"set_external_state","value":"pr_review"}}]}'`,
      },
      {
        id: "github.connection.test",
        summary: "Dry-run a payload against the live rules. Runs the same evaluator the webhook does and writes NOTHING — no cards change, no activity recorded.",
        params: [
          { name: "event", note: "pull_request | pull_request_review | check_run" },
          { name: "payload", note: "the webhook body, as JSON" },
        ],
        response: "{ facts, refs, matched, unresolved, outcomes }",
        curl: `curl -X POST ${BASE}/board/flow/github/test -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"event":"pull_request","payload":{"action":"opened"}}'`,
      },
      {
        id: "github.audit.list",
        summary: "Every verified delivery, newest first — including ones that matched no ticket or no rule, so a silently-idle rule is visible.",
        params: [
          { name: "event_type", note: "filter to one GitHub event" },
          { name: "errors_only", note: "1 to show only failed deliveries" },
          { name: "since", note: "epoch ms lower bound" },
          { name: "limit", note: "default 50, max 200" },
        ],
        response: "{ entries: AuditEntry[] }",
        curl: `curl "${BASE}/board/flow/github/audit" -H "Authorization: Bearer ${KEY}"`,
      },
      {
        id: "github.webhook.receive",
        summary: "GitHub's delivery endpoint. PUBLIC — auth is the HMAC in x-hub-signature-256 over the raw body. Returns 2xx for anything verified (including no-match) so GitHub stops retrying; 400 only for a bad signature or unreadable body.",
        response: "{ ok, matched, unresolved, rule_matched, actions }",
        curl: "# configured in GitHub, not called by hand",
      },
    ],
  },
];

export interface McpTool {
  readonly name: string;
  readonly summary: string;
  readonly args: string;
  readonly example: string;
}

export const MCP_TOOLS: ReadonlyArray<McpTool> = [
  {
    name: "kanban_board_list",
    summary: "List your boards, newest-updated first.",
    args: "{ limit?, after? }",
    example: '{"name":"kanban_board_list","arguments":{}}',
  },
  {
    name: "kanban_board_get",
    summary: "Fetch one board by slug.",
    args: "{ slug }",
    example: '{"name":"kanban_board_get","arguments":{"slug":"flow"}}',
  },
  {
    name: "kanban_issue_list",
    summary: "List a board's issues; one filter (status/container/assignee/label) at a time.",
    args: "{ board_slug, status?, container?, assignee?, label?, limit?, after? }",
    example: '{"name":"kanban_issue_list","arguments":{"board_slug":"flow","container":"active"}}',
  },
  {
    name: "kanban_issue_get",
    summary: "Full issue — fields plus comments and attachments.",
    args: "{ id } — UUID or short id like FLOW-42",
    example: '{"name":"kanban_issue_get","arguments":{"id":"FLOW-42"}}',
  },
  {
    name: "kanban_issue_create",
    summary: "Create an issue (title required; type/status/container/estimate/priority/labels optional).",
    args: "{ board_slug, title, body?, type?, status?, container?, estimate?, priority?, labels? }",
    example: '{"name":"kanban_issue_create","arguments":{"board_slug":"flow","title":"Ship it","type":"feature"}}',
  },
  {
    name: "kanban_issue_update",
    summary: "Partial update (title/body/type/status/assignee/priority/estimate/labels).",
    args: "{ id, ...fields }",
    example: '{"name":"kanban_issue_update","arguments":{"id":"FLOW-42","type":"bug"}}',
  },
  {
    name: "kanban_issue_transition",
    summary: "Move between columns — column_id preferred, `to` name-match kept.",
    args: "{ id, column_id? | to? }",
    example: '{"name":"kanban_issue_transition","arguments":{"id":"FLOW-42","to":"Done"}}',
  },
  {
    name: "kanban_issue_promote_to_active",
    summary: "Container verbs: …_promote_to_active / …_promote_to_backlog / …_send_to_icebox.",
    args: "{ id }",
    example: '{"name":"kanban_issue_promote_to_active","arguments":{"id":"FLOW-42"}}',
  },
  {
    name: "kanban_comment_post",
    summary: "Comment on an issue (in_reply_to threads).",
    args: "{ issue_id, body, in_reply_to? }",
    example: '{"name":"kanban_comment_post","arguments":{"issue_id":"FLOW-42","body":"On it."}}',
  },
  {
    name: "kanban_activity_read",
    summary: "Board activity feed, filterable by creation/status/container.",
    args: "{ board_slug, type?, limit?, after? }",
    example: '{"name":"kanban_activity_read","arguments":{"board_slug":"flow"}}',
  },
  {
    name: "kanban_attachment_download",
    summary:
      "Pull an attachment's bytes wrapped in a JSON envelope — {filename, content_type, size_bytes, bytes_b64}. Decode bytes_b64 (standard base64) to get the file. Same auth as REST /attachment/:id/download (viewer on the board); works for both default Blossom and BYO S3.",
    args: "{ id } — attachment UUID from kanban_issue_get's attachments[].id",
    example: '{"name":"kanban_attachment_download","arguments":{"id":"fa745953-183b-45b3-9269-8447e04db820"}}',
  },
];
