# EFB-31 — Kanban Done column grows unbounded on no-sprint boards

Ticket body: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-31`

## Scope one-liner

Extend `done_window_days` to gate Done column RENDERING (not just tide-metric math). Add a chip in the board header matching the sprint filter chip pattern to lift the window when needed.

## Load-bearing surprises

1. **Investigation step is part of the ticket.** As of filing, unknown whether `done_window_days` already filters the Done column display or only feeds the tide metric. Step one: read the current Done column render path in `web/src/pages/board/` and determine which. If it ALREADY filters, this ticket is smaller (just add the "show older" chip). If it doesn't, this ticket does both (filter + chip).

2. **Sprint-mode boards must NOT regress.** When a board has an active sprint AND the sprint filter chip is on (Phase 21c), the sprint's own Done window governs. `done_window_days` only kicks in for kanban-mode (no active sprint OR sprint chip off). Do NOT double-filter or the Done column goes empty on sprint boards.

3. **The `done_window_days` schema field already exists on every board** (default 14). Verify by reading `src/shapes.ts` — should be in `BoardShape`. If not, you have wider work.

4. **Filter chip pattern is established by Phase 21c sprint chip + EFB-44 filter chip row.** New chip should compose visually with those. Header row is already the home for filter chips; add the "done window" chip there. Label something like "Done · 14d" (or "Done · showing all" when lifted).

5. **Chip lift semantics — my lean:**
   - Default state: chip shows `Done · Nd` (where N = `done_window_days`), highlighted with the muted "active filter" vocabulary
   - Click: lift to "show all" — chip changes to `Done · all`, brighter to indicate a wider view is on
   - Click again: return to windowed
   - Persist per-viewer in localStorage using EFB-44's `filterPersistence.ts` (same infrastructure — the "show all" toggle IS a filter state)

## Files to touch

| File | Change |
|---|---|
| `web/src/pages/board/BoardPage.tsx` or wherever Done column is composed | Add `done_window_days` filter to Done column render on kanban-mode boards |
| `web/src/pages/board/BoardHeader.tsx` (or wherever filter chips row lives, post EFB-44) | Add "Done window" chip |
| `web/src/lib/filterPersistence.ts` (from EFB-44) | Extend the persisted filter shape with `doneWindowLifted: boolean` |
| Tests | Kanban-mode board with mixed done-timestamps: default state hides older-than-window, chip-lift shows all |

## Where things live

- `done_window_days` field in `src/shapes.ts` (`BoardShape`)
- Sprint filter chip pattern (Phase 21c): grep `sprint-chip`, `sprint-badge` — likely `web/src/lib/board.css` and `BoardHeader`
- EFB-44 filter chip row: `boardFilterWiring.test.tsx` + `filterPersistence.ts` show the model
- Done column render logic: grep for `column.category === "done"` in `web/src/pages/board/`

## Testing

- No-sprint board (or sprint filter off) with 20+ done issues across 30 days:
  - Default state: only within-14-day items in Done column
  - Click chip → show all → older items appear
  - Click chip → windowed → older items hidden again
  - Refresh page: chip state persists
- Sprint-mode board (evan-s-flow-board with Sprint 1 active): no regression, sprint filter still governs Done
- Signed-out: chip visible + functional (EFB-47's read-only mode work may or may not have landed by now — coordinate)

## Deploy context

- Prod evenflow at v `625e962c` (post EFB-44).
- No backend changes. `wrangler deploy` after web build.
- Auth via `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` per hard rule.

## Key IDs

- Board (sprint-mode): `4042afb7-d1fe-4a80-a311-9de404b0ee14` (@evan108108/evan-s-flow-board) — verify no regression here
- No-sprint public board: `97d96cac-85cb-4eec-b974-e92b59da2c78` (tide-test-public) — HAS EFB-29 hang, may be unusable for verification. If so, create a temporary no-sprint board for smoke.
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`

## Related

- EFB-44 (shipped): filter chip row + persistence infrastructure to extend
- EFB-22 (shipped): tide uses `done_window_days` as the virtual sprint for kanban-mode boards; this ticket extends that field to also govern rendering
- EFB-47 (in flight parallel): read-only mode for signed-out visitors — if the "Done window" chip is interactive, decide whether signed-out viewers can lift it

## Coordination points — DM me before

- If investigation finds `done_window_days` already gates rendering AND a "show older" affordance already exists — different ticket, DM to confirm scope.
- If the chip design deviates from Phase 21c / EFB-44 visual vocabulary.
- Any change to the tide metric behavior (should not need it, but flag if you find you do).

## DM FLOW — MANDATORY

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. Sona is AFK; replies via channel notifications, may lag.
3. Status DMs after: (a) investigation finding, (b) filter implementation, (c) chip UI, (d) persistence, (e) before deploy.
4. **DO NOT `worker_event_complete` until Sona reviewed AND said shipit.**
5. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Checkpoint caveat

Multiple parallel dispatches from Sona's session may cause checkpoint clobber (EFB-48). VERIFY YOUR CHECKPOINT BY CONTENT. State should say "EFB-31 dispatch". If not, restore via brief committed on origin/main.

## Standing rules

- NO deploy without approval. PR target: `main`. Frontend-only.
- Baseline: 2 root + 1 web pre-existing tsc errors.
