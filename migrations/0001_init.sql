-- Evenflow D1 schema — migration 0001
--
-- D1 is a CACHE + CONFIG surface, not the source of truth. Canonical state
-- for boards/issues/comments/status changes lives in signed 4a events
-- (kinds 30550-30559); the *Cache tables below are refreshable projections
-- of those events for fast reads. Only webhookRoutes, webhookDeliveries,
-- and sessionCache hold state that exists nowhere else.
--
-- Conventions:
--   * All timestamps are epoch milliseconds (INTEGER, *_ms suffix).
--   * JSON-valued columns are TEXT holding a JSON document; D1/SQLite has
--     no native JSON column type. Query with the json_*() functions.
--   * Booleans are INTEGER 0/1.
--   * Cache tables carry no FOREIGN KEY constraints on purpose: 4a events
--     can arrive out of order (an issue before its board), and cache
--     refresh must never be blocked by parent-row ordering. Referential
--     integrity is the substrate's job, not the cache's. (D1 also cannot
--     rebuild a populated FK-referenced parent table, which would make
--     future migrations of boardCache painful.)

-- ── boardCache ── cached view of kind:30550 fa:KanbanBoard events ─────────
-- (and their 30555 encrypted variants; is_encrypted distinguishes them)
CREATE TABLE IF NOT EXISTS boardCache (
  id            TEXT PRIMARY KEY,          -- 4a event id (hex64)
  pubkey        TEXT NOT NULL,             -- board owner pubkey (hex64)
  slug          TEXT NOT NULL,             -- board d-tag / URL slug
  title         TEXT NOT NULL,
  description   TEXT,                      -- JSON
  columns       TEXT NOT NULL DEFAULT '[]',-- JSON array of column defs
  labels        TEXT NOT NULL DEFAULT '[]',-- JSON array of label defs
  member_policy TEXT,                      -- e.g. 'open' | 'invite'
  is_encrypted  INTEGER NOT NULL DEFAULT 0,-- 1 = private board (kind 30555)
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_boardCache_pubkey_slug
  ON boardCache (pubkey, slug);
CREATE INDEX IF NOT EXISTS idx_boardCache_updated
  ON boardCache (updated_at_ms DESC);

-- ── issueCache ── cached view of kind:30551 fa:KanbanIssue events ─────────
CREATE TABLE IF NOT EXISTS issueCache (
  id              TEXT PRIMARY KEY,        -- 4a event id (hex64)
  board_id        TEXT NOT NULL,           -- boardCache.id (soft FK)
  title           TEXT NOT NULL,
  body            TEXT,
  status          TEXT NOT NULL,           -- board-defined column, e.g. 'Todo'
  container       TEXT NOT NULL DEFAULT 'backlog'
                    CHECK (container IN ('icebox', 'backlog', 'active')),
  assignee_pubkey TEXT,                    -- NULL = unassigned
  priority        INTEGER,                 -- NULL = none
  estimate        INTEGER,                 -- story points; NULL = unestimated
  labels          TEXT NOT NULL DEFAULT '[]', -- JSON array of label ids
  github_links    TEXT NOT NULL DEFAULT '[]', -- JSON array of {repo, pr, state}
  created_at_ms   INTEGER NOT NULL,
  updated_at_ms   INTEGER NOT NULL,
  completed_at_ms INTEGER                  -- NULL until issue reaches Done
);

CREATE INDEX IF NOT EXISTS idx_issueCache_board_status
  ON issueCache (board_id, status);
CREATE INDEX IF NOT EXISTS idx_issueCache_board_container
  ON issueCache (board_id, container);
CREATE INDEX IF NOT EXISTS idx_issueCache_board_updated
  ON issueCache (board_id, updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_issueCache_assignee
  ON issueCache (assignee_pubkey);

-- ── commentCache ── cached view of kind:30552 fa:KanbanComment events ─────
CREATE TABLE IF NOT EXISTS commentCache (
  id            TEXT PRIMARY KEY,          -- 4a event id (hex64)
  issue_id      TEXT NOT NULL,             -- issueCache.id (soft FK)
  author_pubkey TEXT NOT NULL,
  body          TEXT NOT NULL,
  in_reply_to   TEXT,                      -- commentCache.id; NULL = top-level
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commentCache_issue_created
  ON commentCache (issue_id, created_at_ms DESC);

-- ── statusChangeCache ── cached view of kind:30553 fa:KanbanStatusChange ──
-- Activity-feed source. board_id is denormalized from the issue so the
-- per-board feed reads without a join.
CREATE TABLE IF NOT EXISTS statusChangeCache (
  id                      TEXT PRIMARY KEY, -- 4a event id (hex64)
  issue_id                TEXT NOT NULL,    -- issueCache.id (soft FK)
  board_id                TEXT NOT NULL,    -- boardCache.id (soft FK)
  actor_pubkey            TEXT NOT NULL,
  from_status             TEXT,
  to_status               TEXT,
  from_container          TEXT,
  to_container            TEXT,
  container_at_completion TEXT,             -- set when to_status is Done;
                                            -- velocity counts 'active' only
  occurred_at_ms          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_statusChangeCache_issue_occurred
  ON statusChangeCache (issue_id, occurred_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_statusChangeCache_board_occurred
  ON statusChangeCache (board_id, occurred_at_ms DESC);

-- ── webhookRoutes ── per-board outbound webhook config ────────────────────
-- NOT a cached event: this is the board owner's local config and D1 is its
-- source of truth. Secrets are never stored here — secret_env_var names the
-- Worker env var / secret binding holding the HMAC signing secret.
CREATE TABLE IF NOT EXISTS webhookRoutes (
  id             TEXT PRIMARY KEY,         -- uuid
  board_id       TEXT NOT NULL,            -- boardCache.id (soft FK)
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  secret_env_var TEXT,                     -- env var name, not the secret
  on_events      TEXT NOT NULL DEFAULT '[]', -- JSON array of event types,
                                            -- e.g. ["issue-created","status-changed"]
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhookRoutes_board
  ON webhookRoutes (board_id);

-- ── webhookDeliveries ── outbound webhook delivery audit trail ────────────
CREATE TABLE IF NOT EXISTS webhookDeliveries (
  id                    TEXT PRIMARY KEY,  -- uuid
  route_id              TEXT NOT NULL,     -- webhookRoutes.id (soft FK)
  issue_event_id        TEXT,              -- triggering 4a event id; NULL for
                                           -- non-issue events (e.g. test ping)
  sent_at_ms            INTEGER NOT NULL,
  response_status       INTEGER,           -- NULL = network error, no response
  response_body_snippet TEXT,              -- first 512 chars, caller-truncated
  retry_count           INTEGER NOT NULL DEFAULT 0,
  next_retry_at_ms      INTEGER            -- NULL = no retry scheduled
);

CREATE INDEX IF NOT EXISTS idx_webhookDeliveries_route_sent
  ON webhookDeliveries (route_id, sent_at_ms DESC);
-- Retry sweeper scans only pending retries; partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_webhookDeliveries_next_retry
  ON webhookDeliveries (next_retry_at_ms)
  WHERE next_retry_at_ms IS NOT NULL;

-- ── sessionCache ── short-lived OAuth JWT/session token cache ─────────────
-- Stores a hash of the JWT, never the token itself.
CREATE TABLE IF NOT EXISTS sessionCache (
  jwt_hash      TEXT PRIMARY KEY,          -- sha256 hex of the JWT
  pubkey        TEXT NOT NULL,             -- derived Nostr pubkey (hex64)
  provider      TEXT NOT NULL,             -- 'google' | 'github'
  oauth_id      TEXT NOT NULL,             -- provider-side stable user id
  expires_at_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL
);

-- Expiry sweep: DELETE FROM sessionCache WHERE expires_at_ms < ?
CREATE INDEX IF NOT EXISTS idx_sessionCache_expires
  ON sessionCache (expires_at_ms);
