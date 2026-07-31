# EFB-45 — Unify board filter mechanisms

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-45`

## Scope one-liner

Consolidate the scalar `filterSprintId` prop (Phase 21c) into EFB-44's `matchesFilters(issue, filters, viewer)` predicate. One mechanism instead of two. Mechanical refactor with preserved behavior — the compose tests EFB-44 shipped prove the two play together; replacing scalar-plus-predicate with one predicate should preserve behavior EXACTLY.

## What this is NOT

Explicitly OUT of scope per EFB-44 worker-2's design-doc read: extending sprint filtering to KanbanRail or BacklogView. Both are documented design decisions with reasons named in the code — KanbanRail is deliberately ambient ("sprint membership isn't modelled here — the rail has no sprint sections, so a backlog issue that belongs to a sprint still lists"), BacklogView groups by sprint via `inSprint(sprint)`. A filter mechanism on those surfaces has nothing to do.

Sprint legitimately reaches ONE of five funnels (StatusStack.active), by design. That stays.

## Load-bearing surprises

1. **The five-funnel map from EFB-44 is your reach surface.** Board filters reach five: `StatusStack.active`, `KanbanRail.backlog`, `KanbanRail.iced`, `BacklogView.inSprint`, `BacklogView.unassigned`. Sprint reaches one: `StatusStack.active`. Post-refactor, the sprint component of the predicate ONLY applies to StatusStack.active — the other funnels ignore it. This is preserved behavior, not new.

2. **The Phase 21c sprint scalar chip is separate from EFB-44's chip row.** Its state (`filterSprintId`, `sprintFilterOff()`) lives at BoardPage.tsx. When you fold it into the filters object, you're moving state ownership from a scalar signal to the same shape EFB-44 uses.

3. **EFB-31's `activeSprintFilterId(activeSprint, sprintFilterOff)` shared helper** in `lib/sprints.ts` is what determines what "kanban mode" means. Don't rewrite that logic; use the helper. The predicate reads current sprint filter value from the filters state, but the null-vs-active-vs-off derivation stays in the helper.

4. **Persistence:** filterPersistence.ts (EFB-44) currently persists `mineOnly / assignees / labels`. Sprint filter today is in-memory only (Phase 21c never persisted). Post-refactor, do NOT quietly start persisting sprint — that's a UX behavior change beyond the refactor scope. Options:
   - (a) Keep sprint out of the persisted shape (persistence stays exactly as EFB-44 designed it; sprint refresh-resets, same as today)
   - (b) Persist sprint too (UX behavior change; needs its own product decision)
   - Lean: (a). Refactor should not change user-visible behavior. If we want (b), file it as a separate follow-up.

5. **Compose tests already exist in `boardFilterWiring.test.tsx`.** They prove sprint-filter + other filters intersect correctly. Post-refactor, those tests should pass unchanged — if any break, the refactor changed behavior it shouldn't have.

## Files to touch

| File | Change |
|---|---|
| `web/src/lib/boardFilters.ts` | Extend `BoardFilters` shape with `sprintId: string \| null` component. Update `matchesFilters` to check sprint match when both a. sprintId is set in filters, b. issue is being rendered in StatusStack.active context (the only funnel where sprint reaches) |
| `web/src/pages/board/BoardPage.tsx` | Delete the scalar `filterSprintId` prop. Move sprint filter state into the `filters` object. Chip UI reads from filters. |
| `web/src/pages/board/*View.tsx` (Kanban, Backlog) | Drop the scalar prop; predicate already threaded via EFB-44 |
| `web/src/lib/filterPersistence.ts` | Confirm sprintId is NOT in the persisted shape (lean (a)). If lean (b), add + tests. |
| `web/src/lib/boardFilters.test.ts` | Extend predicate tests to include sprint dimension |
| `web/src/pages/board/boardFilterWiring.test.tsx` | Compose tests SHOULD pass unchanged. If they don't, don't paper over — surface it. |

## Testing

- Existing 207 tests must pass, especially the sprint+filter compose ones from EFB-44
- New tests: sprint-only filter narrows StatusStack.active only; sprint AND assignee filter intersects at StatusStack.active but assignee alone applies elsewhere
- Refresh persistence: mine/assignees/labels restore as before; sprint doesn't (per lean a)
- Full-batch: web tsc unchanged (2 pre-existing), all suites green

## Deploy context

- Prod evenflow at v `05e0a796` (post-EFB-47)
- No backend changes → no D1 migration
- `wrangler deploy` after web build
- Auth via `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` per hard rule

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14`
- Sprint 1: `01e70cc9-0aaa-4ca9-88d4-ea897f42685e`
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`

## Related

- EFB-44 (shipped): the predicate + persistence being consolidated against
- Phase 21c (shipped): the scalar sprint filter being consolidated in
- EFB-31 (shipped): `activeSprintFilterId` helper that determines kanban-mode
- EFB-47 (shipped): read-only mode gating — sprint filter still visible signed-out (per row-guard preserved)

## Coordination points — DM me before

- Persistence lean (a) vs (b) — I've picked (a); confirm you agree or DM to switch
- If the refactor exposes a behavior difference the compose tests don't cover — new tests, don't paper over
- Any change to `activeSprintFilterId` helper (it's shared with the Done window chip)

## DM FLOW — MANDATORY

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. Sona is AFK — replies via channel notifications.
3. Status DMs at meaningful phases: predicate extension, BoardPage state migration, tests-still-green confirmation, pre-deploy.
4. **DO NOT `worker_event_complete` until Sona reviewed AND said shipit.**
5. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Checkpoint caveat

Three parallel dispatches out today. VERIFY CHECKPOINT BY CONTENT. State should say "EFB-45 dispatch". If not, restore from brief committed on origin/main.

## Standing rules

- NO deploy without approval. PR target: `main`. Frontend-only.
- Baseline: 2 root + 1 web pre-existing tsc errors.
