# EFB-38 — assignee_pubkey validation + normalization

Ticket body (`https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-38`) has the full spec — problem statement, root cause, fix plan, test rubric, migration. Read it FIRST.

This brief adds worktree/branch/deploy context and DM-flow, not new architecture. If anything in this brief contradicts the ticket, the ticket wins.

## Scope in one line

`src/routes/issues.ts:168-171` — `validateAssignee` currently accepts any non-empty string. Should (a) normalize pubkey shape (raw hex → `nostr:hex`) and (b) validate the normalized value is a board member. Applies to both create and PATCH.

## Load-bearing surprises

1. **Two call sites, one function.** `validateAssignee` is called from `issues.ts:366` (POST create) and `issues.ts:711` (PATCH). Signature change affects both. Both callers already have `board: BoardShape` in scope via `boardScope(...)` earlier in the handler, so passing it in is trivial.

2. **Member roster shape.** `GET /api/v0/orgs/:org/boards/:slug/members` returns `{members: [{pubkey, role, ...}]}`. Sona's pubkey there is `nostr:049b628c…` (provider-prefixed). Google-signed users are `google:104509077344032735108`. GitHub-signed would be `github:<id>`. Any future provider adds a new prefix. The prefix IS the provider.

3. **Existing rows are already all canonical.** As of dispatch time, EFB-31 through EFB-38 were manually re-patched to `nostr:049b628c…`. No other bad-shape rows exist. Migration is defensive, not remedial — but include it anyway (see ticket §Migration).

4. **This ticket exists BECAUSE the bug pattern hit 4x this week.** EFB-24 caught: `!encryption_active` gate (three-state collapse), forkDaemon-never-scheduled on CF Workers, tests-written-from-implementation. This is the 4th: silent-accept-invalid-input. Ship the fix in the same pattern — reject loudly at the point of write. Tests-that-fail-first-then-pass are required, per the ticket body.

## Files to touch

| File | Change |
|---|---|
| `src/routes/issues.ts` | Extend `validateAssignee` signature; wire board context at both call sites |
| `src/lib/identity.ts` (or new file) | New `canonicalizeIdentityRef(v)` helper — 64-char hex → prefix with `nostr:`; already-prefixed forms pass through; reject unrecognized. Colocate with existing identity helpers if any exist. |
| `src/routes/issues.test.ts` (or wherever issue route tests live) | 6 new tests per ticket §Tests |
| `migrations/0023_assignee_normalize.sql` | ONE-LINE `UPDATE issueCache SET assignee_pubkey = 'nostr:' || assignee_pubkey WHERE assignee_pubkey GLOB '[0-9a-f]*' AND length(assignee_pubkey) = 64` |

## Testing

Write tests FIRST (they should fail against current code, pass after fix). Full-suite pass required. tsc clean bar the 2 pre-existing known errors.

## Deploy context

- **Prod is at evenflow v `2c15091b`, gateway v `ab5238e4`.** Neither this ticket nor the fix touches gateway.
- **DO NOT DEPLOY without DMing me first.**
- Migration 0023: apply LOCAL first (`npm run d1:migrate:local`). Prod apply requires my approval.
- Fresh worktree recommended: `git worktree add /Users/evan/projects/evenflow-efb-38 -b efb-38-assignee-validation origin/main`.

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14` (slug `@evan108108/evan-s-flow-board`)
- Sona pubkey (canonical): `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- Google-signed user example on this board: `google:104509077344032735108` (Evan)
- JWT: `mem_secret_get evenflow_login`

## Related

- EFB-24 (shipped): established the tests-certify-the-bug pattern this ticket follows.
- EFB-31 through EFB-37: filed under this bug. All manually patched to canonical form.

## Coordination points — DM me before

- The `canonicalizeIdentityRef` design if you land on ambiguities (unrecognized prefixes, mixed-case hex, `npub1…` bech32 form — reject or accept?).
- The migration 0023 shape if it needs to be more than the one-liner.
- Prod deploy of anything.

## DM FLOW — MANDATORY

1. **DM me (Sona, session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`) with any questions.**
2. **Status updates via DM at meaningful checkpoints** — after test suite red (bug reproduced), after fix passes tests, before deploy.
3. **DO NOT call `worker_event_complete` until you have DMed me for review AND I have returned my shipit.**
4. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply` with a message_id.

## Non-goals

- No changes to substrate publish paths (EFB-24 handles).
- No UI changes (backend fix; UI already resolves canonical pubkeys correctly).
- No changes to `assignee` filter query param behavior on GET — that stays as an exact-string match against the (now-normalized) stored value.
