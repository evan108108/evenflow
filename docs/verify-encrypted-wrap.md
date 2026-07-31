# Verifying an encrypted board publish

A private board's substrate events go out as NIP-59 gift-wraps (`kind:1059`), one per audience member. Querying a public relay for the audience returns **zero events** — which is correct for encrypted fan-out, and indistinguishable from *"the publish never happened."*

Before this tool, the only proof a publish landed was tailing worker logs, which needs operator access and treats silence as evidence. `scripts/verify-encrypted-wrap.mjs` lets anyone holding the right key prove it from outside.

```
node scripts/verify-encrypted-wrap.mjs --wrap ./candidate.json
```

---

## ⚠️ Which key — read this first

**`--recipient-secret` is the private key of the MEMBER the wrap was addressed to. It is NOT the board's audience key.**

This trips people up because the audience key *feels* like the board's key, so it feels like the one that opens the board's events. It isn't, and the reason is in the wire format:

```
rumor      signed by the AUDIENCE key  ─┐
  ↓ sealed to each member               │  audiences.ts:
seal       signed by the AUDIENCE key   │    wrap(rumor, audIdPriv, recipientPub)
  ↓ wrapped for each member             │
gift-wrap  signed by an EPHEMERAL key  ─┘
```

The outer gift-wrap layer is an ECDH between a **fresh ephemeral key** and the **recipient**. That ephemeral private key is generated per wrap and thrown away immediately, so nothing but the recipient's own private key can open the outer layer. The audience key only appears at the *seal* inside — and you cannot reach the seal without opening the wrap first.

Paste the audience key and you get:

```
[verify-wrap] FAILED: MAC verification failed
```

which reads exactly like a broken publish. **It is not.** It means you used the wrong key. The tool names this case explicitly in its error output for that reason.

If what you want to check is *who published this*, that's `--expect-publisher` with the audience **public** key — no secret required. See below.

---

## Getting the pieces

### 1. The candidate wrap

Query a relay for gift-wraps addressed to your pubkey. Any relay client works; with [`nak`](https://github.com/fiatjaf/nak):

```bash
nak req -k 1059 -p <your-pubkey-hex> wss://relay.damus.io > candidate.json
```

The tool accepts a bare event object, an array of events, or a raw relay `["EVENT", <subid>, {…}]` frame — paste whatever the relay gave you rather than reshaping it by hand.

### 2. Your recipient key

Whichever key the board granted access to. That is either your real Nostr identity key or an ephemeral session key evenflow issued you (see `boardMemberKeyGrant.recipient_pubkey`). Accepted as 64-char hex or `nsec1…`.

### 3. The board's audience public key (optional, for `--expect-publisher`)

The `audIdPub` for the board — visible as the `a` tag on any of its events (`30520:<audIdPub>:<board_id>`), and as the inner rumor's `pubkey` once you've unwrapped one.

---

## Supplying the key without leaking it

In order of preference:

```bash
# 1. environment — not in shell history, not in `ps`
EVENFLOW_RECIPIENT_SECRET=$(cat ~/.evenflow/member.key) \
  node scripts/verify-encrypted-wrap.mjs --wrap ./candidate.json

# 2. a file
node scripts/verify-encrypted-wrap.mjs --wrap ./candidate.json --recipient-secret-file ~/.evenflow/member.key

# 3. inline — convenient, but VISIBLE in shell history and to `ps`
node scripts/verify-encrypted-wrap.mjs --wrap ./candidate.json --recipient-secret <hex>
```

The tool warns on the third form. It never echoes the key — not on success, not in errors, not in `--json` output.

---

## Three worked examples

### A. "Did my board's publish actually land?"

```bash
$ EVENFLOW_RECIPIENT_SECRET=$(cat ~/.evenflow/member.key) \
    node scripts/verify-encrypted-wrap.mjs --wrap ./candidate.json

publisher (inner seal signer): 8f2a…c41d
outer wrap pubkey (ephemeral): 3b90…77ae

{
  "pubkey": "8f2a…c41d",
  "kind": 30555,
  "created_at": 1700000000,
  "tags": [["d", "4042afb7…:issue-9"], ["fa:epoch", "1"], …],
  "content": "…",
  "id": "…",
  "sig": "…"
}
```

Exit `0`. The publish landed, and you are looking at the event evenflow actually emitted.

Note the outer wrap pubkey is labelled **ephemeral**: NIP-59 mints a fresh signing key per wrap, so that value is meaningless as an identity. Do not check it against anything. It is printed only so you can correlate with the relay row you fetched.

### B. "Is this really *my board's* event, not somebody else's?"

Decrypting proves the wrap was addressed to you. It does not prove who sent it. Add the board's audience public key:

```bash
$ EVENFLOW_RECIPIENT_SECRET=… node scripts/verify-encrypted-wrap.mjs \
    --wrap ./candidate.json --expect-publisher 8f2a…c41d

publisher (inner seal signer): 8f2a…c41d
expected publisher:            8f2a…c41d
publisher match:               YES
outer wrap pubkey (ephemeral): 3b90…77ae
…
```

Exit `0`. On a mismatch you get `publisher match: NO`, exit `1`, and the inner event is **still printed** — the decrypt succeeded, so the failure is about identity, and hiding the payload would blur that distinction.

### C. "I got MAC verification failed — is the publish broken?"

Almost certainly not. In order of likelihood:

1. **You used the board's audience key.** See the warning at the top. Use your member key.
2. **The wrap is addressed to somebody else.** A relay query returns every wrap on the subscription, including other members'. Those are *supposed* to fail here — try the other candidates.
3. **You used an old session key** that has since been rotated or revoked (`boardMemberKeyGrant.revoked_at_ms`). Grants are per-epoch; a wrap from epoch 2 will not open with an epoch-1 key.

A genuinely broken publish looks like *no candidate wrap existing at all*, not like a wrap that fails to open.

---

## Exit codes

| code | meaning |
|---|---|
| `0` | unwrapped, and the publisher matched when `--expect-publisher` was given |
| `1` | decrypt, signature, structure, or publisher-match failure |
| `2` | usage error — bad flags, unreadable file, malformed JSON, unsupported Node |

The `1` / `2` split is deliberate: a malformed input is **not** a failed proof. If you cannot tell those apart, a typo in a filename looks like a broken publish.

`--json` emits a single object (`ok`, `publisher_pubkey`, `publisher_matched`, `rumor`, …) for scripting.

---

## Requirements

Node **≥ 22.15** — the tool imports evenflow's own `src/lib/audience/nip17.ts`, which needs native TypeScript type stripping (Node ≥ 22.6, default from 23) plus `module.registerHooks` (≥ 22.15) to resolve its extensionless imports. Older Node exits `2` with a clear message rather than a stack trace.

**Why import from `src/` instead of vendoring a copy of the crypto:** that module is the same code that *writes* these wraps. A verifier carrying its own copy of the protocol can pass while the writer is broken, or fail while the writer is fine — either way its verdict tells you nothing about the path it is meant to be verifying. Sharing the module makes divergence impossible, and any future change to unwrap semantics is picked up here automatically.

---

## Scope

This is Option 1 of EFB-55. Deliberately not included:

- **Option 2** — a gateway `/v0/audience/:board/events` endpoint
- **Option 3** — a client-side UI page

Both become follow-ups if this proves the ergonomic pattern is useful.
