---
name: evenflow-api
description: Work with Evenflow (evenflow.work) — the user's kanban boards. Create issues, list what's active, transition columns, comment, manage containers, via the REST API or MCP endpoint. Trigger: /evenflow-api, "add a task to my board", "what's on my board", "move X to done", "file a bug on evenflow".
---

# Evenflow

Evenflow is a Linear-shaped kanban at https://evenflow.work. Boards belong to orgs
(`/@handle/board-slug`); issues carry short ids like `FLOW-42`, a type
(task|feature|bug|story|improvement|chore), a status COLUMN (per-board, stable
`column_id`s), and an orthogonal CONTAINER (icebox|backlog|active — "is this in
play?", separate from status).

## Auth — resolve once per session

Every call needs `Authorization: Bearer <token>`:

1. If the user gives you a key (starts with `evk_`) or a JWT, use it.
2. Else check the memory secret store for `evenflow_login` (e.g.
   `mem_secret_get evenflow_login` in Sonata sessions) — it holds an `evk_` key.
3. Else ask the user to mint one at https://evenflow.work/settings/keys and
   either paste it or save it as the `evenflow_login` secret.

Keys act as their owner and work on both REST and MCP. A 401 with reason
`invalid-api-key` means revoked/wrong key — ask for a fresh one, don't retry.

## Two transports, same vocabulary

**REST** — base `https://evenflow.work/api/v0`, plain JSON. Fine for one-off curl.

**MCP** (preferred for tool-based clients) — streamable HTTP at
`POST https://evenflow.work/mcp`, JSON-RPC 2.0. Client config:

```json
{ "mcpServers": { "evenflow": {
  "type": "http", "url": "https://evenflow.work/mcp",
  "headers": { "Authorization": "Bearer evk_…" } } } }
```

Full reference: https://evenflow.work/docs

## Intent → verb map

| User says | Do |
|---|---|
| "add a task/bug/feature to my X board" | `kanban_issue_create` |
| "what's on my board" / "what am I working on" | `kanban_issue_list` with `container=active` |
| "move X to done/review/…" | `kanban_issue_transition` |
| "show me FLOW-42" / "details on the login bug" | `kanban_issue_get` (returns comments + attachments too) |
| "comment on X" / "note that…" | `kanban_comment_post` |
| "put X on ice" / "pull X into the backlog/active" | `kanban_issue_send_to_icebox` / `…_promote_to_backlog` / `…_promote_to_active` |
| "which boards do I have" | `kanban_board_list` |

Resolve "my X board" by listing boards and matching slug/title; when several
match, ask. Issue refs accept `FLOW-42` (case-insensitive) or the UUID.

## Worked examples (MCP `tools/call` params)

Create — "file a bug: login spins forever":
```json
{ "name": "kanban_issue_create", "arguments": {
  "board_slug": "flow", "title": "Login spins forever",
  "type": "bug", "container": "active",
  "body": "Repro:\n1. Sign in\n2. Spinner never resolves" } }
```

List — "what's in play right now?":
```json
{ "name": "kanban_issue_list",
  "arguments": { "board_slug": "flow", "container": "active" } }
```
Summarize by status column; don't dump raw JSON at the user.

Transition — "move FLOW-42 to done":
```json
{ "name": "kanban_issue_transition",
  "arguments": { "id": "FLOW-42", "to": "Done" } }
```
`to` is an exact column name — read the board's columns
(`kanban_board_get`) if unsure; prefer `column_id` when you have it
(stable across renames).

Read one — "what's the state of FLOW-42?":
```json
{ "name": "kanban_issue_get", "arguments": { "id": "FLOW-42" } }
```

Comment — "note on FLOW-42 that the fix shipped":
```json
{ "name": "kanban_comment_post",
  "arguments": { "issue_id": "FLOW-42", "body": "Fix shipped in v0.9." } }
```

Container — "put FLOW-42 on ice":
```json
{ "name": "kanban_issue_send_to_icebox", "arguments": { "id": "FLOW-42" } }
```

## REST equivalents (when curl is handier)

```bash
BASE=https://evenflow.work/api/v0; AUTH="Authorization: Bearer $EVK"
curl $BASE/boards -H "$AUTH"                                  # boards
curl "$BASE/orgs/ORG/boards/SLUG/issues?container=active" -H "$AUTH"
curl -X POST $BASE/orgs/ORG/boards/SLUG/issues -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"title":"…","type":"task"}'
curl -X POST $BASE/issues/FLOW-42/transition -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"to":"Done"}'
curl "$BASE/issues/FLOW-42?include=comments,attachments" -H "$AUTH"
```

## Ground rules

- Issue bodies are GFM markdown; `[[FLOW-42]]` in a body cross-links issues.
- Status names are per-board — never assume "Done" exists; check the board's
  columns (done-ness is the column's `category`, not its name).
- Creating defaults: `type=task`, `container=backlog`. If the user says "I'm
  doing this now", set `container=active`.
- Mutations need contributor rights; a 403 means the key's owner lacks them —
  report it, don't retry.
- After a mutation, confirm with the short id: "Filed FLOW-51 (bug, active)."
