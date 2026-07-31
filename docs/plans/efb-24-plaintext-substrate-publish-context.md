# EFB-24 — Plaintext substrate publish (30550-30554)

Ticket: EFB-24 (uuid `42a02e70-691b-4446-bf3b-25b6b86734e3`). Backfills plaintext 4a substrate publishing for public boards, so public boards become substrate-native the same way private boards already are (30555-30557 wrap path since EFB-22).

## What & why

Public boards today write to D1 and fan out via SSE but publish nothing to 4a. Kinds 30550-30554 are declared in comments only — no code publishes them. This ticket ships publishers for:

- **30550** — `board` (board created / settings changed)
- **30551** — `issue` (created / updated / container_changed / deleted)
- **30552** — `comment` (created / deleted)
- **30553** — `status_change` (transitioned)
- **30554** — `sprint` (created / completed / updated)

For private boards, the existing encrypted-wrap path (30555/30556/30557) already handles this via `emitSecureBoardEvent`. This ticket ADDS the plaintext branch — do NOT touch or regress the encrypted path.

## Load-bearing surprises

1. **The signer pattern EFB-22 established works.** `EVENFLOW_KANBAN_SECRET` (32-byte hex) already exists in evenflow, `Audience.kanbanKeys()` already extracts it. The gateway's `/v0/publish/kanban_tide` NIP-98-signed endpoint already accepts caller-signed events. Same primitives — `requireSignedEvent` + `publishAndStore` — are exported from `audience-raw.ts` and reused. Copy the pattern.

2. **`emitSecureBoardEvent` at `src/audiences.ts:530-541` is the fork point.** Currently it: (a) loads board, (b) if `encryption_active` → wrap-and-publish encrypted, (c) else → SSE fanout only, no substrate. **This ticket makes (c) also publish to 4a via the plaintext kind for the event family.** The private-board privacy fork EFB-22 established (re-read board, fail closed on `encryption_active`) is your model — do the same shape for the new plaintext path.

3. **22 call sites** of `emitSecureBoardEvent` across `src/routes/{issues,comments,sprints,boards}.ts`. You do NOT modify the call sites — you modify `emitSecureBoardEvent` (or add a sibling) so the plaintext branch fires automatically per-event-family. Keeping call sites untouched preserves the "route handlers don't care about substrate" abstraction.

4. **Gateway route family.** The `kanban_tide` route is one specific path. This ticket adds four more: `/v0/publish/kanban_board`, `/v0/publish/kanban_issue`, `/v0/publish/kanban_comment`, `/v0/publish/kanban_status_change`, `/v0/publish/kanban_sprint` (or one dispatcher route that reads kind from the signed event). Worker's call — pick the design that composes best with the router-order gotcha from EFB-22 (specific paths MUST be checked before the generic `/v0/publish/` startsWith at `gateway/src/router.ts` line ~88).

5. **Kind constants + builders** — extend `src/lib/audience/audience-events.ts` with `KIND_KANBAN_BOARD = 30550`, etc. And build functions `buildKanbanBoard(input)`, `buildKanbanIssue`, etc. Each builder mirrors `buildSprintTide` and `buildKanbanTide` shape: signed with `EVENFLOW_KANBAN_SECRET`, NIP-98 wrapped, POST to gateway.

6. **Validators on the gateway side.** Each new kind needs a validator (like `kanban-tide-validator.ts`) that pins the shape: kind, tag vocabulary (`fa:context`, `fa:board`, `fa:type`, `d` tag), content JSON shape. Golden-event tests capturing evenflow's builder output prevent cross-repo drift — same posture EFB-22 used.

7. **D1 cache columns.** Add `substrate_event_id TEXT` NULL columns to `issueCache`, `commentCache`, `statusChangeCache`, `sprintCache`, `boardCache`. Stamp on successful publish. NULL on outage. Migration `0022`.

8. **Cross-repo synchronization guard.** Evenflow's builder asserts exact tag shape it signs. Gateway's validator uses golden events captured verbatim from evenflow's builder. Blake3 assertion catches either side changing content serialization. Same pattern as EFB-22.

## Files to touch

### Evenflow side

| File | Change |
|---|---|
| `migrations/0022_substrate_event_id_columns.sql` | NEW — add nullable `substrate_event_id` to 5 caches |
| `src/shapes.ts` | Add `substrate_event_id` to each affected shape + parser |
| `src/lib/audience/audience-events.ts` | Add 5 new kind constants + 5 builder functions |
| `src/audiences.ts` | Extend `emitSecureBoardEvent` (or add sibling) with plaintext-branch publish. Add `publicKindOf` similar to `encryptedKindOf` |
| `src/effects/FourA.ts` | Add `publishKanban{Board,Issue,Comment,StatusChange,Sprint}` — each signs with `EVENFLOW_KANBAN_SECRET` (already available via `Audience.kanbanKeys()`) and POSTs NIP-98-wrapped |
| Route files (issues/comments/sprints/boards) | **DO NOT MODIFY** — fork happens inside `emitSecureBoardEvent` |
| Tests | One `tide-publish.test.ts`-style test per kind: create issue on public board, verify substrate_event_id gets stamped and unwrapped event on the wire is the right kind |

### Gateway side (branch off main)

| File | Change |
|---|---|
| `gateway/src/kanban-<kind>-route.ts` | NEW — one per kind, OR one dispatcher `kanban-plaintext-route.ts` that switches on the kind of the signed event |
| `gateway/src/kanban-<kind>-validator.ts` | NEW — shape validator per kind |
| `gateway/src/router.ts` | Mount new route(s) **BEFORE** the generic `/v0/publish/` startsWith check (see EFB-22's router-order fix at gateway version `2b964a05` — that bug WILL come back if you don't) |
| `gateway/src/__tests__/kanban-<kind>-validator.test.ts` | Golden-event tests capturing evenflow's builder output byte-for-byte |

### Design call to make while implementing

**One route per kind OR one dispatcher route?** Both work. My lean is **one dispatcher route** (`/v0/publish/kanban_plaintext` or similar) that reads the kind from the signed event and validates+broadcasts, since the auth model is uniform (NIP-98, service key). Reduces the number of router.ts branches. But separate routes are more inspectable at the URL level. DM me for a design ping if you prefer per-kind routes.

## Where things live

- **`Audience.kanbanKeys()`** at `src/audiences.ts` — already returns `{priv, pub}` from `EVENFLOW_KANBAN_SECRET`. Reuse.
- **`buildSprintTide`** at `src/lib/audience/audience-events.ts` — template for the 5 new builders.
- **`emitSecureBoardEvent`** at `src/audiences.ts:530-541` — the fork point. Private-board privacy fork logic there is your safety model.
- **`kanban-tide-route.ts` + `kanban-tide-validator.ts`** — template for gateway-side new routes.
- **`gateway/src/router.ts` line ~88** — the generic `/v0/publish/` startsWith. Specific paths MUST sit above.

## Testing

Per kind:
1. Create/mutate an entity on a **public** test board (make one — `tide-test-public` already exists, id `97d96cac-85cb-4eec-b974-e92b59da2c78`).
2. Verify `substrate_event_id` gets stamped in D1.
3. Fetch the event from 4a gateway and unwrap: assert kind, tag shape, blake3 matches.
4. Verify the same operation on a **private** board still uses the encrypted 30555/30556/30557 wrap path — regression test.

Full suite: worker + web must stay green. `tsc --noEmit` must not introduce new errors (2 pre-existing test-file errors are known — leave alone).

## Deploy context

- **DO NOT DEPLOY without DMing me first.** Prod is at evenflow.work v `d48d1a49`, gateway at v `2b964a05`.
- Migration 0022: apply LOCALLY first (`npm run d1:migrate:local`). NEVER to prod without me approving.
- Gateway deploy: from `/Users/evan/projects/4a/gateway`, `wrangler deploy`. Route order fix from EFB-22 is at gateway version `2b964a05` — verify your new routes are also above the generic `/v0/publish/` startsWith.
- Evenflow deploy: from `/Users/evan/projects/evenflow` (main branch tip is d48d1a49 now; ALL EFB-22 + UI polish shipped).
- **Sequence:** apply migration 0022 → deploy gateway → deploy evenflow → verify substrate_event_id stamping on the public test board.

## Key IDs

- Public test board: `97d96cac-85cb-4eec-b974-e92b59da2c78` (slug `tide-test-public`, under org `nostr-049b628c`).
- Sona pubkey: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login`
- `EVENFLOW_KANBAN_SECRET` already set on evenflow prod (32-byte hex). Same key is used for kanban_tide; reuse for the 5 new kinds — same auth model.

## Related work

- **EFB-22 (Sprint tide)** ✓ shipped + verified. Established the signer pattern this ticket inherits. Full context at `docs/plans/efb-22-tide-context.md`.
- **EFB-29** — Kanban view hangs on public boards (unrelated to substrate publish, frontend loading bug). Not blocking; separate work.

## Coordination points — DM me before

- Any deploy of either side.
- Migration 0022 prod apply.
- The design call on per-kind routes vs dispatcher route (or just make the call and note it in a commit).
- Any change to the private-board encrypted path (regression risk).
- If the "modify emitSecureBoardEvent" approach conflicts with something you find in situ — the goal is to keep route handlers unchanged.

## Suggested commit granularity

1. Migration 0022 + shape parsers
2. Kind constants + builders in evenflow
3. `emitSecureBoardEvent` extension + FourA methods
4. Gateway routes + validators + tests
5. Tests for evenflow-side publish per kind

## Non-goals

- No changes to private-board encrypted path. Regression test that it still works.
- No new tide feature work.
- No client/frontend changes — this is purely backend + substrate wire.
- No auth model changes.
- No mem_task / mem_checkpoint UI counter fixes.
