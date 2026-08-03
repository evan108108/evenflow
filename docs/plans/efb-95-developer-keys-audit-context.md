# EFB-95 — API key management UI audit

## What & why

The API key management UI at `web/src/pages/DeveloperKeys.tsx` (shipped in EFB-19) needs an audit for coverage against the current backend surface. If complete, close with a comment listing what it covers. If gaps, extend inline per Evan's law — do NOT file follow-up tickets for missing features.

## Coverage checklist

| Capability | UI supports? | Backend surface (source of truth) |
| --- | --- | --- |
| List existing keys | ? | `src/routes/keys.ts` — GET route |
| Create new key (show raw secret exactly once) | ? | POST route |
| Revoke key | ? | DELETE route |
| Rotate key | ? | POST rotate route |
| Scoping / permissions (which routes a key can hit) | ? | key schema fields |
| Label / naming | ? | key schema fields |
| Last-used timestamp | ? | key schema fields |

## Files to touch

| File | Change |
| --- | --- |
| `web/src/pages/DeveloperKeys.tsx` | Audit; extend inline for any gap. |
| `web/src/pages/developerKeys.test.tsx` | Add tests for any new UI coverage. |
| `src/routes/keys.ts` (may be `src/actions/keys.ts` post-EFB-98) | READ-ONLY audit — this is the source of truth. Confirm the backend supports each capability listed above. If backend is missing a capability the UI should offer, DM me BEFORE extending the UI; backend gaps may need a separate scope decision. |
| `src/apikeys.ts` | Reference for the key-verification path (understand what the UI has to preserve). |

## Load-bearing surprises

- **Raw key shown exactly ONCE at create time.** Never re-fetchable. If the current UI shows it more than once (persists in memory across renders after dismiss), that's a security bug — fix it under Evan's law.
- **Post-EFB-98:** if `src/routes/keys.ts` was action-decoupled, actions live at `src/actions/keys.ts`. Route file is thin HTTP shell. `docs/API.md` explains the pattern.
- **NO focus outlines / focus rings.** Standing hard rule. Don't add them.
- **Confirmation dialogs** — revoke should require confirmation (destructive). Match the pattern used elsewhere in evenflow (grep for `confirm(` or existing modal helpers).
- **Test coverage** — `developerKeys.test.tsx` exists; every new UI capability needs a test.

## Falsification

- Create a key via UI → copy raw secret → issue an API call with it (`curl -H "Authorization: Bearer <key>" https://evenflow.work/api/v0/boards`). Expect 200.
- Revoke via UI → retry same call. Expect 401.
- List UI reflects the create + reflects the revoke (removed from list).
- Screenshot at 1440px before/after any UI change. DM screenshots.

## Testing

- `cd web && npm test -- developerKeys` — existing test file.
- Add new tests for any new coverage.
- `cd web && npm run build`.
- Full backend test suite: `cd /Users/evan/projects/evenflow && npm test` (only if you touched backend).

## Deploy context

- Frontend + possibly small backend audit. Coordinator deploys.
- Base: fresh worktree off `origin/main` (`be8caa4`).

## Key IDs

- Ticket: `EFB-95`
- Session: `session-f4e8ed22897d418a`
- Coordinator API key (for your falsification test): `mem_secret_get evenflow_apikey` returns `evk_Ttw...`
- Board slug: `evan-s-flow-board`

## Related work

- **EFB-19** (parent) — Developer surface (API keys UI + backend + docs).
- **EFB-98** — Route/action decoupling; `docs/API.md` for the manifest pattern if you touch backend.

## Coordination

- DM your brief-read + the coverage-audit RESULT (per-row checked/gap) BEFORE extending.
- If the audit says "complete, no gaps": say so — I'll close the ticket with your finding as the comment.
- If backend is missing a capability the UI should offer, DM me BEFORE extending; scope decision required.
- **No focus rings. No follow-up tickets.**
