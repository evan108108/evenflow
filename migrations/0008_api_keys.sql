-- Evenflow D1 schema — migration 0008: developer API keys.
--
-- (0007 is reserved for phase 18c+d, in flight on a parallel branch —
-- numbers stay disjoint so neither branch rebases into a collision.)
--
-- apiKeys is NOT a *Cache table: D1 is its source of truth, same posture
-- as webhookRoutes / sessionCache. Plaintext keys are never stored —
-- key_hash is sha256(plaintext), and prefix (the first 12 chars,
-- "evk_" + 8) exists only for display and as the fast lookup index; the
-- hash comparison is the actual authentication.

CREATE TABLE apiKeys (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER,
  revoked_at_ms INTEGER
);
CREATE INDEX idx_apiKeys_prefix ON apiKeys(prefix);
CREATE INDEX idx_apiKeys_pubkey ON apiKeys(pubkey);
