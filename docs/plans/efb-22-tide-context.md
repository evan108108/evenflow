# EFB-22 — Sprint Tide implementation context

Companion to the ticket body (EFB-22, uuid `e371b538-42e4-447b-a617-b30810ed1e85`). Read the ticket first for **what** we're building; this doc is **where the code lives** and **what will surprise you**.

Every path is absolute under `/Users/evan/projects/evenflow`. Line numbers are anchors — verify before editing; the file may have shifted a few lines.

---

## Load-bearing surprises (read these before writing any code)

1. **The plaintext kanban kinds (30550–30554) have NEVER been published from evenflow.** Every route file has a comment saying "publishing lands in the event-publisher phase" (`src/routes/issues.ts:6`, `comments.ts:3`, `boards.ts:9`) — that phase never landed. Only the encrypted-board path (30555/30556/30557) and the org/grant path (30520/30521 via `FourA`) actually POST to 4a today. **EFB-22's kind 30560 (public tide) is establishing the pattern for public kanban publishing.** Pick a signer story that will scale to backfilling 30550–30554 later.

2. **No `scheduled` handler exists.** `wrangler.toml` (all 53 lines) declares zero `[triggers]`. `src/index.ts:173` exports `app` — the Hono fetch handler only, no `{ fetch, scheduled }` object. EFB-22's daily cron is greenfield plumbing: adding a `[triggers]\ncrons = ["…"]` block AND changing the default export shape. Two other files (`src/membership.ts:8-9`, `src/routes/github.ts:303`) already flag "we need a scheduled trigger" as known gaps — solving it for tide unlocks them too.

3. **No substrate retry state anywhere.** Outages just print `{"warn":"substrate-publish-deferred",…}` to Cloudflare Logs and drop the event. `src/membership.ts:8` says `// TODO(substrate-retry): sweep rows WHERE substrate_event_id IS NULL and republish` — never implemented. For tide, either accept "lost snapshots are lost" (fine, since the next roll-forward is deterministic from D1 audit rows) or introduce the first retry table. Ticket body implies option A — a NULL `substrate_event_id` is fine because the sparkline is computed from `sprintMembership + statusChangeCache + issueEstimateHistory` regardless of whether the 4a publish succeeded.

4. **`encryptedKindOf` at `src/audiences.ts:423-427` is a silent-default string-prefix switch.** Anything that doesn't start with `issue.` or `comment.` becomes `KIND_ENCRYPTED_BOARD` (30555). If you don't add an explicit `sprint.tide` branch, private-board tide events publish as 30555 — technically valid wraps, wrong kind, silent bug. **You MUST edit `encryptedKindOf` to return 30565 for `sprint.tide.*`.**

5. **`BoardEventKind` is a closed union at `src/durable-objects/BoardDO.ts:14-21`.** Every SSE event kind is a literal in that union. Add `"sprint.tide.updated"` (or whatever you name it) to the union or TypeScript will reject `emitSecureBoardEvent({ kind: "sprint.tide.updated", … })`.

---

## Where things live

### Signing / auth

- **All 4a-facing secrets** declared at `src/effects/AppEnv.ts:27-59`. Three 32-byte hex Worker secrets today: `EVENFLOW_BLOSSOM_SECRET`, `EVENFLOW_STORAGE_SECRET`, `EVENFLOW_AUDIENCE_SECRET`, plus `EVENFLOW_WEBHOOK_SECRET`. Comment on :39-58 says **"no key reuse across contexts"** — if tide needs its own key material, mint a new secret. (For tide it does not — publishes go through the board's aud_id signer for encrypted, and via `FourA` KMS-signed path for public. See §Publishing story.)
- **Event signing primitive**: `signEvent` / `__signEvent` at `src/lib/audience/nip17.ts:83-87` (BIP-340 hash + `@noble/curves` schnorr).
- **NIP-98 HTTP auth**: `src/lib/audience/nip98-sign.ts:64-94` — kind 27235, `Authorization: Nostr <base64(json)>`. Every `Audience.rawPost` uses this.
- **Composite Nostr member stand-in** (`nostr:<hex64>`): `src/nostr.ts:12-42`. The `realPubkeyOfMember(pubkey)` extractor is here — use it whenever you compare against a raw hex pubkey (e.g. audience recipients).

### The two publishers

**(a) `FourA` — JWT-authed, KMS-signed at gateway.** `src/effects/FourA.ts:148-224`. POSTs to `https://api.4a4.ai/v0/publish/{profile,org,grant,grant_revoke}` and `/v0/blob`. **Evenflow holds no key material — the gateway signs.** Auth is user JWT. Only kind-0 / 30520 / 30521 today. If you add public kind 30560 through this path, you're adding a new `/v0/publish/kanban_tide` endpoint on the gateway side too. Cleanest precedent for public kanban.

**(b) `Audience` — locally NIP-98-signed with the board's `aud_id` privkey.** `src/effects/Audience.ts:48-73`. POSTs to `/v0/audience/raw/{publish-declaration,grant,rotate,publish-wraps}`. **This is the only door that accepts encrypted 30555-30559 (and 30565).** Signer key material comes from D1 (`boardAudienceKey` table, sealed with `EVENFLOW_AUDIENCE_SECRET`).

### The encryption path (private boards)

Everything lives in `src/audiences.ts`. Read the file top-to-bottom once; it's the single most important file for EFB-22.

- **Kind constants**: `KIND_ENCRYPTED_BOARD=30555`, `KIND_ENCRYPTED_ISSUE=30556`, `KIND_ENCRYPTED_COMMENT=30557` at `audiences.ts:44-47`. Add `KIND_ENCRYPTED_TIDE=30565` here.
- **`encryptedKindOf` (audiences.ts:423-427)**: extend for `sprint.tide.*` → 30565.
- **`encryptBoardEvent` (audiences.ts:440-470)**: the wrap-and-sign seam. NIP-44 encrypts the JSON payload with `audIdPriv × epochPub`. Signs a rumor with `audIdPub`. Wraps once per recipient. Tags include `["d", "${board.id}:${entityId}"]`, `["a", "30520:${audIdPub}:${board.id}"]`, `["fa:context", FA_CONTEXT_V0]`, `["fa:epoch", ...]`, `["blake3", ...]`, `["p", ...]` per recipient. **For tide, `entityId` should be the sprint id.**
- **Recipient resolution**: `grantRecipients(boardId, epoch)` at `audiences.ts:199-207` — reads `boardMemberKeyGrant.recipient_pubkey` at the current epoch. Populated by `issueGrantsForMember` at `:165-196` which resolves `[…session_pubkeys, realPubkey]`.
- **`secureBoardEvent` (audiences.ts:478-509)**: the outer wrapper. Encrypts, wraps, POSTs to `/v0/audience/raw/publish-wraps`, returns an SSE-safe envelope (payload replaced with `{enc:true, epoch, ciphertext:null}` on failure — clients refetch via REST). **This is what `emitSecureBoardEvent` calls internally when `board.encryption_active`.**
- **`emitSecureBoardEvent(board_id, event)` (audiences.ts:530-541)**: the ONE call site all routes use. Forks on `board.encryption_active`. **Use this for tide — do NOT hand-roll a fork.**

### Public path today

When `encryption_active === false`, `emitSecureBoardEvent` sends the event to the BoardDO for SSE fanout and **does not touch 4a**. This is the gap. For EFB-22 public 30560 you have to decide:

- **Option A (recommended)**: extend `FourA` with a new `publishKanbanTide(token, {…})` method that calls a new `/v0/publish/kanban_tide` endpoint on the gateway (gateway KMS-signs). Matches the org/grant precedent, no new evenflow key.
- **Option B**: mint an evenflow service key (new `EVENFLOW_KANBAN_SECRET`) and sign locally like the audience path. More work, but keeps the gateway simpler.

Ticket body doesn't force one — ask if unsure. **Recommendation: A.** Simpler evenflow-side, and it establishes the pattern for future 30550-30554 backfill.

### D1 cache pattern for substrate events

Two-tier, applied inconsistently:

- **Tier 1 (used for org/grant)**: `substrate_event_id TEXT NULL` column on the cache row, stamped on successful publish, left NULL on outage. See `migrations/0004_orgs_and_membership.sql:22-51` and `src/membership.ts:31-60` for the "publish, then stamp" pattern.
- **Tier 2 (used for encrypted wraps)**: no cache mirror. `secureBoardEvent` posts and discards the response.

**For tide, use Tier 1.** `sprintTideSnapshot` table (as ticket body specifies) with `substrate_event_id TEXT NULL`. On successful publish, stamp it. On failure, leave NULL — a future retry sweep (see gap #3 above) can pick it up. This is forward-compatible with adding the missing retry table without schema churn.

### Kind registry (there isn't one)

Kinds are declared piecemeal:

- `src/lib/audience/audience-events.ts:19-21` — `KIND_AUDIENCE=30520`, `KIND_KEYGRANT=30521`, `KIND_CLAIM=30522`. Also `FA_CONTEXT_V0 = "https://4a4.ai/ns/v0"` at :18 — every 4a event carries this in an `fa:context` tag. **DO NOT redeclare `FA_CONTEXT_V0`; import from here.**
- `src/audiences.ts:44-47` — encrypted kanban kinds.
- Plaintext 30550-30554 appear only in comments (`shapes.ts:123,189,202`, `PLAN.md:42-52`).

**Add for EFB-22**:
- `src/lib/audience/audience-events.ts` — export `KIND_SPRINT_TIDE = 30560` and a `buildSprintTide(input): EventTemplate` mirroring `buildAudienceDeclaration` / `buildKeyGrant`. Same tag vocabulary (`fa:context`, `alt`, `d`, `a`, `fa:epoch`, `blake3`).
- `src/audiences.ts:44-47` — export `KIND_ENCRYPTED_TIDE = 30565` next to the other encrypted kinds. Extend `encryptedKindOf`.

The `audience-events.ts:6` comment explicitly warns: **"Drift here = silent on-wire incompatibility with the gateway."** Any new event builder must round-trip through the gateway's parser. Coordinate the gateway-side change if publishing 30560 through `FourA`.

### Cron plumbing (net-new)

For the daily roll-forward cron:

1. Add to `wrangler.toml`:
   ```toml
   [triggers]
   crons = ["17 6 * * *"]  # or whatever cadence — pick an off-peak minute
   ```
2. Create `src/scheduled.ts` exporting a `scheduled(event, env, ctx)` function that walks active sprints and calls the tide-compute module.
3. Change `src/index.ts:173` from `export default app;` to `export default { fetch: app.fetch, scheduled }`.

Keep the cron handler thin — mostly `ctx.waitUntil(...)` around the compute module. All heavy logic in `src/lib/tide/*` so the fetch path can reuse it.

---

## End-to-end reference flow (encrypted comment.created)

Steps a tide-snapshot publish should mirror, adapted for private boards:

1. HTTP POST hits route handler.
2. D1 insert into cache table (tide: `sprintTideSnapshot`).
3. Handler calls `emitSecureBoardEvent(board_id, { kind: "sprint.tide.updated", board_id, sprint_id, at_ms, payload: {…} })`.
4. `emitSecureBoardEvent` (audiences.ts:530-541) loads fresh board row, forks on `encryption_active`.
5. Private branch: `secureBoardEvent` → `encryptBoardEvent` (loads epoch keys via `loadEpochKeys` → `openScalarFromServer` using `EVENFLOW_AUDIENCE_SECRET` → NIP-44 encrypts payload → signs rumor with `audIdPub` → wraps per recipient).
6. `POST /v0/audience/raw/publish-wraps` via NIP-98-signed `Audience.rawPost`.
7. Envelope-only SSE event fans out through BoardDO to browser clients (private-board clients then refetch tide via REST).

**Public branch** (option A): `emitSecureBoardEvent` unmodified — plus a parallel call to `FourA.publishKanbanTide(token, {…})` from the route/cron. Do NOT try to shoehorn public publishing into `emitSecureBoardEvent`; keep the fork explicit.

---

## Files you will touch

| File | Change |
|------|--------|
| `migrations/0021_sprint_tide.sql` | NEW — `sprintTideSnapshot` + `issueEstimateHistory` + indexes |
| `src/shapes.ts` | Add `parseSprintTideSnapshotRow` + type |
| `src/lib/audience/audience-events.ts` | Add `KIND_SPRINT_TIDE = 30560` + `buildSprintTide` |
| `src/audiences.ts` | Add `KIND_ENCRYPTED_TIDE = 30565`; extend `encryptedKindOf` |
| `src/durable-objects/BoardDO.ts:14-21` | Add `"sprint.tide.updated"` to `BoardEventKind` union |
| `src/lib/tide/compute.ts` | NEW — walks `sprintMembership` + `statusChangeCache` + `issueEstimateHistory` per day |
| `src/lib/tide/publish.ts` | NEW — public via `FourA`, encrypted via `emitSecureBoardEvent` |
| `src/routes/sprints.ts` | Add `GET /boards/:slug/sprints/:id/tide`; add `GET /boards/:slug/tide` (kanban-only variant) |
| `src/routes/issues.ts` | On PATCH `estimate` change, INSERT into `issueEstimateHistory` |
| `src/effects/FourA.ts` | Add `publishKanbanTide` (if going with option A) |
| `wrangler.toml` | Add `[triggers]` + `crons` |
| `src/scheduled.ts` | NEW — daily roll-forward handler |
| `src/index.ts:173` | Change export to `{ fetch: app.fetch, scheduled }` |
| `web/src/components/TideBadge.tsx` | NEW — sparkline + big number + direction arrow |
| `web/src/pages/board/BoardPage.tsx` | Replace `<div class="current">…</div>` with `<TideBadge/>`; wire sprint-filter respect |

---

## Testing

- **D1 migration**: run against local D1 first, verify tables + indexes.
- **Compute correctness**: unit test `compute.ts` with fixture audit rows; verify remaining/adds/drops match manual math.
- **Encrypted publish**: on a private board, POST a status change, verify a 30565 wrap lands in the gateway (check gateway logs). Verify a member browser can decrypt via the existing audience flow.
- **Public publish**: on a public board, verify 30560 lands (once gateway endpoint exists).
- **Cron**: `wrangler dev --test-scheduled` to trigger the scheduled handler locally; verify a snapshot row is inserted and `substrate_event_id` is stamped.
- **Filter respect**: TideBadge with sprint filter on → uses sprint tide endpoint; filter off → uses kanban-only `/tide`.
- **Empty state**: brand-new sprint (no audit rows) → tide is `{committed_pts:0, done_pts:0, remaining_pts:0, direction:"flat"}`, not a crash.
- **No key material**: if `EVENFLOW_AUDIENCE_SECRET` is unset on a private board, ticket body says "log-and-skip" — verify the snapshot still lands in D1, just no substrate publish.

---

## Coordination points to DM Sona for

Before finalizing, DM Sona (via `dm_send`) on:

- **Signer story for public 30560** — option A vs B. Recommendation is A. If A, need coordinating change in the 4a gateway repo (`/Users/evan/projects/4a`) to add `/v0/publish/kanban_tide` endpoint.
- **Cron cadence** — hourly? daily? Ticket says daily; consider hourly for active sprints so quiet boards don't have huge gaps.
- **Direction thresholds** — what makes it "↘" vs "—"? Rough proposal: `>1pt/day drop → ↘`, `<-1pt/day → ↗`, else `—`. Ask before implementing.
- **Before deploying** — deploy plan, PR review, anything touching 4a gateway.

---

## Key IDs (paste into shell as needed)

- Board id: `4042afb7-d1fe-4a80-a311-9de404b0ee14`
- Board slug: `@evan108108/evan-s-flow-board`
- Sprint 1 id: `01e70cc9-0aaa-4ca9-88d4-ea897f42685e`
- EFB-22 uuid: `e371b538-42e4-447b-a617-b30810ed1e85`
- Sona pubkey (composite): `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT for API calls: `mem_secret_get evenflow_login` (Sona's login)
- Deploy env: `set -a; source /Users/evan/projects/4a/.env; set +a` then `cd /Users/evan/projects/evenflow && wrangler deploy`
