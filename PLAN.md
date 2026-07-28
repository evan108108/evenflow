# Evenflow — Plan & Design

*The Even Flow of Work.*

Public copy of the internal design doc (`~/.sonata/wiki/ideas/kanban-on-4a.md`). This file is the source of truth going forward; the wiki page will get pruned to a stub pointing here once the repo is real.

---

## The idea in one paragraph

Linear-shaped issue tracker as a browser webapp with no backend of its own — [4a](https://4a4.ai) is the entire storage, transport, and identity layer. Boards are 4a audiences (kind-30520 declarations); issues, comments, and status changes are signed parameterized-replaceable events under a reserved kind range; private teams work like [Sonata Studio](https://sonata.email) rooms today (audience declaration + invite → key-grant → encrypted variants); public boards use the plain-broadcast variants any client can read. AI features — auto-triage, status suggestions, draft comments, weekly digests, whatever a team wants — are **user-supplied via webhook routes**, not baked in. The economic story writes itself: at Evan's current Linear spend (~$100/mo), even a five-person team spends over a thousand dollars a year for something whose data model 4a already ships. This replaces that bill with ~$0.

## Why it matters

- **The substrate already exists.** Audiences (private teams), key-grants (invites), encrypted variants (private issue bodies), broadcast variants (public boards), NIP-05 `fa` identity (assignees, verifiable authorship), cross-network federation, and now — after 2026-07-27 — a webhook-in transport for third-party integrations. Building the webapp is a UI layer over primitives that already work in production.
- **BYO-AI via webhooks is the real spin.** Linear's AI features are a subscription upsell; the LLM bill sits inside the seat price. Here, every board can expose one or more webhook URLs, and the user wires their own AI — a Sonata worker, an OpenAI-fronted script, a Cloudflare Worker running Anthropic, whatever. Zero inference cost lives inside the app, which is what makes "free" honest.
- **Private teams with the trust story Linear can't match.** For private boards, issue bodies are NIP-44 encrypted to the audience epoch key. The gateway operator sees signed ciphertext and event metadata but never issue content. Linear necessarily reads everything. For teams that care — legal, security, health, anything under NDA — that's not a feature, that's a posture change.
- **Public boards are a real product too.** Open-source projects, community roadmaps, transparent status pages — publish the same event shapes without encryption and any 4a client can read them.
- **Portable identity.** Assignee is a pubkey. Contributions across boards, teams, orgs all trace back to the same signing key. No vendor lock.

## Feature scope + API shape reference: Linear

Linear's [public API](https://developers.linear.app/) and [MCP server](https://linear.app/changelog/2025-05-01-mcp) are the reference for feature parity and shape decisions. Design goal: **parity where it makes sense, deliberate divergence where 4a's substrate enables something better.**

Where we match Linear:
- Issue verbs: create, update, transition, comment, assign, label
- Board (project) verbs: create, list, member management, settings
- Cycles/sprints as an optional dimension (v2)
- GitHub PR link-back with auto-transitions on merge
- MCP tools shaped for AI clients (Claude, Cursor, etc.)

Where we deliberately diverge:
- **Federated identity via 4a pubkeys**, not per-workspace user accounts
- **Encrypted-by-default private boards** (Linear can't offer this by design)
- **Icebox / Backlog / Active as first-class orthogonal to status** (Linear conflates these into project stages)
- **BYO-AI via webhooks** instead of embedded LLM features
- **BYO storage** (S3/R2) for attachments per-board
- **Zero seat-based pricing** — it's free

## Shape (three moving parts)

### 4a event kinds — reserving `30550`–`30559`

All parameterized-replaceable so state edits don't require deletion:

| Kind | Shape | Encrypted variant |
| --- | --- | --- |
| `30550` | `fa:KanbanBoard` — board metadata: title, description, columns, labels, member policy | `30555` |
| `30551` | `fa:KanbanIssue` — one issue: title, body, status, assignee, priority, label refs, board ref, **estimate** (integer story-points, nullable), **container** (`icebox` / `backlog` / `active`) | `30556` |
| `30552` | `fa:KanbanComment` — comment on an issue: body, in-reply-to, author | `30557` |
| `30553` | `fa:KanbanStatusChange` — audit event for status transitions | `30558` |
| `30554` | `fa:KanbanSprint` (optional, v2) — a time-bounded cycle grouping issues | `30559` |

Private teams use the `+5` encrypted variants gift-wrapped to the audience epoch key, exactly like Studio cards today. Public boards use the plain variants.

**Decision: fresh kind range, not Sonata Studio's `30530`–`30539` reuse.** Studio cards are conversational units (question, answer, dispatch, comment) attached to a room's discussion flow. Kanban issues are units-of-work with lifecycle (status, assignee, priority, labels) that outlive any single discussion. Fresh range keeps evolution independent. A bridge action (`kanban_issue_from_studio_card`, `studio_card_from_kanban_issue`) covers the "elevate a discussion into work" flow without coupling.

### The webapp

Single-page browser app, all client-side, served from the same Worker that serves the API. Signs events with a browser-held key (Web Crypto + IndexedDB persistence, or a NIP-07 extension for people who want their key out of the browser DB). Consumes SSE from a Durable Object per board.

### Webhook routes for BYO-AI

Each board's settings expose:

- **Outbound webhooks (gateway-side firing).** POST to a user-configured URL on issue-created, comment-added, status-changed. The gateway is the single source of truth for firing — browser-side firing was rejected because it breaks headless AI-to-AI chaining and misses events during no-browser periods.
- **Inbound webhooks.** An AI or automation writes to the board via HTTP with JWT auth. Route it through the existing webhook-relay to a `kanban_issue_create` / `kanban_comment_post` action running on any 4a-capable endpoint.

Together these mean: "auto-triage new issues" is a webhook route pointing at a script the user owns. The product ships with worked examples and a template gallery.

## GitHub integration

Non-negotiable for adoption. PRs and branches map to issues, PRs auto-comment on the issue, status auto-transitions on merge, merged PRs close their linked issue.

**Substrate reuse.** GitHub → 4a webhook-relay → a `kanban_pr_event` responder is the exact flow webhook-relay was built for. GitHub HMAC verification (`x-hub-signature-256`) fits the existing `hmacSha256` scheme; svix-shape headers are already forwarded. Zero new gateway code for GitHub-inbound.

**Two link primitives, both trivial:**
1. **Branch name convention** — `<owner>/<board-slug>-<issue-id>-<short-desc>` (e.g. `evan/kb-42-fix-login-race`).
2. **PR body reference** — `Closes kb-42` or `Refs kb-42-fix-login-race` in the PR body/title.

Supporting both is ~30 lines of parsing in the responder.

**Link storage.** Add a `["github", "<repo>", "<pr-number>", "<state>"]` tag to the kanban issue event on link. Multiple PRs per issue is one tag each. On PR state transitions, the responder patches by re-publishing.

**Auto-transitions.** Board settings expose a `github_transitions` config: `{ pr_opened: "In Review", pr_merged: "Done", pr_closed: "Backlog" }`. Nullable — users who want manual control leave it unset.

**Ships as a template artifact.** The responder is published via the public-artifacts primitive so users copy-paste one URL, deploy to their own CF Workers account, and have GitHub link-back working within 15 minutes.

## Icebox, Backlog, Active — two orthogonal dimensions

Two things get conflated in most trackers and should be separate here:

- **Status** — lifecycle: `Todo`, `In Progress`, `In Review`, `Done`.
- **Container** — pool: `Icebox`, `Backlog`, `Active`.

An `Active` issue is scoped and moving through statuses right now. A `Backlog` issue is defined but not yet planned in. An `Icebox` issue is aspirational — an idea you don't want to lose but don't want to see on your board every day.

**Schema.** Each `KanbanIssue` carries a `["container", "<icebox|backlog|active>"]` tag. Default for new issues is `backlog`.

**Movement.** Three verbs: `promote_to_backlog`, `promote_to_active`, `send_to_icebox`. Each fires the usual outbound webhook.

**Views.** Three default views per board:
- **Kanban** — active only, columns by status. Daily view.
- **Backlog** — backlog + active. Planning surface.
- **Icebox** — icebox only. Optional monthly/quarterly review nudge.

**Velocity math cares about container.** Only `Done` issues that were in `active` at completion count toward velocity. `KanbanStatusChange` carries `container_at_completion` so the aggregator filters cleanly.

## Estimation & velocity

Each `KanbanIssue` carries an `["estimate", "<integer>"]` tag (nullable). Convention is Fibonacci (1, 2, 3, 5, 8, 13); field is a raw integer so boards can be Fibonacci, hours, or anything.

**Velocity is derived, not stored.** `sum(estimate)` over `Done` issues in the `active` container within a time window. Pure query over existing events. No new event kind.

**UI.** Estimate dropdown in issue detail; board-header aggregate + trailing-N-week sparkline labeled **"The Current"**; board-settings velocity-window preference.

Sprints stay out of v1. Kind `30554` reserved for later.

## Developer surfaces — MCP + REST API + CLI

The 4a substrate has the right primitives but the wrong ergonomics for a product. Evenflow ships a thin repackaging layer so every consumer (webapp, MCP client, CLI, third-party integration) talks to it in issue-tracker vocabulary.

**Three surfaces, all thin wrappers.**

- **MCP server** at `evenflow.work/mcp`. Tools: `kanban_board_list`, `kanban_issue_list`, `kanban_issue_get`, `kanban_issue_create`, `kanban_issue_update`, `kanban_issue_transition`, `kanban_comment_post`, `kanban_label_create`, `kanban_member_invite`. Shaped to match Linear's MCP where semantics align.
- **REST API** at `evenflow.work/api/v0/` for scripts, CLIs, GitHub Actions. `GET /boards/:slug/issues`, `POST /boards/:slug/issues`, `PATCH /issues/:id`, `POST /issues/:id/transition`, `POST /issues/:id/comments`.
- **CLI** (`kb`) — nice-to-have follow-up. Ships as a copy-pasteable script.

**Auth — reuse 4a's existing OAuth 2.0 AS.** The gateway already ships a full RFC-6749 Authorization Server at `api.4a4.ai/auth/*`. Users sign in with Google or GitHub → 4a mints an HS256 JWT tied to `(provider, oauth_id, login)`. Every signing operation derives the Nostr key from `(provider:oauth_id)` via AWS KMS HMAC — master key never leaves the HSM.

- **Webapp**: OAuth flow through `api.4a4.ai/auth/{google,github}/start`, JWT in `localStorage`.
- **MCP**: `/.well-known/oauth-protected-resource` declares `mcp.4a4.ai` as the protected resource. MCP clients discover the AS via RFC 9728.
- **REST + CLI**: same JWT, `Authorization: Bearer <jwt>`.

Board-membership is orthogonal: JWT identifies *who*; audience declarations + key-grants say whether that pubkey is a member. Kanban's server-side check: JWT-derived pubkey ∈ current audience epoch's granted members.

## Language + stack

**Server**: TypeScript + [Hono](https://hono.dev/) on Cloudflare Workers.
**Runtime**: [Effect](https://effect.website) end-to-end — server *and* client. `Effect<A, E, R>` is the return type everywhere.
**Client**: [Solid](https://www.solidjs.com/) + Effect. Signals match the signed-event streaming shape naturally.
**Storage**: Cloudflare D1 (structured state), R2 (artifact bodies), Durable Objects (per-board SSE fanout).
**Live updates**: SSE from the Worker; Durable Object owns per-board subscriber list.
**Sonata integration**: Sonata talks to Evenflow like any other 4a client — HTTP + JWT via the existing OAuth AS.

## Activity feed semantics

The board activity feed is a straight read over `statusChangeCache` — the audit rows every mutation already writes. A row's *kind* is inferred from which nullable pair is populated; there is no discriminator column:

| kind | to_status | to_container | notes |
|---|---|---|---|
| `creation` | non-null | non-null | initial status + container land together; `from_*` both null |
| `status` | non-null | null | `from_status` also non-null |
| `container` | null | non-null | statuses both null |

`GET /boards/:slug/activity` filters with `?type=creation|status|container`, keyset-paginates newest-first on `(occurred_at_ms, id)` with `?after=<statusChange id>` (default limit 30, max 100), and enriches each row with its issue title via a second D1 read merged in code — no SQL JOIN, and `issue_title` is `null` when the issue has since been deleted (audit rows outlive their issue).

Live updates ride the same writes: after every committed mutation the Worker fires a `BoardEvent` through the `BoardEmitter` service to the board's `BoardDO` (one Durable Object instance per board id), which fans it out as SSE to every client on `GET /boards/:slug/stream`. Fanout is best-effort by design — a DO hiccup logs a warning but never fails the mutation; clients recover on EventSource reconnect.

## Deploy economics

Real numbers from Cloudflare's published pricing (2026-07-28):

**Workers Paid ($5/month base):** 10M requests + 30M CPU-ms included. Overage: $0.30/M requests, $0.02/M CPU-ms.

Assuming ~10 CPU-ms per request:

| Monthly load | Estimated cost |
|---|---|
| 1M req (~33K/day) | $5 |
| 10M req (small team, ~100 daily users) | $6.40 |
| 100M req (mid-scale SaaS) | ~$51 |
| 1B req (real SaaS) | ~$501 |

At any load a real team would put on this, we're paying single-digit dollars per month. Linear costs $10/user/month × N users. The break-even is trivially small.

## Importers — critical for adoption

Nobody starts fresh. Every team switching to Evenflow is switching *from* Linear, Jira, Trello, GitHub Issues, Notion databases, or a hand-rolled spreadsheet. If import is painful, they don't switch. If it's one click, they do.

**Sources for MVP (in order of value):**
1. **Linear** — GraphQL API. Take user's Linear API key, fetch projects → boards, issues → issues, comments → comments, labels → labels, states → columns. Preserve issue IDs where possible (add a `["linear", "<team-key>-<number>"]` reference tag for cross-linking).
2. **Jira** — REST API. Similar shape. Handle Atlassian Cloud auth (API token) + Server/Data Center (basic auth). Preserve issue IDs.
3. **CSV** — universal fallback. Column mapping UI: title, body/description, status, assignee, labels, estimate, container. Handles Trello CSV export, Jira CSV export, Notion CSV export, Airtable, spreadsheets — anything you can save as CSV.
4. **Trello JSON** — Trello's native board-export format. Native map: cards → issues, lists → status columns, labels → labels, checklists → issue body appendix.
5. **GitHub Issues** — REST API + user's PAT. Fetch open + closed issues, comments, labels, milestones (→ boards? or ignored?), assignees (unlinked; map manually).

**Architecture — the honest split:**

- **Client-side fetch, server-side commit.** The browser (or a CLI) uses the user's API key to fetch from Linear/Jira/GitHub, converts to Evenflow's event shape, then POSTs a bulk-import payload to `/api/v0/boards/:slug/import`. This keeps third-party API keys client-side (never touches Evenflow's Worker), sidesteps CORS surprises (the user's browser has whatever access), and puts the parsing/mapping logic somewhere users can inspect and modify.
- **Server-side atomic commit.** The `/api/v0/boards/:slug/import` endpoint accepts `{ boards: [BoardCreate], issues: [IssueCreate], comments: [CommentCreate], statusChanges: [StatusChangeCreate] }` as one payload, validates it, and applies in a single D1 transaction. Duplicate detection via source-tag lookup (`["linear", "..."]` or `["jira", "..."]`); re-runs are idempotent.
- **CSV path is different**: server-side because CSV is a file upload, not an API fetch. Server accepts multipart, parses in the Worker, applies a user-supplied column map, atomically imports.

**UI shape:**
- Board settings → Import → source picker (Linear / Jira / CSV / Trello / GitHub)
- For API-fetch sources: paste API key, pick source project/board, preview mapped issues, confirm import.
- For CSV: upload file, map columns via UI, preview first 20 rows, confirm.
- **Preserve source references**: every imported issue carries the source tag (`["linear","kb-42"]`, `["jira","PROJ-100"]`, etc.) so re-runs match and update instead of duplicating.

**Reference tags become link-back**: because the source tag is on the issue event, an outbound webhook can push status updates back to Linear/Jira ("this issue moved to Done in Evenflow, close it in Linear too"). Two-way sync isn't the default posture (creates ambiguity about source of truth), but the primitives are there if a team wants it.

**Migration friction is why teams stay on Linear paying $10/user/month.** Nailing import is worth more than any one product feature.

## Non-goals for v1

- **Sprints, cycles, roadmaps, custom workflows.** Kanban only. Sprints reserved but not shipped.
- **Time tracking.**
- **Rich-text comments beyond markdown.**
- **Native mobile apps.** Webapp works in mobile browsers; native shell is a follow-up.
- **Attachments as first-class objects.** Attachments go via the artifacts system: publish an artifact, paste the URL into the issue body.
- **Real-time typing indicators, presence.** SSE tail is ~2s cadence.
- **Enterprise SSO, SCIM, RBAC beyond board-member roles.** Board is the trust boundary.

## What "MVP" looks like

1. Public board at a URL you can share.
2. Private board with an invite flow.
3. Issues: create, edit title/body, drag between status columns, assign, label, comment thread.
4. Activity feed per issue and per board.
5. Board settings page: columns, labels, members (add/remove), outbound webhooks.
6. One worked-example integration.
7. Published template artifact for the AI-triage responder script.
8. GitHub link-back template artifact.
9. MCP + REST API covering the core verbs with 4a-JWT auth.

## Roadmap phases

Rough sequencing of the ~95h build across worker-sized tasks:

**Phase 1 — Foundation (this session)**
- Repo scaffold: TS + Hono + Wrangler + Effect + Solid ready to grow into
- Hello-world Worker deployed to `evenflow.work`
- Studio room + tasked backlog

**Phase 2 — Schema + event kinds**
- D1 schema for boards, issues, comments, memberships, webhookRoutes, deliveries
- 4a event kind validators for `30550`–`30554` (plain) and encrypted variants
- Sign-and-publish helpers reusing 4a substrate patterns

**Phase 3 — Auth + JWT verification**
- Reuse `api.4a4.ai/auth/*` OAuth AS
- Server-side `verifyJwt` middleware in the Worker
- Board-membership check helper (audience-declaration lookup)

**Phase 4 — REST API surface (write side)**
- `POST /boards`, `POST /boards/:slug/issues`, `PATCH /issues/:id`, `POST /issues/:id/transition`, `POST /issues/:id/comments`
- All Effect-based, typed error unions, Layer-based DI

**Phase 5 — REST API surface (read side)**
- `GET /boards`, `GET /boards/:slug/issues`, `GET /issues/:id`, activity feed
- SSE endpoint via Durable Object

**Phase 6 — MCP surface**
- `evenflow.work/mcp` with tool schemas mirroring Linear's shape where reasonable
- Auth via OAuth Protected Resource Metadata

**Phase 7 — Webapp scaffolding**
- Solid + Effect app skeleton, editorial design language
- Key management (Web Crypto + IndexedDB)
- Initial paint from Worker, hydrate client-side

**Phase 8 — Board + issue views**
- Kanban / Backlog / Icebox views
- Drag-and-drop (dnd-kit-solid) across columns AND containers
- Issue detail sheet, comment thread, estimate dropdown, velocity rollup

**Phase 9 — Board settings + members**
- Column, label, member management
- Paste-the-pubkey + invite-link flows
- Outbound webhook config UI

**Phase 10 — GitHub link-back responder**
- Template artifact
- PR-chip UI in issue detail

**Phase 11 — Polish**
- Butterflies on card creation, wave loading indicator, empty-state copy
- 404 page, favicon
- Landing page on `evenflow.work`

## Voice + polish

Small details that convert a functional tracker into a product people *notice*.

**Empty states.**
- Empty backlog: *"Nothing on your mind. What are you thinking about?"*
- Empty icebox: *"Cold storage. Thoughts on ice."*
- Empty active board: *"Still waters. What flows next?"*
- Empty search results: *"Nothing surfaced. Try a different current."*
- Empty comments: *"Quiet so far."*

**Micro-copy on container moves.**
- Send to icebox → *"On ice"*
- Promote to backlog → *"Into the queue"*
- Promote to active → *"Into the flow"*
- Move to Done → *"Released"*

**404 page.** *"This page is drifting. Head back to the flow →"*

**Loading indicator.** A subtle pulsing wave, not a spinner. Rotate random text: *"Finding the rhythm…" / "Catching the current…" / "Following the thread…"*

**Velocity sparkline label.** "**The Current**." Says what it is (recent flow of completed work), river metaphor, slightly poetic without being twee.

**Butterflies on card creation.** Every new card: a small butterfly emerges and flutters away. Signature moment. One SVG + a keyframe animation.

**Butterflies on Done, rarer.** ~1-in-30 completions gets a butterfly across the "Done" column. Undocumented; discovered organically.

**Favicon.** A single stylized wave/current mark. No letter, no logo, just the flow shape.

**No focus outlines** on interactive elements (per Evan's global UI preferences).

## Design language + inspiration

Reference: **[era-residence.com/apartments](https://www.era-residence.com/apartments?type=penthouse-duplex)**. A *feel* reference, not a spec.

- Editorial type pairing: dramatic condensed high-contrast display serif + wide geometric sans (Fraunces/Bodoni Moda + DM Sans/General Sans as free candidates)
- Numbers get the serif treatment — velocity readouts, estimate values, board-header counts, "The Current"
- Chamfered card corners (rounded + subtly cut)
- Scroll-driven motion (not clock-driven) via Framer Motion or GSAP `ScrollTrigger`
- Vertical left-rail wayfinding (rotated 90° breadcrumb)
- Dual-mood identity: dark cinematic splash → light editorial interior
- Generous whitespace — the board doesn't need to fit 40 issues on-screen

Explicit non-carryover: era's exact palette, exact fonts, exact botanical decorations. Evenflow may land on a completely different palette. What carries over is *the level of care* — editorial magazine, not enterprise software.

## Name

Locked in 2026-07-28: **Evenflow**, at `evenflow.work`, tagline *The Even Flow of Work.*

The name does triple duty. Kanban was invented at Toyota specifically to smooth the *even flow* of work — WIP limits, pull-based scheduling, the whole thesis. "Evenflow" puts the product's promise right in the name. Separately, it's a Pearl Jam song — which slots the product into the music-adjacent family alongside **Sonata** (personal AI runtime), **Sonar** (messaging), and **Studio** (collaboration surface).

The tagline makes domain + product name one continuous phrase — read `evenflow.work` and the sentence completes itself.
