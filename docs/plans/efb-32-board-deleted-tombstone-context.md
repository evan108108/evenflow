# EFB-32 — board.deleted tombstone (emit-before-delete)

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-32`

## Scope one-liner

Public boards published a 30550 (KanbanBoard) event when created/updated (EFB-24). Deleting a public board today leaves the last 30550 live on the substrate — a replaying consumer would resurrect the board. Fix: add `board.deleted` to the BoardEventKind vocab AND change the board delete route to emit-then-delete (not delete-then-emit) so the tombstone actually fires.

## Load-bearing surprises

1. **Naive `board.deleted` emit would be silently swallowed 100% of the time.** The fork inside `emitSecureBoardEvent` re-reads the board to decide whether it may publish. By the time a delete handler emits, the row is gone and the read fails closed. That's why EFB-24 explicitly deferred this ticket — a working tombstone requires emitting BEFORE the row delete, which is a delete-ordering change, not just a new event kind.

2. **The tombstone shape:** publish 30550 at the board's own address (replaceable-event address is `<kind>:<pubkey>:<d_tag>`) with a `["fa:deleted", "true"]` tag on the entity's own address. Replaceable events mean the tombstone AT THE SAME ADDRESS supersedes the last live event. A tombstone at a different address leaves the last live version standing.

3. **Ordering + transactional shape is the meat.** Options:
   - (a) Publish first, delete second. If delete fails, the substrate has a tombstone for a board that still exists in D1. That's a false-tombstone — worse than the current state, arguably.
   - (b) Delete first, publish second. Original bug — publish fails-closed because the row is gone.
   - (c) Transaction: begin, delete row, publish, commit if publish succeeds, rollback if not. Cloudflare Workers doesn't have transactional D1 in the classic sense, but there's a batch API. Verify.
   - (d) Two-phase: mark row as "pending delete" (soft delete), publish tombstone, hard-delete on publish success. Extra column, more state, but explicit failure modes.
   
   My lean: (c) if D1 batch supports it cleanly. If not, (d) — a soft-delete column is honest about the failure mode ("this board is pending tombstone; retry or admin cleanup"). DM me the design pick before implementing.

4. **This pattern likely applies to other delete paths** that should tombstone. `issue.deleted` and `comment.deleted` from EFB-24 already work correctly because those emit tombstones AT the entity's address BEFORE the D1 delete — worker-4's implementation deliberately handled that. `board.deleted` is the exception because board deletion cascades (deleting a board deletes issues and comments too, and the current order is wrong). Look at how issue.deleted and comment.deleted work; the pattern is there.

5. **Cascade concern.** Board delete cascades to issues + comments. Do those cascades also need tombstones on their own kinds (30551 for issues, 30552 for comments)? Or does the parent tombstone (30550 with fa:deleted) implicitly cover them? DESIGN CALL. Simpler pattern: tombstones only at the immediate deleted entity's address; parent's tombstone doesn't imply child tombstones — a consumer replaying could see live issues/comments under a dead board. Cleaner pattern: tombstone every deleted entity, in cascade order (children first, then parent). More events, more correct.
   
   Lean: cleaner pattern. Tombstone every deleted entity in cascade order. Complexity is manageable; correctness is worth it.

## Files to touch

| File | Change |
|---|---|
| `src/durable-objects/board-events.ts` | Add `board.deleted` to BoardEventKind |
| `src/lib/audience/audience-events.ts` | Add `buildKanbanBoardDeleted` (or extend `buildKanbanBoard` to accept a `deleted: true` flag) |
| `src/audiences.ts` | Add `board.deleted` to `publicKindOf` map; wire the fork to publish tombstone at the board's own address |
| `src/routes/boards.ts` | Board delete handler: change ordering to emit-then-delete (or transactional per design pick). Include cascade tombstones for issues + comments if lean-cleaner-pattern is chosen. |
| `gateway/src/kanban-plaintext-validator.ts` | Update the 30550 validator to accept a `fa:deleted` tag; add tests for tombstone shape |
| Tests | Delete a public board → 30550 tombstone lands + last live 30550 superseded + (if lean-cleaner) cascade tombstones for issues + comments |

## Where things live

- `emitSecureBoardEvent` fork gate: `src/audiences.ts`
- `publicKindOf` + `stampTargetOf` maps: `src/audiences.ts` (post-EFB-24)
- Board delete route: `src/routes/boards.ts`
- Issue.deleted + comment.deleted patterns: `src/routes/issues.ts` + `src/routes/comments.ts` — READ THESE FIRST to see how they solved the same problem
- Gateway validator: `gateway/src/kanban-plaintext-validator.ts`

## Testing

- Delete a public board → 30550 with `fa:deleted` tag at the board's own address → gateway accepts → a subsequent query for the board's live 30550 returns the tombstone (superseded)
- Regression: private board delete still works (no cleartext leak; encrypted 30555/6/7 cascade tombstones fire; existing behavior preserved)
- If lean-cleaner (cascade tombstones): each deleted issue and comment gets its own tombstone (30551/30552) in the cascade order
- Failure mode: if publish fails and design is (c) transaction, rollback leaves board intact; if (d) soft-delete, row marked pending-delete for retry
- Full suite green

## Deploy context

- Prod evenflow at v `b85c3a99` (post-EFB-45 + EFB-36).
- Gateway prod at v `ab5238e4`.
- If gateway validator needs `fa:deleted` support, DEPLOY GATEWAY FIRST, THEN evenflow. Fail-order matters: evenflow shipping tombstones the gateway rejects would leave publishes 400ing.
- Auth: `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` for evenflow; separate personal-account creds for gateway (same env vars, different repo path).
- Migration only if design (d) soft-delete — add a `pending_delete_at_ms` column to boardCache.

## Key IDs

- Public test board (for tombstone testing): create a throwaway on `nostr-049b628c` org, delete it after test. DO NOT test on `4042afb7-d1fe-4a80-a311-9de404b0ee14` (dogfood).
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`

## Related

- EFB-24 (shipped): 4/5 kinds published, board.deleted deliberately deferred here
- EFB-36 (just shipped): declaration republish fix — private-board encrypted publishes are working; DO NOT regress
- `issue.deleted` + `comment.deleted` from EFB-24 — pattern precedent for emit-before-delete

## Coordination points — DM me before

- Design pick between (c) transactional and (d) soft-delete — DM the plan
- Cascade design pick (single tombstone vs cascade tombstones) — DM the plan
- Any change to the encrypted (30555/6/7) path — regression risk
- Gateway change (validator + fa:deleted support) — different repo, different deploy target, DM the diff

## DM FLOW — MANDATORY

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. Sona is AFK; replies via channel notifications.
3. Status DMs at: design picks (transactional shape + cascade shape), gateway diff, evenflow implementation, tests green, pre-deploy.
4. **DO NOT `worker_event_complete` until Sona reviewed AND said shipit.**
5. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Checkpoint caveat

Three parallel dispatches out. VERIFY BY CONTENT. State should say "EFB-32 dispatch". If not, restore from brief committed on origin/main.

## Standing rules

- NO deploy without approval. PR target: `main` for evenflow; `main` for 4a if gateway changes.
- Baseline: 2 root + 1 web pre-existing tsc errors.
- Fail-closed for the fork gate stays — never cleartext publish for private.
- Deploy order matters if gateway changes: gateway FIRST, then evenflow.
