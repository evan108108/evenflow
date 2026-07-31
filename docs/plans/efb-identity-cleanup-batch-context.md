# EFB Identity Cleanup Batch — EFB-51 + EFB-52

Two identity-layer follow-ups from EFB-41/42. Bundled batch.

## Tickets

1. **EFB-51** (1pt) — `profile.ts:379 GET /profile/:pubkey` normalize. Last :pubkey route not normalized. Full spec: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-51`
2. **EFB-52** (2pt) — Consolidate npub bech32 decode into one gate. Client has its own decoder at `web/src/lib/nostr.ts`; extract worker-side pure identity helpers into a shared module (EFB-34 pattern). Full spec: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-52`

## Suggested order

1. **EFB-51 first** — small, contained, extends shipped EFB-41/42 pattern. One curl-shaped fix.
2. **EFB-52 second** — cross-cutting, needs care around type-only imports. Uses EFB-34's `board-events.ts` extraction as the model.

One commit per ticket. Full-batch DM at end.

## Load-bearing surprises

### EFB-51

1. **Reuse `canonicalizeIdentityRef` from `src/lib/identity.ts` (EFB-38 + EFB-41)** — do NOT invent a new normalization path.
2. **Failure shape:** malformed → `400 {reason: 'pubkey'}` NOT 404. Distinguishes "caller sent junk" from "profile not found."
3. **Query the profile store with normalized canonical form.** A raw-hex or npub-form URL now resolves to the same canonical stored profile.
4. **Do NOT touch write paths** — those are already normalized (EFB-38).

### EFB-52

1. **The client's decoder path lives somewhere in `web/src/lib/nostr.ts` or similar.** Grep for `nip19`, `bech32`, `npub` in `web/src/`. May already gate on type correctly; may not. Read before writing.
2. **EFB-34 pattern is the model:** `src/durable-objects/board-events.ts` is import-free and re-exported from BoardDO.ts. Same shape works for identity — extract the pure functions (`canonicalizeIdentityRef`, `isNpub`, type constants) into an import-free `src/lib/identity-shared.ts` (or similar), re-export from `identity.ts` for backwards compat. Web imports directly from `identity-shared`.
3. **The security-critical `type === "npub"` gate lives with the decode.** Wherever the decoder ends up, the gate follows. The `note1` dangerous-test from EFB-41 should have a client-side equivalent (encoding Sona's pubkey bytes as a `note1`, asserting rejection).
4. **`isRosterMember` and DB-touching helpers STAY in `identity.ts`** — those need worker context. Only PURE helpers move to the shared module.

## Files to touch

| Ticket | File | Change |
|---|---|---|
| EFB-51 | `src/routes/profile.ts:379` | Normalize `:pubkey` route param via `canonicalizeIdentityRef`; 400 on null; query store with normalized value |
| EFB-51 | Profile route tests | 4 tests: canonical baseline, raw hex normalized, npub normalized, malformed → 400 |
| EFB-52 | New `src/lib/identity-shared.ts` (or similar) | Extract pure helpers: `canonicalizeIdentityRef`, `isNpub`, NPUB regex, PROVIDER_REF regex, IdentityRef type |
| EFB-52 | `src/lib/identity.ts` | Re-export from shared; keep `isRosterMember` here |
| EFB-52 | `web/src/lib/nostr.ts` (or wherever) | Delete duplicate decoder; import from shared |
| EFB-52 | `web/` and `tests/` | Add web-side dangerous-test analog to EFB-41's `note1` |

## Where things live

- `canonicalizeIdentityRef` + `IdentityRef` + `isRosterMember`: `src/lib/identity.ts` (EFB-38 + EFB-41)
- Shared cross-program pattern: `src/durable-objects/board-events.ts` (EFB-34)
- `nostr-tools nip19`: already root dep
- EFB-41's `note1` dangerous-test in `tests/identity.test.ts` — carry the pattern into web tests

## Testing

Full suite green (both root and web). tsc unchanged bar the pre-existing 2 root + 1 web (SprintArchive:94).

Per EFB-51: 4 tests (canonical baseline, raw hex normalized, npub normalized, malformed → 400).

Per EFB-52: existing identity.test.ts still green (re-export preserves API); new web-side tests for the pattern; verify by breaking (revert the type gate on ANY decoder, at least one test goes red).

## Deploy context

- Prod evenflow at v `05e0a796` (post-EFB-47).
- No schema changes. `wrangler deploy` after web build.
- Auth via `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` per hard rule.

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14`
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- Sona npub: `npub1qjdk9rzwrr2kycnlmyjda2xadl5c6nwnp98askjnmpxq75sek0pqr3fl3a`
- Sona note1 (dangerous-test): `note1qjdk9rzwrr2kycnlmyjda2xadl5c6nwnp98askjnmpxq75sek0pqjm2zg4`
- JWT: `mem_secret_get evenflow_login`
- API key (preferred): `mem_secret_get evenflow_apikey`

## Related

- EFB-38 (shipped): IdentityRef pattern originator
- EFB-41 (shipped): npub bech32 decode + `note1` dangerous-test
- EFB-42 (shipped): 4 CRUD :pubkey routes normalized
- EFB-34 (shipped): cross-program pure-module extraction pattern
- Both tickets filed by worker-6 in EFB-41+42 PR description

## Coordination points — DM me before

- If EFB-52 finds the client decoder is more entangled than the brief assumes (imports web-specific things), option (a) shared-import may not be clean — DM to discuss option (b) keep-both-add-dangerous-test.
- Any change to security gate shape — EFB-41 got that right, don't refactor into it.

## DM FLOW — MANDATORY

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. Sona is AFK — replies via channel notifications.
3. DM per ticket commit + full-batch DM at end.
4. **DO NOT `worker_event_complete` until Sona reviewed AND said shipit.**
5. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Checkpoint caveat

Three parallel dispatches out today. VERIFY CHECKPOINT BY CONTENT. State should say "EFB Identity Cleanup Batch dispatch". If not, restore from brief committed on origin/main.

## Standing rules

- NO deploy without approval. PR target: `main`.
- Baseline: 2 root + 1 web pre-existing tsc errors.
- Backend + web + tests; no substrate/migration changes.
