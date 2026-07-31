# EFB-44 — Board view filters (Show my tickets + assignee + label)

Ticket body (`https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-44`) has the full spec. This brief adds worktree/branch/DM-flow context and load-bearing surprises.

## Scope one-liner

Add a filter chip row to the board header. Filter surfaces: "Show my tickets", assignee multi-select, label multi-select. Chips compose (AND). State persists per-viewer in localStorage. Extends the Phase 21c sprint-chip pattern.

## Load-bearing surprises

1. **Phase 21c sprint filter chip is the template.** Find it — probably `web/src/pages/board/BoardPage.tsx` header area. Read its shape (visual affordance, storage persistence, how it composes with rendering) BEFORE inventing new patterns. If the new filters read anything different from what sprint filter reads, that's a design deviation that needs a comment naming why.

2. **Viewer identity comes from `sessionContext` or equivalent — get it right.** "Show my tickets" filter needs `callerPubkey` for the signed-in viewer. Evenflow signs users in via multiple providers; the canonical form is `${provider}:${oauth_id}` (see `src/authz.ts:29`). Filter compares against `issue.assignee_pubkey`, which is now guaranteed canonical post-EFB-38. If viewer is signed out, "Show my tickets" chip should be hidden entirely (nothing to filter for).

3. **Filters are client-side over already-loaded issues.** Do NOT add server-side filter query params in this ticket — pagination + SSE already load enough data for the current scale. Per-column pagination (Phase 21c) may need consideration if filtering hides everything in a paginated window; verify empirically.

4. **Multiple views: Kanban, Backlog, Icebox all need filters.** Sprint archive is history-scoped — skip filters there for now, or add if it composes cleanly.

5. **"Unassigned" is a first-class filter option in the assignee picker.** Not the empty state. Passes through as `assignee_pubkey === null`.

6. **EFB-37 (card null placeholders) is in the same sprint but not yet fixed.** If you land before EFB-37 does, the "Unassigned" filter option might visually look inconsistent because cards with null assignee show no placeholder. Note in PR, don't block on EFB-37.

## Files to touch

| File | Change |
|---|---|
| `web/src/pages/board/BoardPage.tsx` | Add filter chip row to header (below existing sprint chip); wire filter state to issue render |
| `web/src/lib/boardView.ts` (or similar pure helpers module) | Pure filter predicate functions — `filterByAssignee`, `filterByLabels`, `matchesFilters(issue, filters, viewer)` |
| `web/src/lib/theme.css` | New `.filter-chip` styles matching `.sprint-chip` visual |
| `web/src/components/AssigneePicker.tsx` (new or extend existing dropdown) | Multi-select picker reading `boardMemberCache` via existing API. Reuse the assignee-set dropdown pattern if one exists (`IssueSheet.tsx` has one). |
| `web/src/components/LabelPicker.tsx` (new) | Multi-select picker reading `board.labels` |
| `web/src/lib/filterPersistence.ts` (new) | localStorage read/write keyed by `board_id + viewer_pubkey` |
| Tests | `web/src/lib/boardView.test.ts` — extend with filter tests: "my tickets" hides others; label AND assignee compose; sprint filter + these compose; signed-out has no "my tickets" chip |

## Where things live

- Sprint filter chip (Phase 21c template): grep `web/` for "sprint-chip" or "SprintFilter"
- Assignee dropdown pattern: `web/src/components/IssueSheet.tsx` (Phase 27 EFB-27 shipped one)
- Board API for members: `GET /api/v0/orgs/:org/boards/:slug/members` returns `{members: [{pubkey, role, …}]}` — pubkeys are canonical `provider:oauth_id`
- `sessionContext` / viewer pubkey source: grep `web/` for `callerPubkey` or `viewerPubkey` or `sessionKey` — probably in a session store

## Testing

- Fresh board load, filters off → all issues render (baseline).
- Toggle "Show my tickets" as signed-in user → only own-assigned issues render, others hidden with no layout shift.
- Compose "my tickets" + label filter → intersection narrows correctly.
- Refresh page with filters on → localStorage restore, chips still highlighted.
- Signed-out viewer on public board → no "Show my tickets" chip visible.
- Sprint filter chip + assignee filter → both compose without stomping each other.
- Kanban, Backlog, Icebox views all honor the filters.

## Deploy context

- Prod evenflow at v `f58d2bc7` (EFB-38).
- No backend changes → no D1 migration, no wrangler deploy of the worker — this is web-only. But web assets DO deploy via `wrangler deploy` because they're in the assets binding.
- Full deploy sequence: `cd web && npm run build` → `git status` clean → `wrangler deploy` (auth via `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` per hard rule).

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14` (`@evan108108/evan-s-flow-board`)
- Sona pubkey (canonical, for the "Show my tickets" viewer test): `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- Evan pubkey (canonical, second-viewer test): `google:104509077344032735108`
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey` (persistent, no expiry)

## Related

- Phase 21c (shipped): sprint filter chip — model
- EFB-37 (open, same sprint): card null placeholders — improves "Unassigned" filter visual
- EFB-38 (shipped): canonical identity form — this ticket relies on assignee_pubkey being canonical

## Coordination points — DM me before

- Any design deviation from the Phase 21c sprint-chip pattern.
- If localStorage key shape needs to differ from sprint filter's.
- If you find the viewer-identity source unclear or if signed-out state handling needs a call.

## DM FLOW — MANDATORY, DO NOT SKIP

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions. Don't guess on scope.
2. **Status DMs at meaningful checkpoints** — after reading the sprint-chip template, after wiring the "my tickets" toggle, after full filter compose works.
3. **DO NOT call `worker_event_complete` until DM-reviewed and shipit received.**
4. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Standing rules

- NO deploy without approval. Evan is AFK — approval routes through me.
- PR target: `main`.
- Frontend-only ticket; do NOT touch `src/routes/`, `src/lib/audience/`, or the substrate paths.

## Non-goals

- No server-side filter query params.
- No saved-filter presets ("my open bugs" named views) — follow-up.
- No filter-by-column (columns ARE the grouping).
