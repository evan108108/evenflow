# EFB-17 — POST /sprints/:id/add-issue should auto-promote container when sprint is active

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-17`

## Scope one-liner

Symmetry gap in the phase-21 sprint model. **START-sprint** promotes any planned member to active. **ADD-to-active-sprint** sets `sprint_id` but does NOT promote container, so the card technically joined the sprint but is invisible on Kanban (still on Backlog Sprint section). Fix: in `POST /sprints/:id/add-issue`, if the target sprint is `state=active` AND the issue is `container=backlog` (NOT `iced` — icing explicitly says "not now"), promote to `container=active` in the same transaction. Emit `issue.container_changed` alongside the existing `issue.updated`.

## Load-bearing surprises

1. **`iced` is not `backlog`.** Icing an issue is an explicit "not now" signal. Even if a user adds an iced issue to an active sprint (weird but legal), the container stays `iced`. The auto-promote is only for `container=backlog`.

2. **The emit event kind order matters.** Emit `issue.updated` FIRST (existing behavior), then `issue.container_changed` (new). Consumers reading the SSE tail expect the mutation to appear before its side-effect.

3. **Transaction scope.** The container promote MUST be in the same transaction as the sprint-membership write. Half-committed state (sprint set, container not promoted) would create the exact same bug we're fixing, silently.

4. **Boundary Discipline touched.** `POST /sprints/:id/add-issue` reads its body — check whether it's already migrated through `parseRouteBody`. If not, migrate it as part of this ticket (the new promote logic gives it a natural body-parse touchpoint), and the `check:boundary` ratchet moves from 4→5. If it is, ignore.

5. **Repro from dogfood 2026-07-30:** Sona added EFB-10/11/12/16 to Sprint 1 via API; Evan didn't see them on Kanban until an explicit `promote_to_active` was fired for each. This is the bug's actual field manifestation.

## Files to touch

| File | Change |
|---|---|
| `src/routes/sprints.ts` `POST /sprints/:id/add-issue` handler | Add: if `sprint.state === 'active'` AND `issue.container === 'backlog'`, update `container = 'active'` in same transaction. Emit `issue.container_changed`. |
| `src/routes/sprints.ts` schema (if migrating through parseRouteBody) | Follow EFB-54 pattern; look at PATCH /issues/:id for shape-only + authz split. |
| Test file for `POST /sprints/:id/add-issue` | Add: adding iced issue to active sprint → container stays iced; adding backlog issue to active sprint → container promoted, container_changed emitted; adding backlog issue to planned (non-active) sprint → container stays backlog. |

## Where things live

- Sprint state machine: `src/routes/sprints.ts` `POST /sprints/:id/start`
- Container field: `src/shapes.ts` `IssueShape.container` — values are `backlog`, `active`, `iced`
- Emit: `src/audiences.ts` `emitSecureBoardEvent`
- Board event vocabulary: `src/durable-objects/board-events.ts:26-42` — `issue.container_changed` is already a first-class kind, don't invent

## Testing

- `npm test` full suite green
- New unit tests per surprise #1 and #2
- `npm run check:boundary` — if you migrated through parseRouteBody, moves from 4→5
- tsc baselines held (2 root + 1 web pre-existing)

## Deploy context

- Prod evenflow at `d89f5aec` post-EFB-13/60
- No D1 changes
- Standard evenflow deploy: `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` (Global-API-Key path via `CLOUDFLARE_EMAIL`+`CLOUDFLARE_API_KEY` env, NOT `CLOUDFLARE_API_TOKEN`)
- `git status` before deploy (hard rule)

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14` (@evan108108/evan-s-flow-board)
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login`

## Related

- EFB-22 (shipped): sprint tide — this is a sibling in the phase-21 completion set
- EFB-54 (shipped): Boundary Discipline — mandatory if migrating body through wrapper
- EFB-31 (shipped): Done column unbounded — sibling phase-21 fix

## Coordination points — DM me before

- Whether to migrate through parseRouteBody as part of this ticket (surprise #4 — yes if unmigrated, no if already through)
- If you find a third container state I don't know about (should only be backlog/active/iced)
- Pre-deploy

## DM FLOW — MANDATORY, DO NOT SKIP

You are working under a strict DM-review protocol. This is not optional:

1. **DM me with any questions or concerns.** Do not guess on scope.
2. **Give status updates via DM at meaningful checkpoints.** At minimum: after code change, after tests pass, before deploy.
3. **DO NOT complete the task (worker_event_complete) until you have DMed me for review AND I have returned my review response.**
4. Use `dm_send` targeting session `session-f4e8ed22897d418a` (that's me) or `dm_reply` with a message_id if replying to one of my DMs.

## Checkpoint caveat

Multiple parallel dispatches may be out. Restore by `checkpointId` (Sonata core has EFB-48's fix live). Verify state names "EFB-17 dispatch" — if not, DM Sona immediately.

## Standing rules

- NO deploy without approval.
- Baseline: 2 root + 1 web pre-existing tsc errors.
- Read `docs/BOUNDARY_DISCIPLINE.md` if you touch a route body.
