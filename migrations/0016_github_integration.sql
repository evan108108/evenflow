-- Evenflow D1 schema — migration 0016: GitHub integration (inbound).
--
-- NAMING: the pre-existing webhookRoutes / webhookDeliveries tables (0001)
-- are OUTBOUND — evenflow calling someone else's URL. Everything here is
-- INBOUND — GitHub calling us — so it carries a githubWebhook* prefix. The
-- two families must never be joined; the distinct prefix is the guard.
--
-- Two independent axes land on an issue:
--   1) external_state — a pill on the card, SEPARATE from column position.
--      A ticket can read "PR in review" without moving between columns.
--   2) the rules engine (githubWebhookRules) — optional automation on top,
--      board-scoped, first-match-per-event.
--
-- Secret posture: GitHub HMAC verification needs the shared secret in
-- plaintext at delivery time, so it cannot live in a write-only KDF the way
-- an API key hash does (0008). Instead the SERVER mints it, shows it once,
-- and stores it encrypted at rest under EVENFLOW_WEBHOOK_SECRET — a third
-- distinct Worker secret (BLOSSOM = schnorr signing, STORAGE = ECDH,
-- WEBHOOK = symmetric AES-GCM). No key reuse across primitives, same rule
-- 18b set. D1 never sees the plaintext.

-- ── boardCache: repo binding + pill vocabulary ────────────────────────────
-- github_repo is "owner/name". NULL = GitHub not connected for this board.
ALTER TABLE boardCache ADD COLUMN github_repo TEXT;
-- AES-GCM ciphertext of the per-board webhook secret (iv:ct, base64url).
-- Named _ciphertext, never _ref: there is no reachable external secret
-- store from a Cloudflare Worker.
ALTER TABLE boardCache ADD COLUMN github_webhook_secret_ciphertext TEXT;
-- JSON string[] of allowed external_state values. NULL = ship the defaults
-- (see src/github/external-state.ts). Boards may narrow or extend later
-- for Linear/Jira without a migration.
ALTER TABLE boardCache ADD COLUMN external_state_config TEXT;
-- Which preset the board is on: defaults | status_only | custom | off.
-- Drives the rule editor's picker and what reconnect re-seeds.
ALTER TABLE boardCache ADD COLUMN github_rule_preset TEXT NOT NULL DEFAULT 'defaults';

-- ── issueCache: the pill ──────────────────────────────────────────────────
-- NULL = no external state. Constrained by external_state_config at write
-- time, not by a CHECK — the vocabulary is per-board config, and D1 cannot
-- rebuild a populated table to widen a CHECK later (see 0001 header).
ALTER TABLE issueCache ADD COLUMN external_state TEXT;
ALTER TABLE issueCache ADD COLUMN external_state_updated_at_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_issueCache_board_external_state
  ON issueCache (board_id, external_state)
  WHERE external_state IS NOT NULL;

-- ── githubWebhookRules ── per-board automation, D1 is source of truth ─────
-- when_json:  {event, action?, ...sub-filters}  — see src/github/rules.ts
-- do_json:    {type, ...args}                   — one action per rule
-- priority:   ascending; first ENABLED match wins per delivery.
-- bucket:     'match'     = fires against every matched ticket
--             'no_match'  = fires when a delivery matched zero tickets
CREATE TABLE IF NOT EXISTS githubWebhookRules (
  id            TEXT PRIMARY KEY,          -- uuid
  board_id      TEXT NOT NULL,             -- boardCache.id (soft FK)
  bucket        TEXT NOT NULL DEFAULT 'match'
                  CHECK (bucket IN ('match', 'no_match')),
  priority      INTEGER NOT NULL,
  when_json     TEXT NOT NULL,
  do_json       TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_githubWebhookRules_board_priority
  ON githubWebhookRules (board_id, bucket, priority);

-- ── githubWebhookAudit ── the debuggability story ─────────────────────────
-- One row per delivery, written even when nothing matched and even when
-- processing failed: a silent no-op is the failure mode this table exists
-- to make visible. error IS NULL on success.
CREATE TABLE IF NOT EXISTS githubWebhookAudit (
  id                    TEXT PRIMARY KEY,  -- uuid
  board_id              TEXT NOT NULL,     -- boardCache.id (soft FK)
  delivery_id           TEXT,              -- X-GitHub-Delivery; NULL if absent
  event_type            TEXT NOT NULL,     -- X-GitHub-Event, e.g. pull_request
  action                TEXT,              -- payload.action, e.g. opened
  matched_issue_ids_json TEXT NOT NULL DEFAULT '[]',
  matched_rule_ids_json TEXT NOT NULL DEFAULT '[]',
  actions_taken_json    TEXT NOT NULL DEFAULT '[]',
  error                 TEXT,              -- NULL = clean run
  received_at_ms        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_githubWebhookAudit_board_received
  ON githubWebhookAudit (board_id, received_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_githubWebhookAudit_board_event
  ON githubWebhookAudit (board_id, event_type, received_at_ms DESC);

-- ── githubWebhookDedup ── X-GitHub-Delivery replay guard ──────────────────
-- GitHub redelivers on timeout, and a redelivered "PR merged" must not
-- re-fire a transition the user has since undone by hand. Composite PK does
-- the work; the insert is the claim.
CREATE TABLE IF NOT EXISTS githubWebhookDedup (
  board_id       TEXT NOT NULL,
  delivery_id    TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (board_id, delivery_id)
);

-- Retention sweep is opportunistic-on-write (no cron trigger exists in
-- wrangler.toml); this index keeps the 30-day delete cheap.
CREATE INDEX IF NOT EXISTS idx_githubWebhookDedup_received
  ON githubWebhookDedup (received_at_ms);
