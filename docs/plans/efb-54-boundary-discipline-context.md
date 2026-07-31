# EFB-54 — Boundary Discipline: schema wrapper + doc + CI check

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-54` — read the ticket body FIRST, it has the full motivation, invariants list, and 8-bugs-of-this-class table.

## Scope one-liner

One design doc + one Effect Schema wrapper + migrate ONE reference route + one CI check. Sets up the pattern; per-subsystem migration is follow-ups.

## Evan's approved leans (from AFK email thread)

- **Reference route:** PATCH /issues/:id
- **CI check strategy:** allowlist with sunset dates (invariant tightens over time, doesn't block today's ships)
- **Effect Schema idiom:** worker picks

## Load-bearing surprises

1. **AdaptEngine has the model.** Sona (dispatcher) doesn't know AdaptEngine's route-audit script details. Worker taking this ticket should grep `/Users/evan/enginable/eng-meta/adaptengine-monorepo` for the pattern — probably a script in `scripts/` + a package.json entry + a CI job. Mirror the structure so the mental model is preserved across repos.

2. **PATCH /issues/:id is BOTH the site of EFB-38 (assignee_pubkey silent-accept) AND EFB-53 (unknown-key silent-drop).** Migrating it as reference proves the pattern against exactly the class of bug the discipline exists to close. Post-migration, both EFB-38 tests AND EFB-53 tests should pass by construction of the schema, not by any explicit handler code.

3. **Effect Schema is the natural fit** given evenflow's Effect-based codebase. Options:
   - Effect's own `Schema` module from `@effect/schema`
   - Zod (well-known, but doesn't compose with Effect's error channel as cleanly)
   - Effect Schema (best composition, higher learning curve)
   Worker picks; document why in the design doc.

4. **`IdentityRef` from EFB-38 already exists** at `src/lib/identity.ts` — the schema for pubkey-in-body should compose canonicalize + assertMember through that helper. Do NOT reimplement identity normalization.

5. **The provenance struct for signed-event actors** is worker-6's proposed shape from EFB-33 postmortem: `{source: "route.caller" | "user.explicit" | "audit.system", pubkey: IdentityRef}`. Signed-event builders should take this, not a bare string. Include in the schema module as a first-class composable.

6. **Migration allowlist is temporary infrastructure, not a permanent feature.** Include a sunset column with dates, and log a warning when an allowlisted route is hit (so unmigrated routes are visible in prod logs, not just tests). The allowlist SHRINKS over time; new routes cannot be added to it.

## Files to touch

| File | Change |
|---|---|
| `docs/BOUNDARY_DISCIPLINE.md` (new) | Developer guide in AdaptEngine model. Names 4 invariants (strict-unknowns, wrong-types, required-missing, canonical output). Worked example. Anti-patterns with links to 8 bugs. |
| `src/lib/route-body.ts` (new) | Effect Schema wrapper: `parseRouteBody<T>(request, schema): Effect<T, ValidationError, never>`. Composable primitives: `IdentityRef` schema (composes canonicalize + assertMember), `Provenance` struct, common types (short_id, uuid). |
| `src/routes/issues.ts` PATCH /issues/:id | Migrate through parseRouteBody. Existing validators (validateAssignee etc.) become schema definitions instead of parse-and-check functions. |
| `scripts/check-boundary-discipline.ts` (new) | Grep-based CI check. Lists all route handlers; flags any that call `readJsonBody` (or whatever the current pattern is) instead of `parseRouteBody`. Checks against allowlist. Fails with helpful message. |
| `scripts/boundary-allowlist.json` (new) | Current un-migrated routes with sunset dates. Only PATCH /issues/:id migrated in this ticket; every other route on the allowlist. Sunset = "we'll migrate by X." |
| `package.json` | New script `check:boundary` running the CI check. |
| Tests | 4 tests per invariant against reference route: unknown key → 400, wrong type → 400, required missing → 400, canonical output. Full EFB-38 + EFB-53 test suites still pass without modification. |

## Where things live

- Effect Schema docs: https://effect.website/docs/schema/introduction (if worker isn't familiar)
- AdaptEngine repo: `/Users/evan/enginable/eng-meta/adaptengine-monorepo` — grep for route-audit / boundary-check patterns
- `IdentityRef` + `canonicalizeIdentityRef` + `assertMember`: `src/lib/identity.ts` (from EFB-38 + EFB-41)
- Existing route handler pattern: `src/routes/issues.ts` (see PATCH handler ~line 700+ for what we're replacing)
- `readJsonBody` (or equivalent) is the current shape; grep to find it

## Testing

- Reference route migrated: full EFB-38 tests pass, full EFB-53 tests pass, 4 new tests per invariant
- CI check script written; VERIFY BY BREAKING IT — temporarily revert PATCH /issues/:id to bypass wrapper, script should fail with a helpful message pointing at the unmigrated route
- Full suite green
- tsc baseline unchanged (2 root + 1 web)

## Deploy context

- Prod evenflow at v `8e8d531b`
- No behavior change for unmigrated routes (this ticket only migrates one)
- No D1 migration
- Standard evenflow deploy: `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` per hard rule

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14`
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`

## Related

- EFB-38, EFB-42, EFB-51, EFB-53, EFB-33 attribution bug: the 5 in-service bugs the discipline prevents (see ticket body for full 8)
- EFB-55 (filed): typed provenance for identities — this ticket subsumes it. Close as duplicate/superseded when this ships.
- AdaptEngine's route-audit CI pattern: the reference model

## Coordination points — MUST DM Sona before

- After reading AdaptEngine's pattern, DM Sona with a summary of what you found and how you'll mirror it
- Effect Schema idiom pick — DM Sona once you've decided
- Reference route migration plan — before you rewrite PATCH /issues/:id
- Any change to existing route behavior (this ticket is add-not-modify for unmigrated routes)
- Allowlist design — hard vs soft fail, warning log shape

## DM FLOW — MANDATORY

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. Sona is AFK; replies via channel notifications.
3. Status DMs at each phase: doc draft, wrapper shape, reference route migration, CI check.
4. **DO NOT `worker_event_complete` until Sona reviewed AND said shipit.**
5. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Checkpoint caveat

Multiple parallel dispatches out. VERIFY BY CONTENT. State should say "EFB-54 dispatch". If not, restore from brief committed on origin/main.

## Standing rules

- NO deploy without approval.
- PR target: `main`.
- Baseline: 2 root + 1 web pre-existing tsc errors.
- Add-not-modify for unmigrated routes.
