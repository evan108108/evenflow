-- Evenflow D1 schema — migration 0013: Nostr sign-in (phase 16.7).
--
-- session_key_source distinguishes 16.5's per-session EPHEMERAL client
-- keypairs from a REAL long-lived secp256k1 key registered by a
-- Nostr-signed-in caller (provider "nostr"). For 'nostr' rows,
-- session_pubkey IS the member's real curve point — private-board key
-- grants addressed to it are level-4 e2e: only the member's own private
-- key (browser extension, agent process memory, or opt-in tab storage)
-- can decrypt; the server never holds it.

ALTER TABLE sessionKeyRegistrations ADD COLUMN session_key_source TEXT NOT NULL DEFAULT 'ephemeral' CHECK(session_key_source IN ('ephemeral','nostr'));
