# EFB Polish Batch 2 — EFB-34 + EFB-35 + EFB-37

Three small tickets bundled for efficient DM-review — same pattern as the successful EFB-25/26/27/28 batch.

## Tickets

1. **EFB-34** (1pt) — SSE BoardEvent mirror drift in `web/src/effects/SseStream.ts`. Full spec: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-34`
2. **EFB-35** (1pt) — DbMock fail-loud on ambiguous prefix match. Full spec: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-35`
3. **EFB-37** (1pt) — Card consistency — placeholder for missing estimate + unassigned. Full spec: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-37`

## Suggested order

1. **EFB-34 first** (SSE mirror) — smallest surface (one file), Option 3 from the ticket (compile-time assertion) is the cheapest and lands the pattern. Sets up cleanly-typed union for future work.
2. **EFB-35 second** (DbMock) — test-infra change. May surface pre-existing latent test bugs when ambiguous matches start throwing; disclose them, don't silently fix.
3. **EFB-37 last** (card null placeholders) — pure CSS/component polish. Do NOT introduce interaction affordances; placeholders are visual-quiet signals of "field exists but empty."

Each ticket gets its own commit for clean revert. DM after each.

## Load-bearing surprises

1. **EFB-34: Solid workspace layout.** The web app is Solid, not React. Type imports may need adjusting between worker and web namespaces. If there's no shared package boundary, the "delete mirror + shared import" option isn't clean — favor Option 3 (compile-time assertion).

2. **EFB-35: existing tests may rely on the silent-swallow ordering.** When the fail-loud check lands, a few tests likely fail as pre-existing latent bugs. Disclose in the PR; don't quietly reorder handlers to make them pass without noting why.

3. **EFB-37: two card components.** Horizontal Kanban card + Vertical Kanban card (Phase 79's two-column layout). Verify both surfaces get the placeholder treatment consistently. `grep` for `assignee_pubkey` in `web/src/components/` to find them.

4. **All three: pure UI/test-infra work.** No backend, no substrate, no migrations. `wrangler deploy` will ship the web assets, but no D1 apply.

## Files to touch

| Ticket | File | Change |
|---|---|---|
| EFB-34 | `web/src/effects/SseStream.ts` | Add compile-time assert that the local `BoardEvent` mirror equals the worker's canonical `BoardEventKind` union — see ticket Option 3 |
| EFB-34 | worker-side `BoardEvent` type | Verify export path so a type-only import works from `web/` |
| EFB-35 | `tests/dbMock.ts` | Extend match algorithm — scan ALL registered handlers, throw on ambiguous match with a helpful message |
| EFB-35 | Any existing tests that break | Fix root cause + disclose in PR; do NOT reorder to paper over |
| EFB-37 | `web/src/components/*Card*.tsx` (horizontal + vertical variants) | Render muted `—` in the estimate slot when null; render muted dashed-circle placeholder in the avatar slot when unassigned |
| EFB-37 | `web/src/lib/theme.css` | Add `.card-placeholder` styles matching the existing muted vocabulary |

## Testing

Per ticket:
- EFB-34: intentionally break the mirror (add a member to worker union without adding to web mirror) → tsc goes red. Restore, tsc clean.
- EFB-35: add two handlers with overlapping prefix → tests fail with the fail-loud message. Reorder → passes.
- EFB-37: Kanban view with mixed cards (some estimated, some not; some assigned, some not) — verify column-scan rhythm is consistent.

Full suite green. tsc clean bar the 2 known pre-existing errors.

## Deploy context

- Prod evenflow at v `f58d2bc7` (EFB-38).
- All three tickets are UI + test-infra. `wrangler deploy` ships web assets after `cd web && npm run build`. No D1 touched.
- **DO NOT DEPLOY without DMing me** — Evan is AFK, approval routes through me.

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14` (`@evan108108/evan-s-flow-board`)
- Sona pubkey (canonical): `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`

## Related

- EFB-25/26/27/28 (shipped): the batch model.
- EFB-38 (shipped): identity refs — impacts EFB-37 in that the "Unassigned" placeholder makes null-assignee cards look coherent, which the coming EFB-44 filter feature (also in Sprint 1) will lean on.
- EFB-44 (in flight parallel): board view filters — you and that worker should stay out of each other's file diffs; if EFB-44 also touches Card components, coordinate via DM.

## Coordination points — DM me before

- Any change to worker-side `BoardEvent` union shape (EFB-34).
- If EFB-35's fail-loud change surfaces >3 pre-existing test failures, DM before fixing — I want to see the list first.
- Any interaction affordance added to the EFB-37 placeholders (they should be visual-quiet, no click behavior).

## DM FLOW — MANDATORY, DO NOT SKIP

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. **Status DMs after EACH ticket.** Not batch-review at the end; per-ticket keeps the discipline.
3. **DO NOT call `worker_event_complete` until DM-reviewed for the full batch AND shipit received.**
4. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Standing rules

- NO deploy without approval.
- PR target: `main`.
- Commit granularity: one per ticket. Batch-level PR opened after all three land in the branch.
