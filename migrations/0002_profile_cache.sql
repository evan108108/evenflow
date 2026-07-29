-- Evenflow D1 schema — migration 0002
--
-- profileCache: cached view of kind:0 (Nostr user metadata) events for the
-- pubkeys that appear on boards — assignees, comment authors, activity
-- actors. Same cache posture as 0001: the signed kind-0 event on the 4a
-- substrate is the source of truth; these rows are a refreshable
-- projection so chip rendering never blocks on a substrate round-trip.
--
--   * pubkey is Evenflow's caller identity — the provider-qualified
--     `provider:oauth_id` stand-in (see authz.ts callerPubkey), not yet a
--     hex64 Nostr key. The KMS backfill re-keys this table by pure
--     re-derivation, same as every other *Cache table.
--   * updated_at_ms is the kind-0 event's own timestamp (profile edit time);
--     fetched_at_ms is when WE last confirmed it against 4a. Staleness
--     checks use fetched_at_ms; "which profile is newer" uses updated_at_ms.

CREATE TABLE profileCache (
  pubkey TEXT PRIMARY KEY,
  name TEXT,
  display_name TEXT,
  picture TEXT,
  about TEXT,
  event_id TEXT,
  updated_at_ms INTEGER NOT NULL,
  fetched_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_profileCache_updated ON profileCache(updated_at_ms DESC);
