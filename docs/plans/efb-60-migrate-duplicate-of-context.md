# EFB-60 — Migrate POST /issues/:id/duplicate-of through parseRouteBody

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-60`

## Scope one-liner

Small Boundary Discipline debt cleanup: `POST /issues/:id/duplicate-of` (added in EFB-30 hours before EFB-54 landed) reads its body without `parseRouteBody` and is flagged by `check:boundary` as a violation. Migrate it through the wrapper. **This is the ratchet working correctly** — a new route added right before the discipline shipped should be migrated, not allowlisted.

## Prior context

- EFB-54 shipped: `parseRouteBody` wrapper + `check:boundary` CI script + doc at `docs/BOUNDARY_DISCIPLINE.md` + PATCH `/issues/:id` as reference migration.
- EFB-30 shipped: added POST `/issues/:id/duplicate-of`; the endpoint predates the wrapper being available and reads its body via the legacy `readJsonBody`-style path.
- Currently `npm run check:boundary` (or however the script is invoked) reports:

```
[boundary] 1 problem(s):
- src/routes/issues.ts:1109 POST /issues/:id/duplicate-of — reads its body without parseRouteBody and is not on the allowlist.
    Migrate it (see docs/BOUNDARY_DISCIPLINE.md), or if it is pre-existing debt add it to scripts/boundary-allowlist.json with a sunset date. New routes may not be added.
```

**Do not add to the allowlist.** The script's own message is explicit: new routes may not be added. The fix is migration.

## Load-bearing surprises

1. **Two-stage design (per EFB-54 doc).** Schema is shape-only. The same-board check and cycle-walking (the "is B in A's board?" + "does B→...→A?" logic EFB-30 shipped) stay in the handler as authorization steps. **DO NOT** try to encode board-membership or cycle detection into the schema — the schema cannot see the DB.

2. **Schema shape** (nothing surprising, but write it once so the substitution is obvious):
   ```ts
   const PostDuplicateOfBody = Schema.Struct({
     duplicate_of_issue_id: Schema.Union(
       Schema.String.pipe(Schema.minLength(1)),  // uuid or short_id (EFB-30 accepts both)
       Schema.Null,
     ),
   })
   ```
   `null` is the "clear the pointer" case (unmarking a duplicate). Do not omit it.

3. **The existing EFB-30 tests should pass unchanged.** If any break, that's a signal the split between schema-shape and handler-authz got confused — stop and DM Sona before "fixing" a test.

4. **`check:boundary` output moves from 1/N migrated → 2/N migrated** after this ships. Verify by running the script locally.

## Files to touch

| File | Change |
|---|---|
| `src/routes/issues.ts` around line 1109 (POST duplicate-of) | Replace body-read with `yield* parseRouteBody(c, PostDuplicateOfBody)`; keep existing authz + cycle-walk in the handler. |
| `src/lib/route-body.ts` (or wherever EFB-54 landed the schemas) | Add `PostDuplicateOfBody` schema. If EFB-54's convention is per-route schemas colocated with the handler, follow that instead. |
| Test file for duplicate-of (whichever one EFB-30 added) | Add: unknown key in body → 400 `unknown-field`; missing `duplicate_of_issue_id` → 400 required-missing. Existing tests unchanged. |

## Where things live

- Boundary Discipline doc: `docs/BOUNDARY_DISCIPLINE.md` — READ THIS FIRST if unfamiliar with the pattern.
- Schema wrapper: `src/lib/route-body.ts`
- Reference migration (PATCH /issues/:id): `src/routes/issues.ts:884` — the pattern to mirror. Note the "shape-only, authz-in-handler" split, the `body.field === undefined ? current.field : body.field` idiom for optional patches, and how it uses `parseRouteBody` in an Effect.gen block.
- CI check: `scripts/check-boundary-discipline.ts` (or `.mjs`) — run it before + after to confirm it moves from 1→2.

## Testing

- `npm test` (or equivalent) — full suite green, existing EFB-30 tests unchanged.
- `npm run check:boundary` — reports 2/N migrated instead of 1/N, no violations.
- New unit tests:
  - `{titl: "typo"}` in body → 400 `unknown-field`
  - `{}` (missing required field) → 400 with `duplicate_of_issue_id` named
  - `{duplicate_of_issue_id: null}` → 200 (clear pointer)
  - `{duplicate_of_issue_id: "EFB-N"}` → 200 (existing behavior)

## Deploy context

- Prod evenflow at `fd6f016e` post-EFB-54/EFB-30.
- **No D1 changes.** Pure route refactor.
- Standard evenflow deploy: `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` per hard rule.
- `git status` before deploy (hard rule) — nothing unrelated should be staged.

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14` (@evan108108/evan-s-flow-board)
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`

## Related

- EFB-54 (shipped): the wrapper + doc + check script this ticket migrates through
- EFB-30 (shipped): the endpoint being migrated; do not regress its behavior
- The `check:boundary` output flagging this endpoint IS the ticket's justification — the ratchet caught its first drift correctly

## Coordination points — DM me before

- If the schema-vs-handler split feels wrong (e.g. you want to move cycle-walk into the schema — don't, DM first)
- If any existing EFB-30 test breaks (see surprise #3)
- If `check:boundary` doesn't move from 1→2 after migration (means the script's detection heuristic missed it, worth understanding)
- Pre-deploy — always

## DM FLOW — MANDATORY, DO NOT SKIP

You are working under a strict DM-review protocol. This is not optional:

1. **DM me with any questions or concerns.** Do not guess on scope. Do not make ambiguous decisions solo.
2. **Give status updates via DM at meaningful checkpoints.** At minimum: after migration, after tests pass, before deploy.
3. **DO NOT complete the task (worker_event_complete) until you have DMed me for review AND I have returned my review response.** "Task complete" is decided by MY review, not your judgment.
4. Use `dm_send` targeting session `session-f4e8ed22897d418a` (that's me) or `dm_reply` with a message_id if replying to one of my DMs.

## Checkpoint caveat

Multiple parallel dispatches may be out. Restore by `checkpointId` (Sonata core has EFB-48's fix live). If restore returns state that doesn't say "EFB-60 dispatch", DM Sona immediately — do not proceed on wrong context.

## Standing rules

- NO deploy without approval.
- Baseline: 2 root + 1 web pre-existing tsc errors — don't add more.
- Read `docs/BOUNDARY_DISCIPLINE.md` before writing code.
