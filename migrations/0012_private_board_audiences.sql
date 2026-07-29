-- Evenflow D1 schema — migration 0012: private-board audiences (phase 16.5).
--
-- boardCache.is_encrypted (0001) becomes live: 1 = private board whose
-- events publish as NIP-59 gift-wraps to the board's 4a audience instead
-- of plaintext. The flip is one-way in v1 (private→public is a 409).
--
-- audience_epoch / audience_pubkey track the board's 4a audience: the
-- aud_id pubkey never rotates; the epoch (and its keypair) bumps on every
-- member removal — honest crypto, no soft revocation.
--
-- boardAudienceKey holds the server-side key material, NIP-44-encrypted at
-- rest to the EVENFLOW_AUDIENCE_SECRET server key (the 18b
-- orgStorageConfig posture: ciphertext + ephemeral sender pub, never
-- plaintext scalars in D1).
--
-- boardMemberKeyGrant: one row per (board, member, session-key, epoch).
-- member_pubkey is the OAuth stand-in ("github:123") used for authz;
-- recipient_pubkey is the member's per-session secp256k1 pub — the actual
-- NIP-44 recipient — because web users hold no long-lived keys (multi-
-- device = several live session keys per member). grant_ciphertext is the
-- bare 32-byte epoch scalar under NIP-44 v2, same wire shape as the
-- kind-30521 content.
--
-- sessionKeyRegistrations: per-session client keypairs, keyed by jwt_hash
-- like sessionCache (D1-authoritative, not a projection).

ALTER TABLE boardCache ADD COLUMN audience_epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE boardCache ADD COLUMN audience_pubkey TEXT;

CREATE TABLE IF NOT EXISTS boardAudienceKey (
  board_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  aud_id_pubkey TEXT NOT NULL,
  epoch_pubkey TEXT NOT NULL,
  aud_id_priv_ciphertext TEXT NOT NULL,
  epoch_priv_ciphertext TEXT NOT NULL,
  sender_pubkey TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (board_id, epoch)
);

CREATE TABLE IF NOT EXISTS boardMemberKeyGrant (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  member_pubkey TEXT NOT NULL,
  recipient_pubkey TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  grant_ciphertext TEXT NOT NULL,
  grant_sender_pubkey TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_boardMemberKeyGrant_board_member ON boardMemberKeyGrant(board_id, member_pubkey, epoch);

CREATE TABLE IF NOT EXISTS sessionKeyRegistrations (
  jwt_hash TEXT PRIMARY KEY,
  member_pubkey TEXT NOT NULL,
  session_pubkey TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessionKeyRegistrations_member ON sessionKeyRegistrations(member_pubkey, expires_at_ms);
