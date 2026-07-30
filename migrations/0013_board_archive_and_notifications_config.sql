-- Evenflow D1 schema — migration 0013: polish batch.
--
-- 1) Board archive: archived_at_ms on boardCache. NULL = live (every
--    pre-existing row). Archived boards are hidden from list surfaces
--    unless ?include_archived=1; the board detail routes keep working so
--    deep links never break. Reversible via .../unarchive.
--
-- 2) notificationsConfig: per-user notification preferences keyed by
--    pubkey. CONFIG SURFACE ONLY in this phase — delivery wiring (actual
--    email sends) is a later phase; rows persist preferences ahead of it.
--    Reads treat a missing row as the column defaults.

ALTER TABLE boardCache ADD COLUMN archived_at_ms INTEGER;

CREATE TABLE IF NOT EXISTS notificationsConfig (
  pubkey TEXT PRIMARY KEY,
  email_on_mention INTEGER NOT NULL DEFAULT 1,
  email_on_assignment INTEGER NOT NULL DEFAULT 1,
  email_on_issue_moved_to_me INTEGER NOT NULL DEFAULT 0,
  email_digest TEXT NOT NULL DEFAULT 'off' CHECK (email_digest IN ('off','daily','weekly')),
  updated_at_ms INTEGER NOT NULL
);
