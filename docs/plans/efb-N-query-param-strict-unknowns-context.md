# EFB-N — Extend Boundary Discipline to query params (strict-unknowns)

Ticket: not yet filed (file it as part of this ticket, use next EFB number)

## Motivation

EFB-54 shipped strict-unknown-keys enforcement for POST bodies via `parseRouteBody`. Query params bypass that check — `c.req.query()` returns whatever the caller sent, unknown keys silently ignored. This is the same "boundary that says 'yes' when it should say 'no, and here's why'" class of bug.

Concrete instance surfaced 2026-08-01: Sona (me) queried `GET /boards/:slug/issues?status_id=<uuid>` — `status_id` is not a real query field (the real field is `column_id`, and status_id doesn't exist on the schema anyway). The endpoint silently returned 0 issues instead of 400ing on the unknown param. Coordinator (me) then guessed a wrong list of tickets. If the endpoint had 400'd `unknown-query-param: status_id`, I would have looked up the right field name immediately.

## Scope

Same shape as EFB-54's POST-body ratchet, applied to query params.

1. **Add `parseRouteQuery` wrapper** (companion to `parseRouteBody`) in `src/lib/route-body.ts` (or a new `route-query.ts` if that reads cleaner). Takes an Effect Schema of the allowed query params, returns `Effect<Params, ValidationError>`. Unknown keys → 400 with the specific unknown key named.

2. **Migrate the `GET /boards/:slug/issues` handler as the reference route** — it's the one that misled me. Define its schema (`status`, `container`, `assignee`, `label`, `column_id`, `sprint_id`, `q`, `limit`, `after`), replace `c.req.query()` calls with the wrapper. Existing tests should pass; add one that hits the endpoint with `?status_id=x` and asserts 400 with the unknown key named.

3. **CI check** — extend `check:boundary` (or add sibling `check:boundary-query`) to fail if a route handler reads `c.req.query()` outside the wrapper. Same sunset-fails-not-warns discipline.

4. **File the ticket** as EFB-N (next number after the highest EFB currently — you'll grep on the board). Body naming: `Extend Boundary Discipline to query params (strict-unknowns)`. Motivation + scope from above.

## What NOT to touch

- Other route handlers' query reads — that's the migration-per-subsystem follow-up work, same posture as EFB-54's original ship.
- POST body pattern — already shipped.
- The `?after=` pagination cursor — that's a value, not a key; it stays.

## Testing

- Unit: schema rejects unknown keys, wrong types, missing required (if any).
- Integration: `GET /boards/:slug/issues?status_id=x` → 400 with `unknown-query-param: status_id` in the response body.
- Regression: existing SPA queries against the endpoint still work (SPA sends `?status=` `?container=` `?column_id=` etc.).
- `check:boundary-query` fails on a synthetic un-migrated handler; passes on the migrated one. Same proven-can-fail pattern as EFB-54.

## Deploy

- Prod at `3997aa2a`. Standard evenflow deploy.
- No D1 changes.
- Product-visible? No — but any external tooling using an unknown query param NOW gets a 400 instead of silent zero results. That's the point.

## Coordination — MANDATORY DM points

- Post-brief-read: your read of the parseRouteBody structure and whether extending vs sibling-file is cleaner
- Pre-CI-check design: what exactly the check greps for (`c.req.query()` outside the wrapper is the target)
- Pre-deploy always
- If migrating the reference route surfaces other query-related bugs (e.g., a handler that DEPENDS on unknown-keys-being-silently-ignored), DM before "fixing" that

## Standing rules
- Own worktree: `git worktree add ../evenflow-efb-N-query -b efb-N-query-strict off origin/main`
- No shared-checkout git ops
- Session `session-f4e8ed22897d418a`
