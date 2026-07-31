# EFB-36 — evan-s-flow-board encrypted tide wraps not landing

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-36`

## Scope one-liner

`evan-s-flow-board` (private, audience minted) has 4+ sprint tide snapshots in D1 with `substrate_event_id = NULL`. All predate the EFB-24 deploy (verified). Encrypted tide publish path (30565 gift-wrapped for members, shipped in EFB-22) exists but wraps aren't landing on the dogfood board. Root-cause + fix.

## Load-bearing surprises

1. **This is an investigation ticket first, then a fix.** Root cause is unknown. Do NOT guess.

2. **`private-wraps-failed` reason path is what's triggering.** `src/lib/tide/publish.ts` at the null-id branch (post-EFB-24 fork, was line ~95 before) logs `tide-publish-deferred reason=private-wraps-failed` and returns null. That's the correct fail-closed behavior — no cleartext to public relay — but it's a SYMPTOM. The wrap itself is failing upstream.

3. **Not a leak.** The safety fallback correctly declines to publish cleartext. NULL stamp is the symptom, not the harm. Fix is completeness (tide history should be on substrate for this board) not security.

4. **Candidates for root cause** (from ticket body):
   - Audience membership stale (member set doesn't match current board membership)
   - Gateway `/v0/publish/kanban_tide_encrypted` returning non-2xx silently
   - `bestEffortAudience` swallowing an unexpected error class
   - Member pubkey missing from audience_pubkey (schema drift)
   - Some encryption key rotation / mismatch scenario

5. **Reproduction:** trigger a tide recompute on evan-s-flow-board (either wait for cron at 06:17 UTC or force via an API call if one exists), then tail wrangler logs for `tide-publish-deferred reason=private-wraps-failed`. Or check historical logs if available. Or grep the encrypted wrap publish site and instrument temporarily.

6. **evan-s-flow-board specifically** — this board was force-set public in migration 0015 then re-privatized (per EFB-38 audit finding, "prod says visibility=private with an audience minted"). Its state is unusual. Test against this specific board, not a fresh probe.

## Files to touch (probable)

Depending on root cause. Investigation may narrow to:

| File | Probable involvement |
|---|---|
| `src/lib/tide/publish.ts` | The current null-id branch and `private-wraps-failed` log site |
| `src/audiences.ts` | `emitSecureBoardEvent` + `bestEffortAudience`; wrap+publish path for encrypted 30565 |
| `src/effects/Audience.ts` (or FourA) | `kanbanKeys()`, `rawPost`, encrypted publish |
| Gateway `/v0/publish/kanban_tide_encrypted` route | 4a repo, if the gateway rejects the wrap |

Add tests along the fix. Whatever the root cause is, a regression test that would have caught it before shipping is required.

## Testing

- Reproduce: force a tide recompute or use next 06:17 cron; verify `substrate_event_id` populated on the new row for evan-s-flow-board
- Regression: fresh recompute on a control (create a temporary private board + audience, verify wraps land)
- Full suite green

## Deploy context

- Prod evenflow at v `05e0a796` (post-EFB-47)
- Prod gateway at v `ab5238e4` (post-EFB-24)
- Fix may span evenflow AND gateway depending on root cause. If gateway, brief-write and DM Sona before touching that repo — different repo, different deploy target.
- Auth via `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` per hard rule

## Key IDs

- Board (dogfood): `4042afb7-d1fe-4a80-a311-9de404b0ee14` (@evan108108/evan-s-flow-board)
- Sprint 1: `01e70cc9-0aaa-4ca9-88d4-ea897f42685e`
- Sona pubkey (a board member): `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- Evan pubkey (owner): `google:104509077344032735108`
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`
- Gateway repo: `/Users/evan/projects/4a` (if needed)

## Related

- EFB-22 (shipped): established the encrypted tide publish path (30565 gift-wrapped for members)
- EFB-24 (shipped): the fork gate in emitSecureBoardEvent that separates encrypted from plaintext — verified the fork routes correctly, so THIS bug is upstream of the fork
- EFB-38 (shipped): audit finding that evan-s-flow-board is visibility=private with audience minted
- Filed post-EFB-24 as follow-up

## Coordination points — DM me before

- Any change to the encrypted publish path itself (30565 wrap shape, gift-wrap ordering, member enumeration) — I want to see the diff
- Any gateway-side change — different repo, brief needed
- Any suggestion to alter the fail-closed behavior of tide/publish.ts — that's a security posture change, not this ticket

## DM FLOW — MANDATORY

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. Sona is AFK — replies via channel notifications.
3. Status DMs at: reproduction confirmed, root cause identified, fix applied, tests green, pre-deploy.
4. **DO NOT `worker_event_complete` until Sona reviewed AND said shipit.**
5. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Checkpoint caveat

Three parallel dispatches out today. VERIFY CHECKPOINT BY CONTENT. State should say "EFB-36 dispatch". If not, restore from brief committed on origin/main.

## Standing rules

- NO deploy without approval. PR target: `main` (for evenflow); gateway-side would target 4a/main separately
- Baseline: 2 root + 1 web pre-existing tsc errors
- Fail-closed behavior of tide/publish.ts stays — never publish cleartext for a private board
