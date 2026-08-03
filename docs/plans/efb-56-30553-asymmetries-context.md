# EFB-56 — 30553 substrate publish asymmetries (github + creation)

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-56`

## Scope one-liner

Two coverage gaps discovered during EFB-33 implementation. The 30553 KanbanStatusChange publish path is wired only to `src/routes/issues.ts`'s status-change writer. Fix both:
1. **github-driven transitions** — `src/github/execute.ts:41` has its OWN local `insertStatusChange` implementation. Writes to `statusChangeCache` but the publish path never sees the row.
2. **Creation-time status rows** — issue creation writes a `null → first column` row via `applyStatusChange`, but `issue.created` board event carries no `status_change_id`. Publish path skips it. Substrate audit trail starts at first transition, not creation.

Neither is a security bug; both are completeness gaps.

## Load-bearing surprises

1. **Two `insertStatusChange` implementations.** `src/routes/issues.ts:254` (named args, current callsite of EFB-33) vs `src/github/execute.ts:41` (positional args, distinct). **Do NOT wire the publish path to both individually — that's the drift-forever pattern.** Instead: extract ONE shared helper (into `src/lib/status-change.ts` or similar), have both callsites use it, publish surface wraps the helper. This is the EFB-54 lesson pointed sideways: consolidate at the API layer, don't duct-tape both callsites.

2. **Creation is not a "transition" in the intuitive sense but IS a status change.** The `null → first column` row IS a legitimate `applyStatusChange` invocation and is stored in `statusChangeCache`. The publish path just doesn't emit it because `issue.created` doesn't reference it. Fix: `issue.created` event should carry `status_change_id` (top-level, same as `issue.transitioned` after EFB-33). Publish path fans out BOTH 30551 (created) AND 30553 (initial transition).

3. **Only public boards publish.** Both fixes preserve this — encrypted-substrate publishing of 30553 is EFB-55's problem, not this ticket's. Guard with `publishesPlaintext(board)` before either new emit.

4. **`templatesFor` array shape from EFB-33.** Read `src/lib/kanban/publish.ts` for how 30553 gets templated. Reuse the same shape — don't invent a new one. The existing test in EFB-33's suite that asserts template structure should apply verbatim to the creation-time emit.

5. **github/execute.ts is a distinct effect graph from issues.ts.** Its transitions run via GitHub webhook → github route → execute → applyRule. That path has its own Effect layering. Wiring publish through the shared helper only works if the helper is publish-surface-agnostic (returns the statusChangeId; caller decides whether to publish).

## Files to touch

| File | Change |
|---|---|
| `src/lib/status-change.ts` (new) | Extract `insertStatusChange` — one signature, both callsites. Returns `statusChangeId`. |
| `src/routes/issues.ts:254` | Replace local `insertStatusChange` with helper call. |
| `src/github/execute.ts:41` | Replace local `insertStatusChange` with helper call. |
| `src/routes/issues.ts` (issue creation handler) | After `applyStatusChange` for `null → first`, attach `status_change_id` to the `issue.created` event payload. |
| `src/durable-objects/board-events.ts` | If `status_change_id` isn't already a top-level field on `issue.created` events, add (EFB-33 added it to `issue.transitioned` already). |
| `src/audiences.ts` or `src/lib/kanban/publish.ts` | On `issue.created` with `status_change_id`, publish 30553 alongside 30551. On `issue.transitioned` via github/execute path (now carries id via shared helper), publish 30553. |
| Test file | github-driven transition publishes 30553; issue creation publishes 30551+30553; regression: UI transition still publishes 30553 (EFB-33 baseline unchanged). |

## Where things live

- 30553 publish surface: `src/lib/kanban/publish.ts` (post-EFB-33)
- `publishesPlaintext`: `src/audiences.ts`
- Board event types: `src/durable-objects/board-events.ts:26-90`
- Github rule engine: `src/github/execute.ts`

## Testing

- `npm test` — all green
- New tests for github-driven 30553 publish + creation-time 30553 publish
- Regression: UI transition still publishes 30553 (existing EFB-33 test)
- tsc baselines held

## Deploy context

- Prod evenflow at `d89f5aec` post-EFB-13/60
- No D1 changes
- Standard evenflow deploy per hard rule

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14`
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login`

## Related

- EFB-33 (shipped): the publish path this ticket completes
- EFB-24 (shipped): the substrate publish substrate 30551 rides on
- EFB-55 (deferred, separate ticket): encrypted-substrate observability — do NOT try to extend this ticket to encrypted 30553

## Coordination points — DM me before

- Extraction shape of the shared `insertStatusChange` helper (positional vs named args — worker's call, but flag if you find a THIRD caller I missed)
- Whether `issue.created` gets `status_change_id` at the envelope level or only when a status_change row exists (lean: always present when the row exists, absent otherwise — same as EFB-33)
- Pre-deploy

## DM FLOW — MANDATORY

1. DM Sona (session `session-f4e8ed22897d418a`) with questions.
2. Status DMs at meaningful phases (extraction, wiring, tests, pre-deploy).
3. DO NOT `worker_event_complete` until Sona reviewed AND said shipit.
4. Use `dm_send` targeting `session-f4e8ed22897d418a` or `dm_reply`.

## Checkpoint caveat

Restore by `checkpointId`. State should name "EFB-56 dispatch" — if not, DM immediately.

## Standing rules

- NO deploy without approval.
- Baseline: 2 root + 1 web pre-existing tsc errors.
- Read `docs/BOUNDARY_DISCIPLINE.md` if you touch a route body.
