# Vendored 4a audience crypto (phase 16.5)

Build-time verbatim copies — keep in lockstep with their sources:

- `nip44.ts`, `nip17.ts`, `audience-keys.ts` ← `4a/gateway/src/lib/` (canonical)
- `audience-events.ts`, `blake3-tag.ts`, `nip98-sign.ts` ← `Sonata/plugins/sonata-studio/src/` (the client-side precedent; audience-events is itself a restatement of the gateway builders)

Why vendored and not nostr-tools: kind-30521 key-grant content is the RAW
32-byte epoch scalar under NIP-44 v2 — nostr-tools' nip44 UTF-8-encodes
string plaintexts and cannot round-trip raw bytes (see nip44.ts header).
