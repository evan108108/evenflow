# EFB-33 — 30553 KanbanStatusChange substrate publish (evenflow-only)

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-33`

## Scope one-liner

Complete EFB-24's 4/5-shipped set. The gateway validator + kind allowlist for 30553 already merged in EFB-24. What's missing: the evenflow side that publishes 30553 events. Fix requires threading `status_change_id` out of `insertStatusChange` and through BoardEvent so the publish path has a key to sign against.

## Why it wasn't in EFB-24

The `statusChangeCache` row id is generated inside `insertStatusChange` (`issues.ts:228`, inline `crypto.randomUUID()`) and DISCARDED — it never reaches the board event, so there's nothing to key a 30553 publish on. Fixing requires threading the uuid out: return it from `insertStatusChange`, add `status_change_id` to BoardEvent, set it at emit sites. But `insertStatusChange` is called from 8 places INCLUDING `github/execute.ts`, and mostly from inside `applyStatusChange` / `applyContainerChange` which return `IssueShape` — so their return types and every caller changes too. Blast radius ~5x the vocab commit already landed in EFB-24. Deliberately deferred.

## Load-bearing surprises

1. **8 call sites for `insertStatusChange`.** grep before touching to enumerate. `applyStatusChange` and `applyContainerChange` are the two wrappers that most call sites go through — those return `IssueShape` today, need to return `IssueShape + status_change_id` (either as tuple, extra property, or wrapper object). Pick the least-invasive shape; my lean: return `{ issue: IssueShape, statusChangeId: string }`.

2. **`github/execute.ts` is a live external-integration path.** Changes there are risky — GitHub webhook events flow through it. Verify the return-shape change doesn't break anything downstream in the github rules engine (Phase 22 / EFB-82 area).

3. **The gateway validator ALREADY exists.** `gateway/src/kanban-plaintext-validator.ts` includes `KIND_KANBAN_STATUS_CHANGE = 30553` in the allowlist and has a per-kind spec. So evenflow-side is the entire scope; NO gateway changes needed.

4. **Fork gate pattern is EFB-24's — copy don't rewrite.** `emitSecureBoardEvent`'s existing `publicKindOf` + `stampTargetOf` maps are the template. Add `KanbanStatusChange` to both, key on the board event's `status_change_id`, publish path mirrors the four already-shipping kinds.

5. **`substrate_event_id` column already exists on `statusChangeCache`** from EFB-24's migration 0022. No new migration.

6. **Fail-closed if `status_change_id` is somehow null** on a status-change board event. That should be impossible after this ticket lands (it's the whole point), but the publish path should defend anyway — same fail-closed pattern as the rest of EFB-24.

## Files to touch

| File | Change |
|---|---|
| `src/routes/issues.ts` | `insertStatusChange` returns `{ statusChangeId }` alongside its existing side effect; wrap in `{ issue, statusChangeId }` at applyStatusChange/applyContainerChange level |
| `src/routes/issues.ts` | 8 call sites of `insertStatusChange` — update to consume the new return shape (mostly destructuring at applyStatusChange callers) |
| `src/github/execute.ts` | Same call-site update; verify no downstream breakage |
| `src/durable-objects/board-events.ts` | Extend `BoardEvent` with `status_change_id: string` for transition events (`issue.transitioned` shape) |
| `src/lib/audience/audience-events.ts` | Ensure `buildKanbanStatusChange` (already in Phase 2 of EFB-24) is wired |
| `src/audiences.ts` | Extend `publicKindOf` + `stampTargetOf` maps with `issue.transitioned` → 30553 |
| Route emit sites | Pass `status_change_id` in the board event payload |
| Tests | Golden fixture round-trip: create transition, verify substrate_event_id stamped on statusChangeCache; verify unwrapped event on wire matches gateway validator's shape |

## Where things live

- `insertStatusChange`: `src/routes/issues.ts:228`
- `applyStatusChange` / `applyContainerChange`: same file
- `emitSecureBoardEvent`: `src/audiences.ts`
- Existing 4-kind publish path: `src/lib/kanban/publish.ts` (from EFB-24)
- Gateway validator: `gateway/src/kanban-plaintext-validator.ts` (already has 30553)
- `github/execute.ts`: `src/github/execute.ts`

## Testing

- Unit: `insertStatusChange` returns a UUID; `BoardEvent` shape carries `status_change_id`
- Integration: transition an issue on a public board → 30553 event published → substrate_event_id stamped on `statusChangeCache` row → gateway validator accepts the event
- Regression: transition on a PRIVATE board → publishes via ENCRYPTED 30555/30556/30557 path (not 30553); no plaintext leak
- github/execute.ts flow — a github rule that transitions an issue still works and doesn't error on the new return shape

Full suite green. tsc unchanged (baseline: 2 root + 1 web).

## Deploy context

- Prod evenflow at v `b85c3a99` (post-EFB-45 + EFB-36).
- Gateway prod at v `ab5238e4` (post-EFB-24) — DO NOT redeploy gateway, validator already lives there.
- No D1 migration in this ticket.
- Auth: `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` per hard rule.

## Key IDs

- Public test board: `97d96cac-85cb-4eec-b974-e92b59da2c78` (tide-test-public) — verify plaintext 30553 publishes here
- Private board (regression): `4042afb7-d1fe-4a80-a311-9de404b0ee14` (@evan108108/evan-s-flow-board) — verify still uses encrypted path
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`

## Related

- EFB-24 (shipped): 4 of 5 kinds shipped; gateway validator + kind allowlist for 30553 ALREADY there
- EFB-38 (shipped): identity ref pattern
- EFB-36 (just shipped): declaration republish fix — verified encrypted wraps now landing on dogfood board

## Coordination points — DM me before

- Any change to `applyStatusChange` / `applyContainerChange` return signature that would ripple beyond the 8 call sites
- Any change to github/execute.ts that touches downstream rule-engine behavior
- Any change to the encrypted (30555/6/7) path — regression risk, out of scope

## DM FLOW — MANDATORY

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. Sona is AFK; replies via channel notifications.
3. Status DMs at meaningful phases: return-shape design pick, call-site sweep done, publish path wired, tests green, pre-deploy.
4. **DO NOT `worker_event_complete` until Sona reviewed AND said shipit.**
5. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Checkpoint caveat

Three parallel dispatches out. VERIFY BY CONTENT. State should say "EFB-33 dispatch". If not, restore from brief committed on origin/main.

## Standing rules

- NO deploy without approval. PR target: `main`.
- Baseline: 2 root + 1 web pre-existing tsc errors.
- Do NOT regress encrypted (30555/6/7) path. Regression test required.
