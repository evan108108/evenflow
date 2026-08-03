# EFB-65 + EFB-68 — Two-file tsc baseline maintenance batch

Tickets:
- `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-65`
- `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-68`

## Scope one-liner

Two small, mechanical tsc fixes shipped in one PR. Both surfaced from today's shipping. EFB-65 drops the web tsc baseline 1→0. EFB-68 removes 13 root-tsc errors introduced by EFB-55's test file. Total: web goes to zero; root drops from 15 → 2.

## Baseline going into this batch

- **Root**: 15 pre-existing errors (13 in `tests/verify-encrypted-wrap.test.ts` from EFB-55 + 2 truly pre-existing).
- **Web**: 1 pre-existing error (SprintArchive.tsx:94).

After this batch:
- **Root**: 2 errors (the truly pre-existing ones — do NOT touch those).
- **Web**: 0 errors.

## EFB-65 — SprintArchive.tsx exactOptionalPropertyTypes

Exact error (verified from `npx tsc --noEmit` in `web/`):

```
src/pages/SprintArchive.tsx(94,20): error TS2375: Type '{ m: SprintMembership; basePath: string; extra: string | undefined; }' is not assignable to type 'IntrinsicAttributes & { m: SprintMembership; basePath: string; extra?: string; }' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
```

Root cause: caller passes `extra: string | undefined` explicitly; component prop typed `extra?: string`. `exactOptionalPropertyTypes: true` (which the web tsconfig has) rejects the mismatch — an omitted property and a property set to `undefined` are semantically different.

Two clean fix options, worker's call:

**Fix A** — widen the prop type to `extra?: string | undefined` (the type checker's suggested fix; matches what the caller is actually passing). Preserves caller shape; explicit that undefined is a valid value.

**Fix B** — conditionally spread the prop at the callsite: `{...(extra !== undefined && { extra })}`. Preserves the strict `extra?: string` contract; pushes the discipline of "don't pass undefined" to the callsite.

Lean: **Fix A** — the callsite's `extra` legitimately comes from an optional upstream, so explicitly typing "may be undefined" is the honest shape. Fix B is more work for the same runtime behavior. DM if the SprintMembership context makes Fix B clearly better.

## EFB-68 — verify-encrypted-wrap.test.ts node types

Exact errors (verified from `npx tsc --noEmit` in root):

```
tests/verify-encrypted-wrap.test.ts(12,33): error TS2307: Cannot find module 'node:child_process' or its corresponding type declarations.
tests/verify-encrypted-wrap.test.ts(13,52): error TS2307: Cannot find module 'node:fs' or its corresponding type declarations.
tests/verify-encrypted-wrap.test.ts(14,24): error TS2307: Cannot find module 'node:os' or its corresponding type declarations.
tests/verify-encrypted-wrap.test.ts(15,22): error TS2307: Cannot find module 'node:path' or its corresponding type declarations.
tests/verify-encrypted-wrap.test.ts(16,27): error TS2307: Cannot find module 'node:util' or its corresponding type declarations.
tests/verify-encrypted-wrap.test.ts(23,76): error TS2339: Property 'url' does not exist on type 'ImportMeta'.
tests/verify-encrypted-wrap.test.ts(39,17): error TS2591: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.
tests/verify-encrypted-wrap.test.ts(51,59): error TS2591: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.
tests/verify-encrypted-wrap.test.ts(54,30): error TS7006: Parameter 'd' implicitly has an 'any' type.
tests/verify-encrypted-wrap.test.ts(55,30): error TS7006: Parameter 'd' implicitly has an 'any' type.
tests/verify-encrypted-wrap.test.ts(56,24): error TS7006: Parameter 'code' implicitly has an 'any' type.
```

Root cause: the test file uses node built-ins + `import.meta.url` + Buffer-typed callbacks, but the root tsconfig covering `tests/` isn't wired for node types. EFB-55 shipped the test but didn't tighten types.

**Investigate this first** — check what tsconfig covers `tests/`:
- `tsconfig.json` at the root
- Any `tsconfig.test.json` / `tsconfig.node.json` variant
- The `types` and `lib` and `include` fields

The fix is almost certainly ONE of:

**Fix Path A** — the test file needs its own tsconfig (or the existing test tsconfig extended) with `"types": ["node"]` and `"lib": ["ES2022"]`. Cleanest if there's already a split between worker-runtime tsconfig and test tsconfig.

**Fix Path B** — add `@types/node` to the root tsconfig's `types` array if the tsconfig doesn't already exclude it. Note: this may pollute types for worker code that runs on CF Workers runtime (no node), so Path A is usually safer.

**Fix Path C** — explicit type annotations in the test file (`(d: Buffer)`, `(code: number | null)`) plus `.d.ts` shims for the node modules. Ugliest; only if A/B pollute.

Lean: **A if a test-specific tsconfig exists or can be trivially added; B if the root tsconfig already loads node types elsewhere.** Read the tsconfigs first, then pick.

**Sanity checks the fix must pass**:
1. `npx tsc --noEmit` in root: error count drops from 15 → 2. The remaining 2 are pre-existing baseline — do NOT touch them.
2. `npm test` (or whatever the test runner is) still passes for `verify-encrypted-wrap.test.ts` — the fix is to types, not test behavior.
3. Worker runtime code (anything under `src/`) still typechecks the SAME way as before — if you widened node types globally, verify worker code that intentionally excludes `process` / `Buffer` didn't just silently start typechecking.

## Files to touch

| File | Change |
|---|---|
| `web/src/pages/SprintArchive.tsx` (or the component it renders on line 94) | Fix A: widen prop to `extra?: string \| undefined`. Fix B: spread conditionally. |
| Root `tsconfig.json` / `tsconfig.test.json` (whichever covers `tests/`) | Add node types per Fix Path A/B/C. |
| **DO NOT modify** `tests/verify-encrypted-wrap.test.ts` unless forced to (Fix Path C) — that file is what shipped with EFB-55 and should stay as-is if possible. |

## Testing

- Pre-fix baseline captured above (root=15, web=1).
- Post-fix: root=2, web=0.
- No src/ file may show a new tsc error.
- `npm test` for the touched test still passes.
- Nothing product-visible; smoke-test on prod is not required.

## Deploy context

- **No deploy needed.** Type-check-only fixes. No shipped bundle changes.
- No D1 changes.
- No product-visible change.
- CI (whichever `check:tsc` gate exists) will drop the baseline automatically.

## Non-goals

- NOT fixing the 2 truly pre-existing root errors (out of scope; may be intentional).
- NOT restructuring the test file (Fix Path C is a last resort).
- NOT adding new tests.
- NOT touching EFB-55's shipped script (`scripts/verify-encrypted-wrap.mjs`).

## Coordination points — DM me before

- If you find MORE than 15 root errors (means something changed on main since I measured) — DM with the full count and the new ones' file:line.
- If the tsconfig structure is more complex than expected and Fix Path A/B pollutes worker types — DM before shipping.
- If Fix Path C ends up needed — DM the reasoning.
- Pre-PR: DM the exact tsc-before / tsc-after numbers.

## DM FLOW — MANDATORY

1. DM Sona (session `session-f4e8ed22897d418a`).
2. Status DMs at: post-brief-read (with your read of the tsconfig structure and chosen path), post-fix (with before/after tsc numbers), pre-PR.
3. DO NOT `worker_event_complete` until Sona reviewed AND said shipit.

## Checkpoint caveat

Restore by `checkpointId`. State should name "EFB-65+68 dispatch". If not, DM immediately.

## Standing rules

- Baseline BEFORE this batch: 2 root + 1 web = 3. Baseline AFTER: 2 root + 0 web = 2. Every future ticket after this uses the new baseline.
- Work in your OWN worktree: `git worktree add ../evenflow-efb-65-68 -b efb-65-68-tsc-baseline off origin/main`
- Do NOT run git checkout/pull/reset/merge in the shared checkout at `/Users/evan/projects/evenflow`.
- No focus rings/outlines (not applicable here but reminder).
- `mem_secret_get` via MCP if you need secrets, not CLI.

## Key IDs

- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login` (via MCP)

## Related

- EFB-55 (shipped): introduced the tests/verify-encrypted-wrap.test.ts file that EFB-68 fixes types for.
- EFB-54 (shipped, `bf186285`): Boundary Discipline — the CI check pattern is similar (baseline ratchet).
- Web baseline pre-work: SprintArchive.tsx was the single-file survivor after EFB-27's polish batch.
