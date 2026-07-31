# EFB Identity Follow-ups — EFB-41 + EFB-42

Two small follow-ups from EFB-38 bundled. Both extend the `canonicalizeIdentityRef` / `assertMember` pattern that EFB-38 established at `src/lib/identity.ts`.

## Tickets

1. **EFB-41** (1pt) — npub1 bech32 support in `canonicalizeIdentityRef`. `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-41`
2. **EFB-42** (1pt) — `:pubkey` route param normalization on lookup endpoints. `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-42`

## Suggested order

1. **EFB-41 first** — pure `canonicalizeIdentityRef` extension. Adds nip19 decode branch. Contained.
2. **EFB-42 second** — normalizes 4 route params on lookup endpoints. Once EFB-41 is in, both raw hex AND bech32 npub forms passed as `:pubkey` route params resolve correctly.

One commit per ticket. Full-batch DM at the end.

## Load-bearing surprises

### EFB-41

1. **`nostr-tools` nip19 is already a root dep.** Verified during EFB-38 audit. Import `nip19.decode`, no new dependency.

2. **`src/nostr.ts` may already have bech32 helpers.** Grep for `nip19`, `bech32`, `npub` before writing new decode logic — reuse if present.

3. **Decode failure should return null** (invalid checksum, malformed), so `validateAssignee` raises the existing ValidationError via the Effect channel. No new error path.

4. **Test the SPECIFIC npub for Sona's own pubkey.** Encode `049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2` to npub, pass to canonicalize, assert output matches the canonical `nostr:049b628c…` that already exists in the boardMemberCache roster.

### EFB-42

1. **Four sites** — `orgs.ts:461/506/640/674`. All `:pubkey` route params on lookup endpoints (member role change, member remove, board member role, board member remove).

2. **`profile.ts:379` `GET /profile/:pubkey` is DELIBERATELY OUT OF SCOPE.** Global profile read, keyed by any pubkey shape the caller might have. If you want to unify it too, that's a separate ticket.

3. **Normalization failure → 400 `{reason: 'pubkey'}`, NOT 404.** Distinguishes "caller sent junk" from "member not found."

4. **After normalization, use the normalized value in the DB WHERE clause.** The old (raw-hex) form of a canonical-stored member now resolves correctly instead of 404-ing.

## Files to touch

| Ticket | File | Change |
|---|---|---|
| EFB-41 | `src/lib/identity.ts` | Add nip19 decode branch before the current npub-reject path; convert to `nostr:<lowercase hex>` |
| EFB-41 | `tests/identity.test.ts` | 4 new tests per ticket §Tests |
| EFB-42 | `src/routes/orgs.ts` (4 sites) | Normalize `:pubkey` param at handler top; 400 on null; use normalized value in DB queries |
| EFB-42 | `tests/orgs.test.ts` | 3 tests per site × 4 sites = 12 tests |

## Where things live

- `canonicalizeIdentityRef` + `IdentityRef` + `NPUB` regex + `isNpub` helper: `src/lib/identity.ts` (from EFB-38)
- `nostr-tools nip19`: verify import path via existing usage in `src/nostr.ts`
- `assertMember` (from EFB-38) — not needed for EFB-42 (:pubkey is a lookup key, not a member reference)

## Testing

Full suite green. tsc unchanged bar the pre-existing 2 root + 1 web.

Per EFB-41: valid npub → canonical, uppercase npub → same canonical (folded), invalid checksum → null, Sona's actual npub → matches existing roster entry.

Per EFB-42: 3 cases × 4 sites — canonical form works (baseline), raw-hex form resolves via normalization, malformed shape → 400 (not 404).

## Deploy context

- Prod evenflow at v `625e962c` (post EFB-44).
- No schema changes. `wrangler deploy` after tests.
- Auth via `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` per hard rule.

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14`
- Org: `nostr-049b628c` (Sona's org where the test members live)
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- Evan canonical: `google:104509077344032735108`
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`

## Related

- EFB-38 (shipped): established the IdentityRef pattern this batch extends.
- Both filed as follow-ups in EFB-38's PR description.

## Coordination points — DM me before

- Any change to canonicalizeIdentityRef beyond the npub decode path (e.g. new provider prefixes) — different scope.
- If EFB-42 finds a 5th `:pubkey` lookup site I missed, DM.

## DM FLOW — MANDATORY

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. Sona is AFK; replies via channel notifications.
3. DM per ticket commit + full-batch DM at end.
4. **DO NOT `worker_event_complete` until Sona reviewed AND said shipit.**
5. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Checkpoint caveat

Multiple parallel dispatches from Sona's session may cause checkpoint clobber (EFB-48). VERIFY YOUR CHECKPOINT BY CONTENT. State should say "EFB Identity Follow-ups dispatch". If not, restore via this brief committed on origin/main.

## Standing rules

- NO deploy without approval. PR target: `main`. One commit per ticket.
- Baseline: 2 root + 1 web pre-existing tsc errors.
