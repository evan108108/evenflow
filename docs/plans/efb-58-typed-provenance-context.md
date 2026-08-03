# EFB-58 — Typed provenance for identity references in signed-event contexts

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-58`

## Scope one-liner

Introduce a `Provenance` type (`{source: "route.caller" | "user.explicit" | "audit.system", pubkey: IdentityRef}`) as a first-class composable in `src/lib/route-body.ts`. Migrate every signed-event builder — `buildKanbanBoard`, `buildKanbanIssue`, `buildKanbanComment`, `buildKanbanStatusChange`, `buildKanbanSprint` — to take `Provenance` instead of a bare-string pubkey for the actor slot. Substitution mistake (using assignee_pubkey where actor_pubkey is wanted) becomes a MISSING-FIELD compile error at callsite instead of a silent runtime substitution.

## Motivation

During EFB-33 implementation, worker nearly shipped an attribution bug: `buildKanbanStatusChange` required `actorPubkey`, event carried no actor, first draft substituted `issue.assignee_pubkey` (a different person — owner of work, not mover of card). TypeScript's structural typing didn't catch it because both are `string`. All 676 tests passed. Would have shipped false attribution on signed public substrate events. Worker caught it by writing a test that named the semantic role — tests that force naming what a value MEANS are stronger regression detectors than tests asserting value shapes.

**This is the same "guards that look total and aren't" family from today's meta-pattern memory** — `string` typing on identity references LOOKS total (both compile), but doesn't actually cover semantic-role drift. Provenance struct closes the drift by demanding role-at-callsite.

## Load-bearing surprises

1. **Do NOT use branded types.** Branded types only catch drift if someone remembers to brand at the boundary; provenance-struct catches at compile time by structural requirement. Worker-6's lean from the EFB-33 postmortem — take it.

2. **Provenance is only for ACTOR slots in signed events.** Not for `assignee_pubkey` on issues (that's a reference, not an actor); not for `p`-tag targets (that's audience); not for pubkey lookups in reads. Scope carefully — over-migration adds noise without safety.

3. **`source` field values are the roles that make sense in evenflow.** Three values: `route.caller` (the JWT-authenticated user made this write), `user.explicit` (an admin acting on behalf of another user's issue — rare, but exists in bulk operations), `audit.system` (server-generated events like tombstones where no human actor exists). Do NOT add more values without a real use case — closed union, per Boundary Discipline.

4. **This is a broad refactor.** Every callsite of the five `buildKanban*` functions needs updating. The compile errors ARE the migration guide — TS won't compile until every callsite constructs a Provenance. Do NOT bypass with a bare-string cast; the refactor IS the safety.

5. **EFB-54's `parseRouteBody` wrapper is where Provenance lives.** Add it to `src/lib/route-body.ts` as an exported type + constructor helpers (`ProvenanceFromCaller(claims)`, `ProvenanceFromSystem()`). Callsites import from there. The `IdentityRef` primitive is already there.

6. **A schema-level assertion is possible.** Provenance can be a schema type via `Schema.Struct({source: Schema.Literal(...), pubkey: IdentityRef})`. If a route handler wants to accept an explicit-provenance override (rare, but possible for audit tools), the schema catches malformed input at the boundary. Not required for v1 — only needed if a public-facing route lets a caller assert provenance.

## Files to touch

| File | Change |
|---|---|
| `src/lib/route-body.ts` | Add `Provenance` type + schema + `ProvenanceFromCaller(claims)` / `ProvenanceFromSystem()` constructors. Export. |
| `src/lib/audience/audience-events.ts` (all 5 `buildKanban*`) | Change actor-pubkey parameter from `string` to `Provenance`. Signed event still uses `.pubkey` inside; provenance's `source` becomes a `fa:provenance` substrate tag (or similar — worker picks, document in code comment). |
| Every callsite of the 5 builders across `src/audiences.ts`, `src/lib/kanban/publish.ts`, `src/routes/issues.ts`, `src/routes/comments.ts`, `src/routes/boards.ts`, `src/routes/sprints.ts`, `src/github/execute.ts` | Wrap the pubkey in `ProvenanceFromCaller(claims)` or `ProvenanceFromSystem()` as appropriate. This is the refactor's spread — TS compile-error-driven. |
| Test files | Per builder: regression test that substituting a bare string (`buildKanbanStatusChange({actor: someString})`) is a compile error. Runtime tests unchanged (Provenance's `.pubkey` renders the same wire event). |

## Where things live

- Wrapper: `src/lib/route-body.ts` (from EFB-54)
- Signed-event builders: `src/lib/audience/audience-events.ts`
- Publish surface (uses builders): `src/lib/kanban/publish.ts`
- Callers: 5 route files + github/execute.ts (see files table)
- BOUNDARY_DISCIPLINE.md — the "typed provenance" pattern belongs in the doc as a new section; add ~30 lines documenting Provenance alongside IdentityRef

## Testing

- `npm test` full suite green
- Runtime behavior is UNCHANGED — provenance renders `.pubkey` at wire time, so signed events on the wire are byte-identical
- Compile-time regression tests: attempt to pass a bare string where Provenance is required → TS error (add these as `// @ts-expect-error` assertions, standard TS-typing test pattern)
- tsc baselines held

## Deploy context

- Prod evenflow at `d89f5aec` post-EFB-13/60
- No D1 changes
- Standard evenflow deploy per hard rule
- **This is a large-diff PR.** Reviewer effort will be higher than usual. Consider splitting the PR by subsystem if the diff is >800 lines: (1) Provenance type + one builder + its callsites; (2) remaining four builders in a follow-up. Worker's judgment call — DM Sona if the diff is uncomfortable to review as one unit.

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14`
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login`

## Related

- EFB-33 (shipped): the near-miss that motivated this
- EFB-54 (shipped): Boundary Discipline — Provenance is a natural composable in the same wrapper
- EFB-38 (shipped): IdentityRef pattern — same shape/authz split; Provenance is one layer up (semantic role of the reference)
- `guards-that-look-total-and-arent` memory: the meta-pattern; `string` typing on identity references is a concrete instance of "looks total, isn't"

## Coordination points — DM me before

- If the diff exceeds 800 lines, DM before opening the PR — we may want to split
- The `source` field values (surprise #3) — if you find a use case that doesn't fit the three, DM before adding a fourth
- Whether to include the compile-time regression test pattern (`@ts-expect-error` on bare-string substitution) — lean YES for at least buildKanbanStatusChange, the near-miss site
- Pre-deploy

## DM FLOW — MANDATORY

1. DM Sona (session `session-f4e8ed22897d418a`) with questions.
2. Status DMs at meaningful phases (type + wrapper, first builder migration, remaining builders, callsite spread, tests, pre-deploy).
3. DO NOT `worker_event_complete` until Sona reviewed AND said shipit.
4. Use `dm_send` targeting `session-f4e8ed22897d418a` or `dm_reply`.

## Checkpoint caveat

Restore by `checkpointId`. State should name "EFB-58 dispatch" — if not, DM immediately.

## Standing rules

- NO deploy without approval.
- Baseline: 2 root + 1 web pre-existing tsc errors.
- Read `docs/BOUNDARY_DISCIPLINE.md` — this ticket extends it.
