# EFB-83 — github.ts local readJsonBody → shared ./errors:readJsonBody

## What & why

`src/routes/github.ts:84` declares its OWN local `readJsonBody` helper. Every other route file (`invites`, `notifications`, `orgs`, `session`, `storage`) imports the shared version from `./errors`. `profile.ts` deliberately does NOT import it, with a comment explaining why (byte-identical constraint) — `github.ts` has NO such comment, it just duplicates. This ticket removes the local copy and switches the 3 call sites (lines 171, 204, 216) to the shared `./errors:readJsonBody`.

Ticket body says "parseRouteBody migration (follow-up to EFB-61)." That name predates EFB-98. Post-EFB-98 the shared helper LIVES at `./errors:readJsonBody` — same intent (single-source, no per-route duplicates), current name. Do the consolidation, don't chase the old name.

## Verify the premise before editing

Look at `src/routes/github.ts:84` (local `readJsonBody`), compare byte-for-byte to `src/routes/errors.ts:67` (shared `readJsonBody`). If they differ in any way (error handling, MIME check, size cap, encoding) — STOP and DM. github.ts might have a `profile.ts`-shaped reason to diverge. If byte-identical, delete local + switch imports.

## Files to touch

| File | Change |
| --- | --- |
| `src/routes/github.ts` | Delete local `readJsonBody` (line 84). Import from `./errors`. Update 3 call sites (171, 204, 216). |
| Boundary allowlist (`scripts/check-boundary.mjs` or similar) | Ratchet: 3 removed from unmigrated list; POST `/webhooks/github/:board_id` STAYS allowlisted (HMAC over raw bytes, cannot migrate). |

## Load-bearing surprises (from EFB-61 lineage)

1. **Predicate inventory first.** List every predicate the current handler enforces (trim, allowlist, denylist, typeof). New schema must reproduce ALL. `Schema.minLength(1)` accepts whitespace-only; hand-rolled `.trim() != ""` doesn't.
2. **Wire-reason strings must be PROSE, not kebab slugs** — `reasonFor()` treats bare slugs as reason CODES and emits `body-<slug>`. Preserve the pre-migration wire reason exactly.
3. **Reproduce, don't silently fix** — EXCEPT under Evan's law. If a pre-existing bug surfaces, FIX IT in-flight and note in PR body. Do NOT file a follow-up ticket.
4. **Untyped Record hides fields from its own author.** EFB-61 hit `column_move_map`. Grep the handler bodies for `body["..."]` before schema-writing.
5. **Post-EFB-98 architecture: Rule 11 says raw reads pinned to route file.** The local `readJsonBody` in github.ts calls the shared one — that IS pinned to the route file (import + call at route). This is fine. What we're removing is the *duplicate declaration*, not the pinning.

## Testing

- Per-schema unit tests per predicate — falsification means each predicate can disappear and fail loudly.
- Wire-reason regression tests: assert `error` field matches pre-migration byte-for-byte.
- `npm run typecheck:src`, `npm run test`, `npm run check:boundary` (or whatever the current names are — check package.json).
- Full test suite green before DM.

## Deploy context

- Backend-only change. `cd /Users/evan/projects/evenflow && npm run typecheck:src && npm test`.
- **Do NOT deploy.** Coordinator handles deploy after review.
- Base: fresh worktree off `origin/main` (currently `be8caa4` — post-EFB-98).

## Key IDs

- Board slug: `evan-s-flow-board`
- Ticket short_id: `EFB-83`
- API base: `https://evenflow.work/api/v0`
- API key: `mem_secret_get evenflow_apikey`

## Related work

- **EFB-61** (parent) — shipped the shared helper for comments+boards.
- **EFB-84/85** — sprints.ts + issues.ts migration; check whether EFB-98 already subsumed them (if so, they auto-close as Done via architecture, and you should note this in your brief-read DM).
- **EFB-98** — the RESTful manifest + action-decoupling refactor; established `readJsonBody` as the shared helper at `./errors:67`. Read `docs/API.md` for the pattern.

## Coordination

- DM me (`session-f4e8ed22897d418a`) with your brief-read + estimate + load-bearing surprises I missed BEFORE editing.
- DM before deploy — coordinator handles it.
- If premise is wrong (github.ts has a real reason to diverge), STOP and DM.
