// Hand-written API reference data for /docs (phase 19).
//
// This is the DOCUMENTED surface, not an exhaustive route dump — the
// routers in src/routes/* on the Worker remain the source of truth.
// MCP_TOOLS mirrors src/routes/mcp.ts tool names/shapes; keep in lockstep.

export interface RestEndpoint {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly summary: string;
  readonly params?: ReadonlyArray<{ name: string; note: string }>;
  readonly response: string;
  readonly curl: string;
}

export interface RestSection {
  readonly title: string;
  readonly endpoints: ReadonlyArray<RestEndpoint>;
}

const KEY = "evk_your_key_here";
const BASE = "https://evenflow.work/api/v0";

export const REST_SECTIONS: ReadonlyArray<RestSection> = [
  {
    title: "Boards",
    endpoints: [
      {
        method: "GET",
        path: "/boards",
        summary: "Every board you can see, newest-updated first.",
        params: [
          { name: "limit", note: "page size, default 20, max 100" },
          { name: "after", note: "keyset cursor: last board id of the previous page" },
        ],
        response: "{ boards: Board[], total }",
        curl: `curl ${BASE}/boards -H "Authorization: Bearer ${KEY}"`,
      },
      {
        method: "GET",
        path: "/orgs/:org/boards/:slug",
        summary: "One board, with your effective role.",
        response: "{ board, org, role }",
        curl: `curl ${BASE}/orgs/acme/boards/flow -H "Authorization: Bearer ${KEY}"`,
      },
      {
        method: "POST",
        path: "/orgs/:org/boards",
        summary: "Create a board. Columns default to Todo / In Progress / In Review / Done.",
        params: [
          { name: "slug", note: "required, [A-Za-z0-9_-]{1,64}" },
          { name: "title", note: "required" },
          { name: "columns", note: "optional Column[] {id,name,order,enabled,category} or string[] of names" },
        ],
        response: "{ board, org }",
        curl: `curl -X POST ${BASE}/orgs/acme/boards -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"slug":"flow","title":"Flow"}'`,
      },
      {
        method: "PATCH",
        path: "/orgs/:org/boards/:slug",
        summary:
          "Update title/description/columns/visibility. Deleting a column that still has issues needs column_move_map.",
        params: [
          { name: "columns", note: "full Column[] — ≤12, ≥1 enabled, unique ids, contiguous order" },
          { name: "column_move_map", note: "{deleted_column_id: surviving_enabled_column_id}" },
          { name: "visibility", note: "'private' | 'public'" },
        ],
        response: "{ board }",
        curl: `curl -X PATCH ${BASE}/orgs/acme/boards/flow -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"visibility":"public"}'`,
      },
    ],
  },
  {
    title: "Issues",
    endpoints: [
      {
        method: "GET",
        path: "/orgs/:org/boards/:slug/issues",
        summary: "Issues on a board, newest-updated first. One filter at a time.",
        params: [
          { name: "status | container | assignee | label", note: "optional single filter" },
          { name: "limit / after", note: "keyset pagination" },
        ],
        response: "{ issues: Issue[], total, has_more } — each issue carries cover_url when a cover is set",
        curl: `curl "${BASE}/orgs/acme/boards/flow/issues?container=active" -H "Authorization: Bearer ${KEY}"`,
      },
      {
        method: "GET",
        path: "/issues/:ref",
        summary: "One issue by UUID or short id (FLOW-42). ?include= expands related records.",
        params: [{ name: "include", note: "comma list: comments, attachments" }],
        response: "{ issue, comments?, attachments? }",
        curl: `curl "${BASE}/issues/FLOW-42?include=comments,attachments" -H "Authorization: Bearer ${KEY}"`,
      },
      {
        method: "POST",
        path: "/orgs/:org/boards/:slug/issues",
        summary: "Create an issue. type ∈ task|feature|bug|story|improvement|chore (default task).",
        params: [
          { name: "title", note: "required" },
          { name: "body", note: "GFM markdown" },
          { name: "type / status / container / estimate / priority / labels", note: "optional" },
        ],
        response: "{ issue } — short_id like FLOW-42 is minted here",
        curl: `curl -X POST ${BASE}/orgs/acme/boards/flow/issues -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"title":"Ship it","type":"feature"}'`,
      },
      {
        method: "PATCH",
        path: "/issues/:ref",
        summary: "Partial update: title, body, body_format, type, status (by name), assignee, priority, estimate, labels.",
        response: "{ issue }",
        curl: `curl -X PATCH ${BASE}/issues/FLOW-42 -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"type":"bug"}'`,
      },
      {
        method: "POST",
        path: "/issues/:ref/transition",
        summary: "Move between columns. column_id (stable across renames) wins over the legacy name form `to`.",
        params: [
          { name: "column_id", note: "preferred — a Column.id from the board" },
          { name: "to", note: "legacy exact column name" },
        ],
        response: "{ issue }",
        curl: `curl -X POST ${BASE}/issues/FLOW-42/transition -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"to":"Done"}'`,
      },
      {
        method: "POST",
        path: "/issues/:ref/promote_to_active",
        summary: "Container verbs: promote_to_active, promote_to_backlog, send_to_icebox. Idempotent.",
        response: "{ issue }",
        curl: `curl -X POST ${BASE}/issues/FLOW-42/promote_to_active -H "Authorization: Bearer ${KEY}"`,
      },
    ],
  },
  {
    title: "Comments",
    endpoints: [
      {
        method: "GET",
        path: "/issues/:ref/comments",
        summary: "Thread in chronological order, forward keyset pagination.",
        response: "{ comments: Comment[], total, has_more }",
        curl: `curl ${BASE}/issues/FLOW-42/comments -H "Authorization: Bearer ${KEY}"`,
      },
      {
        method: "POST",
        path: "/issues/:ref/comments",
        summary: "Post a comment; in_reply_to threads under another comment.",
        response: "{ comment }",
        curl: `curl -X POST ${BASE}/issues/FLOW-42/comments -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"body":"On it."}'`,
      },
    ],
  },
  {
    title: "Attachments",
    endpoints: [
      {
        method: "POST",
        path: "/orgs/:org/boards/:slug/issues/:ref/attachments",
        summary:
          "Upload (multipart `file` field, or JSON base64). 5MB/file, 20/issue, images+pdf+text+zip+json only.",
        params: [{ name: "file_b64 / filename / content_type", note: "JSON body form" }],
        response: "{ attachment } — or an actionable {code, message, link} rejection",
        curl: `curl -X POST ${BASE}/orgs/acme/boards/flow/issues/FLOW-42/attachments -H "Authorization: Bearer ${KEY}" -F "file=@shot.png"`,
      },
      {
        method: "PATCH",
        path: "/attachments/:id",
        summary: "{is_cover: true} makes an image the card cover (one per issue).",
        response: "{ attachment }",
        curl: `curl -X PATCH ${BASE}/attachments/ID -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"is_cover":true}'`,
      },
      {
        method: "DELETE",
        path: "/attachments/:id",
        summary: "Soft delete — the row hides, the blob stays on Blossom.",
        response: "{ deleted: true }",
        curl: `curl -X DELETE ${BASE}/attachments/ID -H "Authorization: Bearer ${KEY}"`,
      },
    ],
  },
  {
    title: "API keys",
    endpoints: [
      {
        method: "POST",
        path: "/keys",
        summary: "Mint a key (JWT session required — keys can't mint keys). Plaintext returns ONCE.",
        params: [{ name: "name", note: "required, ≤60 chars" }],
        response: "{ key, plaintext }",
        curl: `curl -X POST ${BASE}/keys -H "Authorization: Bearer YOUR_JWT" -H "Content-Type: application/json" -d '{"name":"CI"}'`,
      },
      {
        method: "GET",
        path: "/keys",
        summary: "Your keys — name, display prefix, created/last-used/revoked. Never the secret.",
        response: "{ keys: Key[] }",
        curl: `curl ${BASE}/keys -H "Authorization: Bearer YOUR_JWT"`,
      },
      {
        method: "DELETE",
        path: "/keys/:id",
        summary: "Soft-revoke. Requests with the key 401 immediately after.",
        response: "{ revoked: true }",
        curl: `curl -X DELETE ${BASE}/keys/ID -H "Authorization: Bearer YOUR_JWT"`,
      },
    ],
  },
  {
    title: "GitHub integration",
    endpoints: [
      {
        method: "GET",
        path: "/boards/:slug/github",
        summary: "Repo binding, whether a webhook secret exists, the active preset, and the rule set. Admin only. The secret itself is never returned.",
        response: "{ config: GithubConfig, rules: Rule[] }",
        curl: `curl ${BASE}/boards/flow/github -H "Authorization: Bearer ${KEY}"`,
      },
      {
        method: "PUT",
        path: "/boards/:slug/github",
        summary: "Connect a repo and/or choose a preset. Switching to a non-custom preset re-seeds the rule set; 'custom' leaves your edits alone.",
        params: [
          { name: "repo", note: '"owner/name", or null to clear' },
          { name: "preset", note: "defaults | status_only | custom | off" },
          { name: "external_states", note: "string[] to narrow the pill vocabulary, or null for the defaults" },
        ],
        response: "{ config, rules, seeded }",
        curl: `curl -X PUT ${BASE}/boards/flow/github -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"repo":"you/repo","preset":"defaults"}'`,
      },
      {
        method: "POST",
        path: "/boards/:slug/github/secret",
        summary: "Mint (or rotate) the webhook secret. Plaintext returns ONCE — paste it into GitHub's Secret field. Rotating invalidates the old one immediately.",
        response: "{ secret, webhook_url }",
        curl: `curl -X POST ${BASE}/boards/flow/github/secret -H "Authorization: Bearer ${KEY}"`,
      },
      {
        method: "PUT",
        path: "/boards/:slug/github/rules",
        summary: "Replace the whole rule set (priority order included) and flip the board to the 'custom' preset. Rejected atomically if any rule is invalid.",
        params: [{ name: "rules", note: "Rule[] — each { bucket?, priority?, when, do, enabled? }" }],
        response: "{ rules: Rule[] }",
        curl: `curl -X PUT ${BASE}/boards/flow/github/rules -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"rules":[{"when":{"event":"pull_request","action":"opened"},"do":{"type":"set_external_state","value":"pr_review"}}]}'`,
      },
      {
        method: "POST",
        path: "/boards/:slug/github/test",
        summary: "Dry-run a payload against the live rules. Runs the same evaluator the webhook does and writes NOTHING — no cards change, no activity recorded.",
        params: [
          { name: "event", note: "pull_request | pull_request_review | check_run" },
          { name: "payload", note: "the webhook body, as JSON" },
        ],
        response: "{ facts, refs, matched, unresolved, outcomes }",
        curl: `curl -X POST ${BASE}/boards/flow/github/test -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"event":"pull_request","payload":{"action":"opened"}}'`,
      },
      {
        method: "GET",
        path: "/boards/:slug/github/audit",
        summary: "Every verified delivery, newest first — including ones that matched no ticket or no rule, so a silently-idle rule is visible.",
        params: [
          { name: "event_type", note: "filter to one GitHub event" },
          { name: "errors_only", note: "1 to show only failed deliveries" },
          { name: "since", note: "epoch ms lower bound" },
          { name: "limit", note: "default 50, max 200" },
        ],
        response: "{ entries: AuditEntry[] }",
        curl: `curl "${BASE}/boards/flow/github/audit?errors_only=1" -H "Authorization: Bearer ${KEY}"`,
      },
      {
        method: "POST",
        path: "/webhooks/github/:board_id",
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
];
