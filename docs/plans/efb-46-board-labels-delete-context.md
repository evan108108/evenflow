# EFB-46 — Delete unused `board.labels` field

Ticket: `https://evenflow.work/api/v0/issues/EFB-46`

## Scope

Delete the unused `board.labels` field from schema + shape. My lean per Evan: **DELETE, don't build a canonical registry.** Ticket body confirms grep found zero readers anywhere in the app.

## Before you delete — verify

Grep for `board.labels` / `boardCache.labels` / any consumer across `src/**` AND `web/src/**` AND `tests/**`. If your grep finds a reader I missed, DM me BEFORE touching schema. Don't assume the ticket body's finding.

## What to touch (if grep confirms zero readers)

- Migration 0027 (new) — DROP COLUMN `labels` from `boardCache` (or ALTER … in SQLite's roundabout way — check migrations/0004+ for the copy-rebuild pattern this codebase uses)
- `src/shapes.ts` — remove `labels` from `BoardShape` and any board shape variants
- Anything else your grep surfaces

## Testing

- Migration LOCAL first, DM me before prod apply
- Existing tests pass (or update the ones that mention the field)
- Boundary check clean

## Coordination — MANDATORY DM points

- Post-brief-read: your grep results (readers found or zero-confirmed)
- Migration LOCAL result, before prod apply
- Pre-deploy always
- If grep surprises you into "actually canonical-registry is the right call" — DM, don't build it

## Standing rules
- Work in your own worktree: `git worktree add ../evenflow-efb-46 -b efb-46-labels-delete off origin/main`
- Do NOT run git checkout/pull/reset/merge in shared checkout
- `mem_secret_get` via MCP for secrets
- Session `session-f4e8ed22897d418a`
- Prod at `3997aa2a`
