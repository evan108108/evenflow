# EFB-14 — Search MVP (SQLite FTS5 over issueCache + commentCache)

Ticket: `https://evenflow.work/api/v0/issues/EFB-14`

## Scope — MVP, not full feature

Ticket body says "punt to conversation before writing code." Sona's swing per Evan: **ship the MVP that most of that conversation would land on**:

- **SQLite FTS5** index over `issueCache.title`, `issueCache.body`, `commentCache.body` — the ticket body names this as "cheap and shipable within the Worker + D1 setup." Yes.
- **Board-scoped default** — search within the current board. Cross-board comes later; the ticket's cross-board-vs-scoped question doesn't need to block MVP.
- **Viewer-membership filter** — for private boards, only members see private-board hits. Same authz posture as EFB-24's substrate-publish gate.
- **BM25 ranking** — FTS5 default, no custom tuning.
- **NOT indexing private-board bodies at rest by default** (they're encrypted per the ticket's kind-30556 question). If you find they ARE indexable at rest as plaintext today, DM me before deciding — that's a design question with privacy implications.
- **Filters: nothing beyond board scope in MVP.** No type/status/assignee/sprint/has_pr/container filters — those are follow-up. MVP is text-in → matches-out, board-scoped.

## What to touch

- Migration N+1 — add FTS5 virtual tables `issueCacheFts` + `commentCacheFts` mirroring the fields, with triggers to keep in sync on insert/update/delete
- Backfill — populate the new FTS tables from existing rows (idempotent, safe to re-run)
- `POST /api/v0/boards/:slug/search` — via `parseRouteBody` per Boundary Discipline. Accepts `{q: string}` + optional `{limit: number}`. Returns `{issues: [...], comments: [...]}` sorted by BM25 rank, with membership-filter applied.
- `web/src/components/BoardSearch.tsx` (or minimal — a search box in the header, results in a dropdown or side panel; use whatever ships fastest and looks clean)
- Unit tests: FTS index round-trip; ranking works; membership filter excludes non-member results on private boards

## What NOT to build in this MVP

- Cross-board search (that's a follow-up ticket if useful)
- Filter chips (assignee/type/status/sprint/etc.)
- Search-inside-private-body if it's currently encrypted-at-rest (DM before touching)
- Recency-boost or assignee-is-you boost (defaults are BM25)
- Search history, saved searches, auto-complete
- Fuzzy matching beyond what FTS5 gives by default

## Testing

- Unit tests for FTS round-trip + ranking
- Integration: POST `/boards/tide-test-public/search {"q": "test"}` returns matches from that board only
- Auth: query a private board signed-out or non-member → 403 or empty (whichever the endpoint's existing convention is)
- Baseline: 2 root pre-existing + 0 web = 2. Baseline HELD.
- `check:boundary` clean; new route uses `parseRouteBody`

## Deploy

- Migration LOCAL first, DM me before prod apply (`wrangler d1 migrations apply --remote`)
- Standard evenflow deploy per hard rule
- Prod at `3997aa2a`
- Backfill runs once post-migration; verify FTS tables have expected row count matching the source tables

## Coordination — MANDATORY DM points

- **Post-brief-read**: your read of whether private-board bodies are currently indexable at rest (plaintext vs encrypted-at-rest) — this is the design question that could block MVP scope
- Pre-migration prod apply
- Pre-deploy always
- Post-deploy smoke against tide-test-public with a real query

## Standing rules
- Use `parseRouteBody` per Boundary Discipline (EFB-54)
- `mem_secret_get` via MCP for secrets, not CLI
- Own worktree: `git worktree add ../evenflow-efb-14 -b efb-14-search-mvp off origin/main`
- No shared-checkout git ops
- Session `session-f4e8ed22897d418a`
