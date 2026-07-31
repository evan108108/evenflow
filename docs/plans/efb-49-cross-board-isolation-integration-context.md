# EFB-49 — Live integration test for cross-board isolation on attachment path

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-49`

## Scope one-liner

Follow-up from EFB-35's bug 2 finding. The mock-layer hole is closed (`WHERE short_id = ? AND board_id = ?` handler now correctly hoisted above the generic prefix). But the LIVE `src/routes/attachments.ts:205` route has never been proven correct end-to-end — the D1 layer probably enforces `board_id` correctly, but "probably" isn't a test.

Add a real integration test hitting the actual attachments route with `wrangler dev` + local D1.

## Load-bearing surprises

1. **The bug was in TEST INFRASTRUCTURE, not the live route.** EFB-35 closed a mock that silently dropped `board_id`, which caused tests to pass without asserting cross-board isolation. There's no known bug in the live route — this ticket proves the LIVE assertion, not fixes a live bug.

2. **Attachments path is Blossom-backed** (per EFB-24 area, phase 18a). Actual file bytes live at `blossom.band` (or a BYOB bucket if the board has one configured). The API's role is metadata lookup + presigned URL generation. The `board_id` check in the query IS the isolation boundary; leak would mean returning a URL for another board's file.

3. **`wrangler dev` + local D1 requires setup.** Fresh worktree, `npm ci`, then `npm run dev` (or the workspace-specific equivalent). D1 local operates on `.wrangler/state/v3/d1/<binding>/db.sqlite3`. Seed two boards and issue attachments via API to make the test setup real, not synthetic.

4. **Not a mock test.** The whole point of this ticket is to prove the LIVE route's isolation. A test that reintroduces mocks defeats the purpose. Use `wrangler dev`'s actual worker + actual D1.

## Files to touch

| File | Change |
|---|---|
| `tests/integration/attachments-cross-board.test.ts` (new) | Integration test hitting live `wrangler dev` |
| `package.json` (maybe) | New script `test:integration` if one doesn't exist |
| Test scaffolding | Whatever's needed to spin up wrangler dev, seed D1, tear down cleanly |

Investigation step first: check if evenflow has any existing integration-test scaffolding. If yes, extend it. If no, this ticket introduces the first one — bigger scope, DM Sona before building the whole framework.

## Testing (what the test itself asserts)

Seed two boards (boardA, boardB) in local D1 with distinct owners:
1. **Baseline:** attach a file to boardA's issue via the real endpoint. Fetch attachment metadata via boardA context → 200 with file details.
2. **Cross-board attempt via URL:** attempt to fetch the attachment via a URL that references boardB (e.g. `/api/v0/orgs/.../boards/boardB/issues/EFB-N/attachments/<attachment-id>`) → 404 or 403 (NOT the attachment).
3. **List attachments for boardB's issue via a shape that would leak boardA's** → empty list.
4. **Presigned URL leak check:** if the presigned URL is board-scoped, generating one for boardA and using it in boardB context → rejected. If presigned URLs are content-addressed and not board-scoped, that's a separate design concern worth naming.

Full suite green. tsc unchanged (baseline: 2 root + 1 web).

## Deploy context

- Prod evenflow at v `b85c3a99` (post-EFB-45 + EFB-36).
- NO code changes to the live route in this ticket (unless the integration test surfaces a real leak — in which case widen scope with a security-hardening ticket).
- No deploy needed unless the test finds a bug.
- Auth for wrangler dev: local, doesn't need Cloudflare credentials.

## Key IDs

- Board (real example): `4042afb7-d1fe-4a80-a311-9de404b0ee14` (@evan108108/evan-s-flow-board) — for shape reference only, DO NOT use in tests
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`

## Related

- EFB-35 (shipped): fixed the mock hole (DbMock fail-loud + hoisted specific handler above general). Discovered the coverage gap this ticket closes.
- Attachments path: `src/routes/attachments.ts:205`

## Coordination points — DM me before

- If no integration-test scaffolding exists and this ticket needs to build a framework — that's a bigger scope, DM to confirm
- If the test actually surfaces a leak in the live route — that's a security issue, DM immediately, do NOT publish the test that documents the exploit before we fix
- Any change to the attachments route itself unless the test discovers a bug

## DM FLOW — MANDATORY

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. Sona is AFK; replies via channel notifications.
3. Status DMs at meaningful phases: scaffolding decision, test writing, results (isolation holds or leak found).
4. **DO NOT `worker_event_complete` until Sona reviewed AND said shipit.**
5. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Checkpoint caveat

Three parallel dispatches out. VERIFY BY CONTENT. State should say "EFB-49 dispatch". If not, restore from brief committed on origin/main.

## Standing rules

- NO deploy without approval. PR target: `main`.
- Baseline: 2 root + 1 web pre-existing tsc errors.
- Test-only work unless the test finds a real leak.
