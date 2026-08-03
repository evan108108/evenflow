# EFB-55 — Encrypted-substrate observability: decrypt-with-key verifier

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-55`

## Scope one-liner

Ship **Option 1** from the ticket body: a small CLI verifier that takes an audience secret + a candidate relay-observed 1059 wrap, unwraps via NIP-59/44, prints the inner event. Closes the "worker-side-provable only" gap discovered during EFB-32 verification.

Options 2 (gateway `/v0/audience/:board/events` endpoint) + 3 (client-side UI page) are explicitly out of scope for this ticket — they become follow-ups if Option 1 proves the ergonomic pattern is useful.

## Motivation (from EFB-32 postmortem)

Worker tailing wrangler logs is currently the only way to prove a private-board substrate publish landed. Public-relay queries return 0 wraps for the audience — expected for encrypted fan-out — so silence-as-signal is the only proof, and it requires operator log access. That's fragile. A user with the audience secret should be able to verify their own board's publishes from outside the worker.

## Approach

**Tool: `scripts/verify-encrypted-wrap.mjs` (or `.ts` compiled)** — a bin script that:

1. Takes `--secret <hex>` (audience nsec / raw private key) and `--wrap <event-json>` (a 1059 event from relay query, JSON).
2. NIP-59 unwrap: decrypt the wrap using audience secret → get seal → decrypt seal → get inner rumor.
3. Print inner rumor as pretty JSON with kind, tags, content, signature validation status.
4. Exit code: 0 on successful unwrap, non-zero on decrypt failure or malformed input.

**Reuse existing NIP-44/59 code from Sonata's 4a-webhook-relay plugin at `/Users/evan/memory/Sonata/plugins/4a-webhook-relay`** — same primitives, don't re-implement. If the reuse is cross-repo-awkward, copy the specific unwrap functions into `scripts/lib/nip59-unwrap.mjs` with a comment naming the source.

## Load-bearing surprises

1. **The wrap's outer pubkey is EPHEMERAL — do NOT try to validate it against any known key.** NIP-59 spec: each wrap generates a fresh signing key. The verification story is "can I decrypt with MY audience key," not "who signed the wrap."

2. **The seal signer IS meaningful.** After unwrap, the inner rumor's `pubkey` is the actual publisher. Print it prominently. For evenflow public-board republishes into audience, this is the evenflow worker's known publisher pubkey — verifiable against a known-good.

3. **Bin script, not npm-served endpoint.** This is a diagnostic tool for operators + users with audience secrets, not a web-facing feature. Ship in `scripts/`, add to package.json as `"verify-wrap": "node scripts/verify-encrypted-wrap.mjs"`.

4. **No new secrets, no new deploy, no D1 change.** Pure additive tooling.

## Files to touch

| File | Change |
|---|---|
| `scripts/verify-encrypted-wrap.mjs` (new) | The bin script. ~100-150 lines including arg parsing + unwrap + pretty print. |
| `scripts/lib/nip59-unwrap.mjs` (new, optional) | If reuse from Sonata is cross-repo-awkward, copy the specific unwrap helpers with source comment. |
| `package.json` | Add `verify-wrap` script pointing at the bin. |
| `docs/verify-encrypted-wrap.md` (new) | Usage: how to fetch a candidate wrap from a relay, how to get your audience secret, how to run the script. 3 worked examples. |
| Test | Round-trip test: wrap a known event with a test key, unwrap with the same key via the script, assert output matches input. |

## Non-goals

- No gateway endpoint (Option 2 — separate follow-up)
- No SPA UI (Option 3 — separate follow-up)
- No changes to publish path, no changes to worker behavior
- No key-management surface (users bring their own secret to the script)

## Testing

- Round-trip unit test as above
- Manual verification: fetch a real 1059 wrap from a public relay for your own audience, run the script, confirm the inner event is what you emitted

## Deploy context

- Prod evenflow at `e05819a5` (post-EFB-58)
- No wrangler deploy needed — this is client-side / operator tooling
- No D1 changes

## Coordination points — DM me before

- If the Sonata plugin's NIP-59 code turns out to be structurally different from what evenflow's audience path expects — DM before diverging
- If you find the wrap-event schema differs subtly from Sonata's expected shape (evenflow's gateway may add its own metadata) — DM
- Pre-add-to-package.json — always

## DM FLOW — MANDATORY

1. DM Sona (session `session-f4e8ed22897d418a`).
2. Status DMs at meaningful phases (script skeleton, unwrap logic, tests, docs).
3. DO NOT `worker_event_complete` until Sona reviewed AND said shipit.

## Checkpoint caveat

Restore by `checkpointId`. State should name "EFB-55 dispatch". If not, DM immediately.

## Standing rules

- No secrets in logs
- Bin script exits non-zero on any decrypt failure
