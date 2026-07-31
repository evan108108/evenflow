# EFB-25 / 26 / 27 / 28 — UI Polish Batch

Four small tickets, one worker, sequential DM-reviewed. **Nothing here touches the substrate, the gateway, or Sona's dogfood board's data.** All work is UI + one existing backend endpoint.

## The four tickets

| Ticket | Estimate | Scope |
|---|---|---|
| EFB-25 · TideBadge tooltip | 1 pt | Add a real explanatory tooltip to the tide chip |
| EFB-26 · Delete or mark-as-duplicate | 2 pt | UI affordance for existing DELETE endpoint + new duplicate-of field |
| EFB-27 · Sprint dropdown in IssueSheet | 2 pt | Assign/unassign to any sprint from the ticket detail |
| EFB-28 · Backlog/Icebox open-in-place | 1 pt | Bug: opening a ticket from Backlog jumps to Kanban |

Ticket bodies (already filed) have the full spec — fetch them via `GET /api/v0/issues/EFB-25` etc. before starting each one.

## Load-bearing surprises

1. **`TideBadge` already has a `title` attribute** at `web/src/components/TideBadge.tsx:150` (`title={title()}`). The tooltip infrastructure is wired — just need to expand the `title()` computed value to include the semantic explanation, not just numbers. Do NOT re-invent a tooltip component if `title` is sufficient. Evenflow doesn't have a dedicated tooltip component today; check whether the design language wants one before adding one.

2. **The assignee `<select>` at `IssueSheet.tsx:359-363` is the exact template for the sprint dropdown.** Reads `props.issue.assignee_pubkey`, PATCHes on change. Copy the pattern.

3. **BacklogView passes `onOpen={props.onOpen}` to `IssueCard`** (`web/src/pages/board/BacklogView.tsx:120,199`). The nav bug is somewhere in how the parent (BoardPage) wires the `onOpen` prop. Look at `BoardPage.tsx:110` (`const openIssue = createMemo(...)`) — the query-string-driven openIssue setup may be swapping view state. Fix: setting the open issue should NOT change view mode. View state (kanban vs backlog vs icebox) must be preserved across sheet open/close.

4. **DELETE endpoint already exists** at `src/routes/issues.ts:801` (`issues.delete("/issues/:id", ...)`). No backend work for EFB-26's delete side. For the duplicate-of side: needs schema migration (nullable column on issueCache), API PATCH, UI. Bigger than the delete part — do delete FIRST as a standalone commit.

5. **Sprint add-issue / remove-issue endpoints exist** at `src/routes/sprints.ts:721` (`membershipEndpoint("add-issue", ...)` and `"remove-issue"`). Path: `POST /boards/:slug/sprints/:id/add-issue` with body `{issue_id}`. The org-scoped variant works too: `POST /orgs/:org/boards/:slug/sprints/:id/add-issue`. Add-issue on an active sprint AUTO-PROMOTES the container to active (Phase 21b symmetry) — don't manually flip the container.

6. **Sona's dogfood board is PRIVATE** (`visibility: private`, `audience_pubkey` set). Everything on this board goes through the encrypted-wrap path. For UI testing this doesn't matter, but for anything that touches SSE echo suppression, remember the payload comes back as `{enc: true, ciphertext: null}` and clients refetch via REST.

## Files to touch

| File | Ticket | Change |
|---|---|---|
| `web/src/components/TideBadge.tsx` | EFB-25 | Expand `title()` to include semantic explanation |
| `web/src/components/IssueSheet.tsx` | EFB-27 | Add sprint `<select>` mirroring the assignee `<select>` pattern |
| `web/src/components/IssueSheet.tsx` | EFB-26 | Add "Delete" affordance (danger button + confirm) |
| `web/src/pages/board/BoardPage.tsx` | EFB-28 | Ensure opening issue sheet doesn't change view mode |
| `web/src/pages/board/BacklogView.tsx` | EFB-28 | (maybe) sanity-check onOpen wiring |
| `web/src/effects/ApiClient.ts` | EFB-27 | Nothing new — existing PATCH + sprints endpoints suffice |
| `migrations/0022_duplicate_of.sql` | EFB-26 | NEW — nullable `duplicate_of` column on issueCache (only if you get to the duplicate side) |
| `src/shapes.ts` | EFB-26 | Add `duplicate_of` field to IssueShape (only for duplicate side) |
| `src/routes/issues.ts` | EFB-26 | Extend PATCH to accept `duplicate_of` (only for duplicate side) |

## Where things live

- **API client**: `web/src/effects/ApiClient.ts` — handles auth, JSON, 401 handling. PATCHes go through `client.patch<T>(path, body)`.
- **Store**: `web/src/pages/board/store.ts` — `patchIssue`, `noteLocalMutation` (echo suppression), `refetchIssues`.
- **Sprint list source**: fetched from `/boards/:slug/sprints` — see `store.ts` for how it's cached.
- **DELETE issue flow**: DELETE `/api/v0/issues/:id`. Cascades commentCache. Returns `{deleted: true}` on success.
- **Design tokens**: `web/src/lib/theme.css` — chamfer radius, ink navy, cream, danger color (add if none — probably `#a64444` or similar).

## Testing

Per ticket:
- **EFB-25**: hover the TideBadge in a browser → tooltip appears with (a) semantic explanation (b) current numbers. Both sprint mode and kanban mode. Reduced-motion respect isn't needed for a tooltip.
- **EFB-26 (delete)**: open a test ticket in the sheet, click Delete, confirm, verify (a) modal closes (b) ticket vanishes from column (c) SSE fires so other clients update.
- **EFB-27**: open a ticket in sheet, change sprint via dropdown, verify (a) API returns 200 (b) SSE fires (c) reopening the sheet shows the new sprint value (d) "— None —" removes the ticket from the sprint.
- **EFB-28**: on Backlog view, click a card → sheet opens WITH Backlog still visible behind it. Close sheet → still on Backlog. Same for Icebox.

Also run `npm test` in both `web/` and root. Both should stay green. `tsc --noEmit` should have zero new errors (the two pre-existing test-file errors are known and left alone).

## Deploy context

- **DO NOT DEPLOY WITHOUT DMing me first.** Prod is at evenflow.work version `76b4099d`. Any deploy must go through Sona (me) after DM-review.
- **Frontend build**: `cd web && npm run build` — writes to `../dist/web/`.
- **Deploy**: `set -a; source /Users/evan/projects/4a/.env; set +a && cd /Users/evan/projects/evenflow && wrangler deploy`.
- **Migration 0022** (if you touch the duplicate-of side): apply locally FIRST (`npm run d1:migrate:local`), NEVER to prod without me approving. Prod D1 apply is `npm run d1:migrate:remote`.

## Key IDs

- Board id: `4042afb7-d1fe-4a80-a311-9de404b0ee14`
- Board slug: `evan-s-flow-board` (under org `evan108108`)
- Sprint 1 id: `01e70cc9-0aaa-4ca9-88d4-ea897f42685e`
- Sona's pubkey: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT for API: `mem_secret_get evenflow_login`

## Ticket UUIDs

- EFB-25 (tooltip): `da63c0a2-5c63-44ff-a814-261012ac5e53`
- EFB-26 (delete/dup): `f054f1da-2ac9-455c-a05d-785c9cefebd9`
- EFB-27 (sprint dropdown): `31a2c3ad-c1a5-42e7-abf1-a05ae7c2a2c4`
- EFB-28 (open-in-place): `9a5770bc-6fb1-4c51-a7d7-e774070ee995`

## Related work

- **EFB-22 (Sprint tide)** — just shipped. TideBadge is the component EFB-25 touches. Full context in `docs/plans/efb-22-tide-context.md`.
- **EFB-24 (Plaintext substrate publish)** — gated on EFB-22 verification. Not this batch.

## Coordination points — DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`) before:

- Any wrangler deploy.
- Any prod D1 migration apply.
- If EFB-26 tooltip design goes beyond `title=` (native browser tooltip). We haven't invested in a Tooltip component — that's a design conversation, not code.
- If the EFB-28 fix requires changing the query-string schema for opening issues (deep-link URLs stay working — anyone who bookmarked `?issue=EFB-22` from Backlog still lands on Backlog).
- Between each ticket. Land tooltip → DM me for review → next ticket. Don't batch all four into one review.

## Suggested order

**UPDATE 2026-07-30 23:40 UTC**: EFB-25 already shipped by prior worker (commit `3ad548e` on branch `efb-ui-polish`, worktree `/Users/evan/projects/evenflow-efb-polish`). Sonata was restarted; that worker's process died mid-EFB-27. Nothing uncommitted in worktree — clean state. Fresh worker picks up from here.

**Approved decision on EFB-28** (from the prior worker's investigation before they died): the root cause is NOT in `openIssue = createMemo(...)` at BoardPage.tsx. It's the view() derivation from `location.pathname` (endsWith("/backlog") / "/icebox" / else "kanban") combined with `onOpen={(id) => navigate(base()/issues/${id})}`. Navigating to `/issues/EFB-XX` drops the view suffix, so view() falls to kanban. Same on onClose. Fix: Option A — nest `/backlog/issues/:ref` and `/icebox/issues/:ref` alongside `/issues/:ref`. onClose returns to whichever view you came from. Old bookmarks stay valid, defaulting to kanban.

Remaining order:

1. **EFB-28** (open-in-place bug, 1pt) — Option A routing approved above.
2. **EFB-27** (sprint dropdown, 2pt) — copy the assignee `<select>` pattern.
3. **EFB-26 delete side** (part of 2pt) — small.
4. **EFB-26 duplicate side** (part of 2pt, optional if time-boxed) — schema + PATCH + UI. If it's ballooning, ship just the delete side and file a follow-up for duplicate.

## Non-goals

- No new tide feature work. EFB-22 shipped separately.
- No touching `evan-s-flow-board`'s existing issues. Use a test ticket you create (or update an old test ticket like EFB-5).
- No gateway or 4a substrate changes.
- No auth/session changes.
