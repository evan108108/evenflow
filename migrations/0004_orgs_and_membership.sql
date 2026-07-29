-- Evenflow D1 schema — migration 0004: orgs, membership, invites.
--
-- Phase 16 restructures the namespace to GitHub-shaped /@{handle}/{board}.
-- Every board now belongs to an org; every user gets an auto-created
-- `personal` org on session bootstrap (slug = login-prefix, digit-suffixed
-- on collision). Same cache posture as 0001: orgCache / *MemberCache are
-- refreshable projections of substrate events (kind 30520 org declarations,
-- kind 30521 key-grants); substrate_event_id is NULL when the publish was
-- deferred (4a down at write time — a retry sweep republishes later).
-- inviteCache and orgSlugAlias are config/state with D1 as source of truth.
--
-- Backfill (existing boards → personal orgs) needs string logic SQL doesn't
-- have; scripts/backfill-orgs.mjs runs immediately after
-- `wrangler d1 migrations apply`, same pattern as 0003's short-id backfill.

-- ── orgCache ── cached view of kind:30520 org declarations ────────────────
CREATE TABLE orgCache (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('personal','team')),
  created_by TEXT NOT NULL,
  substrate_event_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER
);
CREATE INDEX idx_orgCache_created_by ON orgCache(created_by);

-- ── orgMemberCache ── cached view of kind:30521 org-scope key-grants ──────
CREATE TABLE orgMemberCache (
  org_id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
  added_by TEXT NOT NULL,
  added_at_ms INTEGER NOT NULL,
  substrate_event_id TEXT,
  PRIMARY KEY(org_id, pubkey)
);
CREATE INDEX idx_orgMemberCache_pubkey ON orgMemberCache(pubkey);

-- ── boardMemberCache ── cached view of kind:30521 board-scope key-grants ──
CREATE TABLE boardMemberCache (
  board_id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','contributor','viewer')),
  added_by TEXT NOT NULL,
  added_at_ms INTEGER NOT NULL,
  substrate_event_id TEXT,
  PRIMARY KEY(board_id, pubkey)
);
CREATE INDEX idx_boardMemberCache_pubkey ON boardMemberCache(pubkey);

-- ── boardCache gains org scope + visibility ───────────────────────────────
-- org_id is nullable only for the pre-backfill window (same posture as
-- 0003's short_id); the create path always sets it.
ALTER TABLE boardCache ADD COLUMN org_id TEXT;
ALTER TABLE boardCache ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public'));
CREATE INDEX idx_boardCache_org_id ON boardCache(org_id);

-- ── inviteCache ── invite links + email invites; D1 is source of truth ────
CREATE TABLE inviteCache (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  org_id TEXT NOT NULL,
  board_id TEXT,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  invited_email TEXT,
  bind_to_email INTEGER NOT NULL DEFAULT 0,
  expires_at_ms INTEGER NOT NULL,
  single_use INTEGER NOT NULL DEFAULT 1,
  used_by TEXT,
  used_at_ms INTEGER,
  revoked_at_ms INTEGER,
  declined_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_inviteCache_org_board ON inviteCache(org_id, board_id);
CREATE INDEX idx_inviteCache_invited_email ON inviteCache(invited_email);

-- ── orgSlugAlias ── 302-forever redirects after org slug renames ──────────
CREATE TABLE orgSlugAlias (
  old_slug TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_orgSlugAlias_org ON orgSlugAlias(org_id);
