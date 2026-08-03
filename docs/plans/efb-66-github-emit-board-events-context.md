# EFB-66 — Github-driven transitions emit BoardEvents (SSE + 30553 substrate publish)

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-66`

## Scope one-liner

Github-driven transitions today emit ZERO BoardEvents. That means: SSE clients don't see github moves live (invisibility-until-reload), AND the 30553 KanbanStatusChange substrate publish path never fires for github callsites. This ticket closes both by emitting `issue.transitioned` at the github route post-executePlan, threading the necessary state through AppliedAction.

## Evan's ask (from email)

> "We should probably emmit board events on GitHub transitions or any trasitions. What is your take on this?"

Sona's take: **yes**. This is the emit-gap worker-1 found during EFB-56 (which shipped the helper-side extraction). Two consequences of the current state, both real:

1. **SSE gap** — connected board clients don't see github-driven moves until page reload. Real UX bug for teams using github integration.
2. **Substrate gap** — 30553 publish path never fires for github callsites. Substrate audit trail is incomplete for those transitions.

Both close with the same fix: emit `issue.transitioned` at the API layer after `executePlan` returns.

## Load-bearing surprises

1. **`AppliedAction` currently lacks `statusChangeId` + from/to statuses.** Signature at `src/github/execute.ts` is `{ issue_id, short_id, kind, detail, applied }`. Emitting `issue.transitioned` with EFB-33's status_change_id envelope requires threading these fields OUT of `applyEffect` → `executePlan` → `routes/github.ts:423`.

2. **EFB-56 shipped the shared helper** — `lib/status-change.ts insertStatusChange` returns the id. Both github/execute.ts and routes/issues.ts creation now call it and capture the id. THIS ticket makes the github callsite USE that captured id to build the board event.

3. **Emit at the API layer (route handler), not at execute.ts.** Per EFB-56's "consolidate at the API layer" discipline — same reason we didn't put the publish inside the helper. `src/routes/github.ts:423` post-`executePlan` is the correct site.

4. **Iterate applied transitions** — one github webhook can trigger multiple transitions (rule engine fires N rules against one event). Emit one `issue.transitioned` per applied transition, threading each's status_change_id.

5. **Product-visible SSE behavior change** — after this ships, board tabs currently open will START receiving github-driven moves live. That's arguably a UX win but worth naming in the PR body: "users who see github events as 'lazy async' will start seeing them jump live in the board." Evan approves per email.

6. **`emitSecureBoardEvent`** already handles the public-vs-encrypted routing and the substrate publish path. Just call it with the right event shape and both SSE and 30553 flow correctly.

## Files to touch

| File | Change |
|---|---|
| `src/github/execute.ts` `AppliedAction` type | Extend to `{ issue_id, short_id, kind, detail, applied, statusChangeId?, fromStatus?, toStatus? }` (optional because non-transition kinds don't have them) |
| `src/github/execute.ts` `applyEffect` | Where a status change happens: capture the id returned by `insertStatusChange` (post-EFB-56) + from/to statuses; attach to AppliedAction |
| `src/github/execute.ts` `executePlan` | Return the augmented AppliedAction array unchanged (structural change, thread through) |
| `src/routes/github.ts:423` post-executePlan | For each applied AppliedAction where `kind === "transition"` (or however transitions are keyed): call `emitSecureBoardEvent(board_id, { kind: "issue.transitioned", issue_id, status_change_id, at_ms, payload: {issue, from_status, to_status, from_container, to_container} })` |
| Tests | github-driven transition triggers `emitSecureBoardEvent` with correct payload + status_change_id; public board github transition stamps 30553; SSE assertion on the emitted event kind |

## Where things live

- Board event vocabulary + kinds: `src/durable-objects/board-events.ts`
- Emit surface: `src/audiences.ts emitSecureBoardEvent`
- 30553 publish templating: `src/lib/kanban/publish.ts` (via templateFor gated on issue.transitioned kind)
- EFB-56's shared writer: `src/lib/status-change.ts insertStatusChange` (returns id)
- Github callsite: `src/routes/github.ts:423` post-executePlan
- Existing UI-driven emit pattern to mirror: `src/routes/issues.ts` PATCH handler (post-EFB-33)

## Testing

- **Unit:** github-driven transition via `applyEffect` returns AppliedAction with statusChangeId + from/to populated
- **Integration:** POST to github webhook route with a real event → assert `emitSecureBoardEvent` called with `issue.transitioned` + correct `status_change_id`
- **Substrate:** public-board github transition → assert `statusChangeCache` row's `substrate_event_id` stamped (30553 published)
- **SSE end-to-end (smoke, post-deploy):** open SSE stream on tide-test-public, trigger github transition via the rules engine, assert client receives `issue.transitioned`
- **Regression:** UI-driven transitions still emit as before (EFB-33 baseline unchanged)
- **Non-transition github actions** (comment.created via github, etc.): should NOT emit `issue.transitioned` (only apply where kind is a transition)

## Deploy context

- Prod evenflow at `30d455af` (post-EFB-56)
- No D1 changes
- Standard evenflow deploy per hard rule
- **Product-visible SSE behavior change** — after deploy, boards with github integration will start showing github-driven moves live in open tabs. Not a regression, just a change users will notice (positively expected).

## Key IDs

- Board (smoke): `4042afb7-d1fe-4a80-a311-9de404b0ee14`
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login` (via MCP, NOT the CLI)

## Related

- EFB-56 (shipped, PR #38, `3dbb68a`): shared helper + creation-fix side of the two-part gap. THIS ticket closes the emit-side.
- EFB-33 (shipped): 30553 publish path this extends to github callsite
- EFB-24 (shipped): substrate publish groundwork

## Coordination points — DM me before

- Any AppliedAction shape change beyond what's spec'd (e.g. if you find a non-transition github callsite that ALSO needs to emit — DM, don't fold)
- If you discover other emit sites in github/execute.ts that also skip emitSecureBoardEvent (e.g. github comment sync) — flag before absorbing
- SSE integration test setup if it needs new harness plumbing
- Pre-deploy always

## DM FLOW — MANDATORY

1. DM Sona (session `session-f4e8ed22897d418a`).
2. Status DMs at meaningful phases: AppliedAction shape design, threading through executePlan, emit callsite, tests, pre-deploy.
3. DO NOT `worker_event_complete` until Sona reviewed AND said shipit.

## Standing rules

- No deploy without approval
- Baseline: 2 root + 1 web pre-existing tsc errors
- Work in your OWN worktree (git worktree add ../evenflow-efb-66 -b efb-66-github-emit off origin/main)
- Do NOT run git checkout/pull/reset/merge in the shared checkout
- `mem_secret_get` via MCP for secrets, not CLI
