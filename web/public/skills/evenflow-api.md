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
2. Else get the API key from the memory secret store: **`evenflow_apikey`**
   (`mem_secret_get evenflow_apikey`) — Sona's persistent `evk_` key, minted
   2026-07-31. This is THE standing credential; try it FIRST, always.
3. Else (no API key in the store) sign in via 4a with the Nostr creds — the
   `/evenflow-signup` flow's keypair — to mint a fresh session, then save the
   resulting `evk_` key back as `evenflow_apikey`.
4. Else ask the user to mint one at https://evenflow.work/settings/keys and
   either paste it or save it as the `evenflow_apikey` secret.

Do NOT use the `evenflow_login` secret — it is a ~7-day Nostr-signed JWT
(long expired; kept only as a historical artifact). A session reaching for it
instead of `evenflow_apikey` and concluding "the Evenflow credential is
expired" is the exact failure this ordering exists to prevent (2026-09-03).

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
| "add a task/bug/feature to my X board" (start now) | `kanban_issue_create` with `"container":"active"` |
| "capture this for later / add to the backlog" | `kanban_issue_create` with `"container":"backlog"` |
| "what's on my board" / "what am I working on" | `kanban_issue_list` with `container=active` |
| "move X to done/review/…" | `kanban_issue_transition` |
| "show me FLOW-42" / "details on the login bug" | `kanban_issue_get` (returns comments + attachments too) |
| "comment on X" / "note that…" | `kanban_comment_post` |
| "start working on X" (X currently in backlog/icebox) | `kanban_issue_promote_to_active` FIRST, then transition columns |
| "put X on ice" / "park X in backlog" | `kanban_issue_send_to_icebox` / `kanban_issue_promote_to_backlog` |
| "put X back on the board / pick it up" | `kanban_issue_promote_to_active` |
| "which boards do I have" | `kanban_board_list` |

Resolve "my X board" by listing boards and matching slug/title; when several
match, ask. Issue refs accept `FLOW-42` (case-insensitive) or the UUID.

## Container semantics — READ THIS BEFORE CREATING OR PICKING UP TICKETS

Every issue carries a `container` — `active | backlog | icebox` — orthogonal to
its status column. The container answers **"where does this card live in the
planning workflow?"** — it is TIED to sprints, not to "am I working on it":

| Container | Meaning |
|---|---|
| `active` | Belongs to the current running sprint (or, on a sprint-free board, is the immediate working set) |
| `backlog` | On the roadmap but not yet committed to a sprint |
| `icebox` | Off the roadmap — not now, maybe never |

**How to think about it:**

- **On a board WITH active sprints:** `active` cards are the sprint's contents. Cards enter `active` by being pulled from the backlog into the running sprint (dragging into a sprint zone in the UI, or via `kanban_issue_promote_to_active`). Creating a card straight to `active` means "add it to the running sprint mid-flight." Creating to `backlog` means "queue for a future sprint."
- **On a board WITHOUT sprints (like Adaptengine as of 2026-09):** the distinction between `active` and `backlog` largely collapses on the Kanban view — `web/src/pages/board/KanbanView.tsx:64-73` ORs both containers together so a sprint-free board isn't an empty Kanban. **Default to `backlog` for new tickets on a sprint-free board.** They'll still appear on the Kanban board because of the OR; the Backlog view will also list them. `icebox` is what you use to explicitly park.

**Rules that hold either way:**

1. **Never use `PATCH /issue/:id {"container":…}`** — that endpoint deliberately rejects container edits (`400 container-immutable`). Container moves have their own audit event and their own endpoint:

```bash
# The one true container-move endpoint (idempotent, auth=contributor on the board):
curl -X POST "$BASE/org/ORG/issue/FLOW-42/container" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"container":"active"}'   # or "backlog" or "icebox"
```

MCP callers use the dedicated tools instead — same three destinations, no body:
- `kanban_issue_promote_to_active` — move to `active`
- `kanban_issue_promote_to_backlog` — move to `backlog`
- `kanban_issue_send_to_icebox` — move to `icebox`

2. **Column transitions do NOT touch container.** `POST /issue/:id/transition` only updates status/column/position. A backlog card whose column you move stays in backlog. On a board with sprints, that means it stays off the sprint-scoped Kanban view even after you "moved it to In Review." On a sprint-free board, the same call surfaces the card on Kanban via the OR — but the server row still says backlog.

3. **Sprint-free board and the peer-just-saw-this-be-confusing case:** if a peer or user says "this ticket is on the Kanban board but the API says container=backlog and I want it to only show in Backlog view" — the answer is either (a) `icebox` it, or (b) start a sprint on the board so the container distinction actually gates rendering. There's no way to keep a card `backlog` AND hide it from Kanban on a sprint-free board; the "sprint-free flow" design chose visibility over separation.

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

Path rule: individual-item paths are SINGULAR (`/board/:slug`, `/issue/:id`, `/comment/:id`); collections are plural under the singular parent (`/board/:slug/issues`, `/issue/:id/comments`). The one collection served at the top level is `/boards` (your accessible boards, plural — the exception). NO `/orgs/` prefix and NO `/issues/:id` bare form; both 404. Every board-family route ALSO mounts under `/org/:org_slug/…` (singular `org`) if you need to disambiguate — use it whenever a slug isn't unique across orgs.

```bash
BASE=https://evenflow.work/api/v0; AUTH="Authorization: Bearer $EVK"

# Boards & board detail
curl "$BASE/boards" -H "$AUTH"                                  # boards.list
curl "$BASE/board/SLUG" -H "$AUTH"                              # board.get
# Org-qualified form (disambiguates if slug collides across orgs):
curl "$BASE/org/ORG/board/SLUG" -H "$AUTH"

# Issue list & filter
curl "$BASE/board/SLUG/issues?container=active" -H "$AUTH"      # issue.list

# Issue create — POST on the collection under the board
curl -X POST "$BASE/board/SLUG/issues" -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"title":"…","type":"task"}'

# Read one issue (by short_id like FLOW-42 or by UUID)
curl "$BASE/issue/FLOW-42" -H "$AUTH"                           # issue.get
curl "$BASE/issue/FLOW-42/comments" -H "$AUTH"                  # comment.list

# Transition
curl -X POST "$BASE/issue/FLOW-42/transition" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"to":"Done"}'

# Comment
curl -X POST "$BASE/issue/FLOW-42/comments" -H "$AUTH" \
  -H "Content-Type: application/json" -d '{"body":"Fix shipped."}'

# Attachments — metadata is on the issue detail; bytes need this endpoint.
curl "$BASE/board/SLUG/issue/FLOW-42/attachments" -H "$AUTH"    # attachment.list
# Download the bytes (works on default Blossom AND BYO S3 buckets — the
# server proxies signed reads, credentials never touch the caller):
curl -OJ "$BASE/attachment/$ATTACHMENT_ID/download" -H "$AUTH"  # attachment.download
# Org-qualified form (same shape, disambiguates if you ever need it):
curl -OJ "$BASE/org/ORG/attachment/$ATTACHMENT_ID/download" -H "$AUTH"
```

Attachment ids come from `kanban_issue_get` (each attachment's `id` field) or `attachment.list` above. The download endpoint returns the raw file with the correct `Content-Type` and a `Content-Disposition: attachment; filename="…"` header — pipe to `-O -J` if you want curl to save it under the original name. **Do not try to fetch the `blob_url` field on a BYO S3 attachment directly** — that's a private R2 URL that requires SigV4 and answers `400 InvalidArgument: Authorization` to a bearer token. The `/attachment/:id/download` endpoint is the one that works everywhere; auth is `viewer` on the board.

If a REST call returns `403 forbidden: this route is not declared in the API manifest`, that's a scoped `evk_` key hitting a manifest gap for keys (not a path typo — the URL is correct but the middleware fails-closed for keys on undeclared routes). Fall back to MCP for that call, or use a JWT.

## Known pubkeys — adaptengine org (cached 2026-09-08; these don't change — only fetch `/org/adaptengine/members` for a member NOT listed here)

| Person | pubkey | role |
|---|---|---|
| Evan (evan.frohlich) | `google:114038898351513339547` | owner |
| Sai (Sairam Yellanki) | `google:105645732047355422897` | admin |
| Sona (this agent's Nostr identity) | `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2` | admin |
| unidentified admin (likely Conrad) | `google:106902217904903147634` | admin |

Use these directly as `assignee_pubkey` in issue.create — no members/profile round-trips needed.

## Ground rules

- Issue bodies are GFM markdown; `[[FLOW-42]]` in a body cross-links issues.
- Status names are per-board — never assume "Done" exists; check the board's
  columns (done-ness is the column's `category`, not its name).
- Creating defaults: `type=task`, `container=backlog`. If the user says "I'm
  doing this now", set `container=active`.
- Mutations need contributor rights; a 403 means the key's owner lacks them —
  report it, don't retry.
- After a mutation, confirm with the short id: "Filed FLOW-51 (bug, active)."
