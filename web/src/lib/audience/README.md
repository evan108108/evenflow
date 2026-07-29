# Vendored 4a NIP-44 (client side, phase 16.5)

Verbatim copies of `../../../src/lib/audience/{nip44,audience-keys}.ts`
(themselves vendored from the 4a gateway). Needed because key grants carry
the RAW 32-byte epoch scalar — nostr-tools' nip44 cannot round-trip raw
bytes. Keep in lockstep with the Worker copies.
