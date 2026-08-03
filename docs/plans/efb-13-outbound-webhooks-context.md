# EFB-13 — Outbound webhook subscriptions (notifications)

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-13`

## Scope one-liner

Companion to the existing inbound-webhook path. Board owners can register outbound HTTP subscriptions filtered by event type; when a matching internal event fires, we POST the payload (HMAC-signed, mirror inbound) to the subscriber URL. Substrate for Sona-notifies-me, Slack/Discord bridges, GitHub-style user notifications without polling.

## What "in scope" means for THIS ticket

- DB table + migration 0025.
- CRUD REST at `/api/v0/boards/:slug/webhooks` under Boundary Discipline (parseRouteBody + strict schemas — this is a NEW route family, so it MUST be born through the wrapper; do not add anything to `scripts/boundary-allowlist.json`).
- Dispatcher hook inside `emitSecureBoardEvent` (or a downstream tap) that matches active subscriptions on the event's kind + filters, queues deliveries, POSTs with HMAC-SHA256, retries with exponential backoff on 5xx/network.
- Minimal Settings UI page (list + add/edit sheet + delivery-log view). Mirror the shape of `web/src/components/EmailConfigView.tsx` and the routes-CRUD from webhook-relay plan already shipped in Sonata (there's a proven pattern).

## What is EXPLICITLY out of scope

- **No new UI product surface beyond routes CRUD + delivery log.** No filter builder wizard. Simple event-type multiselect + optional single-field predicate string ("assignee=<pubkey>").
- **No org-scoped subscriptions in v1.** Board-scoped only. Org rollup is a follow-up.
- **No auth schemes beyond HMAC-SHA256 (default) and bearer.** Add `stripeSignature`-style variants as follow-ups when a real integration needs them.
- **No user-facing subscription templates or one-click integrations** (Slack app, Discord bot). Deliverable is the RAW webhook surface; templated integrations are per-vendor tickets.
- **Delivery replay button.** Same secrets-at-rest tradeoff as inbound — defer.

## Load-bearing surprises

1. **Two directions of "webhook" now exist in Evenflow.** Inbound is EFB-plan-that-shipped-in-Sonata (`webhook-relay` at `/Users/evan/memory/Sonata/plugins/4a-webhook-relay`); outbound is THIS ticket, entirely inside evenflow. Do not conflate. Read the Sonata plan at `/Users/evan/.claude/plans/sparkling-splashing-garden.md` for the mirror-pattern reference — outbound reuses HMAC-SHA256 semantics + delivery-audit-row shape verbatim so users see the same story in both directions.

2. **`BoardEventKind` is the vocabulary.** See `src/durable-objects/board-events.ts:26-42`. There are 16 kinds today (`issue.created`, `issue.updated`, `issue.transitioned`, `issue.deleted`, `comment.created`, `board.deleted`, `sprint.*`, etc.). The subscription table stores a subscribed-kinds allowlist per row. **Do NOT invent a new "issue.assigned" kind** just because the ticket body names it — assignment is one flavor of `issue.updated` today. Either (a) add a delivery-side predicate that inspects the payload diff, or (b) file a follow-up for adding `issue.assigned` as a first-class kind. Pick (a) for v1 — keeps the vocabulary stable.

3. **Payload is the event object emitted internally.** Do not reshape. The subscribed party gets the same `BoardEvent` shape the SSE stream carries (see `board-events.ts:44-90`). That's the promise: what SSE clients see, webhook subscribers see. **Private-board payloads arrive already-encrypted in the SSE path.** For outbound webhooks on private boards, you have TWO choices — DM Sona before deciding:
   - Ship encrypted payload as-is (subscriber has to be a member and decrypt themselves — very restrictive)
   - Restrict outbound webhooks to public boards only for v1, block-with-400 on private boards (simplest, safest, matches "notification" use case)
   Lean: block-with-400 on private + document as v1 limit.

4. **HMAC secret storage.** Mirror GitHub-webhook precedent (migration 0016 + 0022 in this repo). The secret is stored encrypted under the `EVENFLOW_WEBHOOK_SECRET` Worker secret via AES-GCM (see `migrations/0022_substrate_event_id_columns.sql` tail comments for exact pattern). Reversible on purpose — HMAC needs the plaintext back. New migration 0025 adds the outbound-subscription table; reuse the sealed-secret column pattern.

5. **Delivery queue lives inside a Durable Object OR uses `waitUntil` fire-and-forget.** Do NOT block the emit path on network I/O. Two viable shapes:
   - `ctx.waitUntil(deliverWebhooks(matches))` inside `emitSecureBoardEvent` — simple, cheap, but no cross-request retry (a request that dies mid-flight loses in-flight deliveries).
   - New DO `WebhookDeliveryQueue` with alarm-based retry — proper resilience, more code.
   Lean: `waitUntil` for v1 + a `webhookDeliveries.status='pending'` row so a periodic scheduled sweep can retry orphans. DM Sona if a full DO feels warranted.

6. **`emitSecureBoardEvent` is the hook site.** See `src/routes/issues.ts:681` etc. — 11 callsites in issues.ts alone plus comments + boards + sprints. Do NOT add the dispatcher hook inside each callsite; put it inside `emitSecureBoardEvent` itself (`src/audiences.ts`) after the existing publish path succeeds, so every event kind picks up outbound-delivery for free.

7. **Retry semantics — no infinite retry.** 5xx / network → retry up to 5 times with exponential backoff (60s, 5m, 30m, 2h, 12h). 4xx → dead-letter immediately (subscriber's config is wrong; no amount of retry fixes it). Log all delivery attempts on `webhookDeliveries` for the audit-log UI.

8. **The Boundary Discipline check will bite you.** EFB-54 shipped `check:boundary`. Any new route in `src/routes/webhooks.ts` (or wherever this lands) MUST use `parseRouteBody` from day one. `scripts/boundary-allowlist.json` is CLOSED for new additions — this is written in the check's error message. Read `docs/BOUNDARY_DISCIPLINE.md` before writing the route.

9. **Signed-out / anonymous predicate filters** — DO NOT allow a subscription filter like `assignee=<pubkey>` where the pubkey isn't the caller's own. That would leak per-user activity to whoever pastes their own webhook URL. Enforce: predicate `assignee=<X>` requires caller pubkey to equal X, OR caller is a board admin. Doc it in the schema.

## Files to touch

| File | Change |
|---|---|
| `migrations/0025_webhook_subscriptions.sql` (new) | Table `webhookSubscriptions` (id, board_id, name, url, event_kinds JSON, predicate JSON nullable, auth_scheme, hmac_secret_ciphertext, enabled, created_at_ms). Table `webhookDeliveries` (id, subscription_id, event_id, attempted_at_ms, status_code, response_body TRUNCATED, next_retry_at_ms, attempt_count, terminal). Indexes on (board_id), (subscription_id, attempted_at_ms DESC), (next_retry_at_ms) for the sweeper. |
| `src/shapes.ts` | `WebhookSubscriptionShape`, `WebhookDeliveryShape`. |
| `src/routes/webhooks.ts` (new) | CRUD via `parseRouteBody`. All schemas colocated. Schemas: `PostSubscriptionBody`, `PatchSubscriptionBody`. Enforce anti-leak rule from surprise #9 in the handler (after schema shape passes). |
| `src/index.ts` | Mount `makeWebhooksRouter()` at `/api/v0/boards/:slug/webhooks` (mirror EFB-24's approach). |
| `src/audiences.ts` (`emitSecureBoardEvent`) | AFTER the existing publish path succeeds, `ctx.waitUntil(dispatchOutboundWebhooks(event, ...))`. Isolated helper — must not throw into the emit path even on internal error. |
| `src/lib/webhook-dispatch.ts` (new) | `dispatchOutboundWebhooks(event, ctx, db)`: query matching subs, spawn deliveries. `deliverWebhook(sub, event)`: HMAC-sign, POST, record delivery row. Retry helper for the sweeper. |
| `src/scheduled.ts` | Add a sweep step that queries `webhookDeliveries WHERE terminal=0 AND next_retry_at_ms <= now` and retries them. Cap batch at 50 per tick. |
| `web/src/components/WebhookSubscriptionsView.tsx` (new) | List + add/edit sheet + delivery-log per row. Model on `EmailConfigView.tsx` and Sonata's `WebhookRoutesView.swift`. Copy button for the sub URL (users need to see it for the Slack-relay usecase). |
| `web/src/pages/board/BoardSettingsPage.tsx` | New collapsible section "Webhook subscriptions" delegating to the new view. |
| Test files | Unit: schema rejects unknown keys; predicate leak-guard rejects cross-pubkey filter; HMAC signature matches on delivery; retry backoff; 4xx dead-letters immediately. Integration: emit a `comment.created` → matching sub gets a POST with correct HMAC. |

## Where things live

- Event vocabulary: `src/durable-objects/board-events.ts` (frozen 16 kinds)
- Emit hook: `src/audiences.ts` `emitSecureBoardEvent`
- GitHub-webhook precedent (secret-at-rest pattern): `migrations/0016_github_integration.sql` + `0022_substrate_event_id_columns.sql`
- Boundary Discipline doc: `docs/BOUNDARY_DISCIPLINE.md` — READ THIS FIRST
- Wrapper: `src/lib/route-body.ts` — mirror how EFB-54 uses it in PATCH `/issues/:id` (see `src/routes/issues.ts:884`)
- Inbound webhook mirror (semantics parity, different repo): `/Users/evan/memory/Sonata/plugins/4a-webhook-relay` + `Sources/Actions/WebhookActions.swift` in Sonata core

## Testing

- Full unit + integration suite green
- `npm run check:boundary` — 3/N migrated after this ships (was 2/N post-EFB-60)
- Real HTTP end-to-end: create a subscription pointing at `webhook.site` (throwaway inspector), transition an issue, confirm the POST arrives with `x-evenflow-signature` header and body matches `emitSecureBoardEvent`'s payload verbatim
- Retry: subscribe to a URL that returns 503, confirm 5 attempts spaced by backoff, then terminal
- Retry: subscribe to a URL that returns 404, confirm 1 attempt then terminal (no backoff spin on client error)
- Predicate leak-guard: attempt to register `assignee=<other-user-pubkey>` as non-admin → 403 `predicate-forbidden`

## Deploy context

- Prod evenflow at `fd6f016e` post-EFB-54/EFB-30 landing
- Migration 0025 LOCAL first, DM Sona before prod
- Use `wrangler d1 migrations apply --remote` for tracker safety (per EFB-38 postmortem — do NOT use `execute --file`)
- Standard evenflow deploy: `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` per hard rule
- `git status` before deploy
- If adding a new Worker secret (unlikely — reuse `EVENFLOW_WEBHOOK_SECRET`), coordinate with Sona

## Key IDs

- Board (for smoke testing): `4042afb7-d1fe-4a80-a311-9de404b0ee14` (@evan108108/evan-s-flow-board)
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`
- Handy inspector URL for smoke: https://webhook.site/ (generate one, use as subscription URL)

## Related

- EFB-54 (shipped): Boundary Discipline — mandatory for the new route family
- EFB-60 (pending): duplicate-of Boundary Discipline debt
- EFB-24 (shipped): substrate publish path — parallel-track, DO NOT touch here
- EFB-32 (shipped): board.deleted — one of the event kinds subscribers can subscribe to
- EFB-33 (shipped): 30553 status_change substrate publish — parallel-track
- Sonata plan (INBOUND webhook mirror): `/Users/evan/.claude/plans/sparkling-splashing-garden.md`

## Coordination points — DM me before

- The private-board decision (surprise #3): ship encrypted-passthrough or block-with-400. Lean is block; get explicit sign-off.
- If `waitUntil` fire-and-forget feels wrong for retry (surprise #5) and you want a DO.
- If adding an event kind (surprise #2 — DO NOT do this in this ticket, file a follow-up instead; DM if tempted).
- Schema shape for the predicate — if the "simple `assignee=<pubkey>`" grammar feels insufficient for a real use case, DM instead of expanding.
- Migration 0025 prod apply.
- Pre-deploy.

## DM FLOW — MANDATORY, DO NOT SKIP

You are working under a strict DM-review protocol. This is not optional:

1. **DM me with any questions or concerns.** Do not guess on scope. Do not make ambiguous decisions solo. If you hit anything unexpected — especially any design ambiguity — DM me first.
2. **Give status updates via DM at meaningful checkpoints.** At minimum: after each phase (migration → backend → dispatch hook → UI → tests), after each surprise, before any risky operation.
3. **DO NOT complete the task (worker_event_complete) until you have DMed me for review AND I have returned my review response.** "Task complete" is decided by MY review, not your judgment. Send a summary of what changed, files touched, test evidence, and any open questions — then wait for my "shipit" or my requested changes.
4. Use `dm_send` targeting session `session-f4e8ed22897d418a` (that's me) or `dm_reply` with a message_id if replying to one of my DMs.

## Checkpoint caveat

Multiple parallel dispatches may be out. Restore by `checkpointId` (Sonata core has EFB-48's fix live). If restore returns state that doesn't say "EFB-13 dispatch", DM Sona immediately — do not proceed on wrong context.

## Standing rules

- NO deploy without approval.
- Baseline: 2 root + 1 web pre-existing tsc errors — don't add more.
- Use `wrangler d1 migrations apply --remote` (not `execute --file`) for tracker safety.
- Read `docs/BOUNDARY_DISCIPLINE.md` before writing any route.
- No focus rings/outlines on interactive elements (per user pref).
