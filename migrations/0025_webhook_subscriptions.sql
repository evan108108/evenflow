-- Evenflow D1 schema — migration 0025: outbound webhook subscriptions (EFB-13).
--
-- The outbound half of the webhook story. Inbound already shipped in Sonata as
-- `4a-webhook-relay`; this is its mirror, entirely inside evenflow. A board
-- owner registers a URL plus a set of BoardEventKinds, and matching events are
-- POSTed to that URL HMAC-SHA256-signed. Substrate for Sona-notifies-me, a
-- Slack/Discord bridge, and GitHub-style notification without polling.
--
-- ── WHY THIS MIGRATION DROPS TWO TABLES ──────────────────────────────────
--
-- `webhookRoutes` and `webhookDeliveries` were created in 0001_init.sql and
-- never wired to anything. 0016's header records what they were for: "the
-- pre-existing webhookRoutes / webhookDeliveries tables (0001) are OUTBOUND —
-- evenflow calling someone else's URL." So the feature this ticket ships had a
-- schema home from day one; nothing ever filled it.
--
-- They are dropped rather than adopted or left standing:
--   * Dead, provably. Zero references in src/, web/src/ or tests/, and prod
--     row counts verified 0 / 0 on 2026-07-31 before this was written.
--   * Wrong shape for the delivery pattern below — `route_id`, `sent_at_ms`,
--     `retry_count`, and no `terminal`, `event_json`, or `board_id`.
--   * Wrong secret posture. `webhookRoutes.secret_env_var` NAMES a Worker env
--     var, which predates 0016's decision to seal secrets at rest with AES-GCM
--     under EVENFLOW_WEBHOOK_SECRET. Adopting it would resurrect a posture the
--     schema already moved away from.
-- Leaving them in place would ship two outbound webhook families in one
-- schema — exactly the confusion 0016's naming note ("the two families must
-- never be joined; the distinct prefix is the guard") exists to prevent.
--
-- `webhookSubscriptions`, not `webhookRoutes`: "route" is overloaded in a repo
-- full of HTTP routers, and this is a clean re-establishment rather than a v2
-- of anything — hence no version suffix on the names.
--
-- ── NOTE ON `CREATE TABLE` WITHOUT `IF NOT EXISTS` ───────────────────────
--
-- Deliberate, and the reason is this migration's own history. The first draft
-- used `CREATE TABLE IF NOT EXISTS webhookDeliveries`, which silently no-op'd
-- against the 0001 table of the same name; the failure only surfaced one
-- statement later when `CREATE INDEX … (subscription_id)` hit a column that
-- did not exist. `IF NOT EXISTS` in a migration that ESTABLISHES a new feature
-- is a silent-success construct — it turns "the shape I asked for was not
-- achieved" into "no error" — which is the DDL rendering of the bug class
-- docs/BOUNDARY_DISCIPLINE.md exists to close. A bare CREATE TABLE fails loud
-- on collision, which is the only useful outcome. (The DROPs above keep their
-- IF EXISTS: there, "already absent" is a legitimately fine state.)
--
-- ── WHY `event_json` EXISTS — the load-bearing column ────────────────────
--
-- The natural design POSTs from the emit path. That is not reachable here.
-- `emitSecureBoardEvent` (src/audiences.ts) has no `ExecutionContext`, so there
-- is no `ctx.waitUntil` to hand work to, and EFB-24 already proved that
-- `Effect.forkDaemon` at that site delivers NOTHING in production — Cloudflare
-- cancels outstanding work the moment the response returns, so the fiber is
-- never scheduled (postmortem at src/audiences.ts:635-656).
--
-- So the emit path performs no network I/O. It writes a delivery ROW and
-- returns; a once-a-minute cron sweep performs every POST. The sweep is not a
-- retry backstop behind a fast path — it IS the delivery path, the only one.
-- That has a direct schema consequence: the event being delivered no longer
-- exists in memory when the POST happens, so it must be persisted at enqueue
-- time. Hence `event_json`. A delivery row is self-contained, which is also
-- what makes retry honest — attempt 4 sends exactly the bytes attempt 1 did,
-- not a re-derivation from a board that has since moved on.
--
-- `created_at_ms` and `attempted_at_ms` are separate for the same reason. They
-- coincide only while the sweep is healthy, and the gap between them IS the
-- liveness signal: a row with `attempted_at_ms IS NULL` and an old
-- `created_at_ms` means the cron did not run, which — now that nothing else
-- delivers — is a total outage of the feature rather than a slow retry.
-- Collapsing them into one column would make that state unobservable.
--
-- ── PRIVATE BOARDS ARE NOT SUBSCRIBABLE IN V1 ────────────────────────────
--
-- The reason is narrower than "encryption is hard". On a private board only
-- `payload` is encrypted; the BoardEvent envelope — kind, board_id, issue_id,
-- sprint_id, at_ms — travels in cleartext by design, because it is what an
-- un-granted SSE client needs to read (see the field comments in
-- src/durable-objects/board-events.ts). "Encrypted passthrough" would
-- therefore hand anyone who can register a URL a real-time metadata feed of a
-- private board: which issues exist, when they move, how often, what the
-- sprint cadence is — without decrypting a single payload. The route rejects
-- private boards with 400 `outbound-webhooks-private-boards-unsupported-v1`.
-- Lifting the limit needs a per-subscription member gate — a follow-up ticket,
-- not a column here.
--
-- SOFT FKs, no REFERENCES clauses — consistent with every other cross-cache
-- link in this schema (issueCache.board_id, attachmentCache.issue_id,
-- sprintMembership.issue_id, documented as soft since 0001/0010). Deleting a
-- subscription leaves its delivery rows standing on purpose: the delivery log
-- is an audit trail, and one that vanishes with the thing it audits is not an
-- audit trail. The sweep joins, so a dangling subscription_id costs a row of
-- history, never a phantom POST.

DROP TABLE IF EXISTS webhookDeliveries;
DROP TABLE IF EXISTS webhookRoutes;

CREATE TABLE webhookSubscriptions (
  id                     TEXT    PRIMARY KEY,
  board_id               TEXT    NOT NULL,
  name                   TEXT    NOT NULL,
  url                    TEXT    NOT NULL,
  -- JSON array of BoardEventKind strings — a subset of the 16 kinds frozen in
  -- src/durable-objects/board-events.ts. Validated by the route schema against
  -- that union, not by a CHECK: SQLite cannot express "every element of this
  -- JSON array is in this set", and a CHECK enforcing half the rule would
  -- invite the reader to trust it for all of it.
  event_kinds            TEXT    NOT NULL,
  -- Optional single-field predicate, e.g. {"assignee":"nostr:049b…"}. NULL
  -- means "every event of a subscribed kind". Registering an `assignee`
  -- predicate for somebody else is an activity leak, so the handler requires
  -- caller == subject OR board admin (EFB-13 surprise #9). That needs the board
  -- roster, so it lives in the route as a named authorization step rather than
  -- in the schema — per the DB-free rule in docs/BOUNDARY_DISCIPLINE.md.
  predicate              TEXT,
  -- 'hmac' (default) or 'bearer'. Deliberately closed: a Stripe-style variant
  -- is a follow-up with its own signing code, not a string someone can pass.
  auth_scheme            TEXT    NOT NULL DEFAULT 'hmac',
  -- Sealed with the EVENFLOW_WEBHOOK_SECRET worker secret via AES-GCM, the
  -- pattern 0016 established. Reversible ON PURPOSE: HMAC signing needs the
  -- plaintext back, so this cannot be a one-way hash the way 0008's API-key
  -- column is.
  hmac_secret_ciphertext TEXT    NOT NULL,
  enabled                INTEGER NOT NULL DEFAULT 1,
  created_at_ms          INTEGER NOT NULL,
  updated_at_ms          INTEGER NOT NULL
);

CREATE INDEX idx_webhookSubscriptions_board
  ON webhookSubscriptions (board_id);

-- The emit path's hot query: "which enabled subscriptions does this board
-- have?", run once per emitted event. Partial on enabled = 1 because that is
-- the only variant the emit path asks for.
CREATE INDEX idx_webhookSubscriptions_board_enabled
  ON webhookSubscriptions (board_id, enabled)
  WHERE enabled = 1;

CREATE TABLE webhookSubscriptionDeliveries (
  id                    TEXT    PRIMARY KEY,
  subscription_id       TEXT    NOT NULL,
  board_id              TEXT    NOT NULL,
  event_kind            TEXT    NOT NULL,
  -- The serialized BoardEvent this delivery POSTs. See the header: the sweep is
  -- the sole delivery path, so the event is long gone from memory by the time
  -- it is sent. Persisting it is what makes the row replayable and byte-stable
  -- across attempts.
  event_json            TEXT    NOT NULL,
  -- Enqueue time. Distinct from attempted_at_ms on purpose — see header.
  created_at_ms         INTEGER NOT NULL,
  -- NULL until the sweep first touches this row. NULL alongside an old
  -- created_at_ms is the "cron is not running" alarm.
  attempted_at_ms       INTEGER,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  -- NULL when the attempt failed before any response existed (DNS, TCP,
  -- timeout). That is a different fact from "the server answered 500"; the
  -- retry policy treats them alike, but the audit UI must not imply we saw a
  -- status we never got.
  status_code           INTEGER,
  -- Truncated at the dispatch layer, name carried over from 0001's precedent.
  -- A subscriber answering an error with a megabyte of HTML should cost us a
  -- preview, not a row.
  response_body_snippet TEXT,
  -- When the sweep should next pick this row up. NOT NULL: a row is enqueued
  -- with this set to its created_at_ms so the very next tick claims it. There
  -- is no "pending but unscheduled" state to represent, because there is no
  -- fast path that might have taken the row first.
  next_retry_at_ms      INTEGER NOT NULL,
  -- 1 = no further attempts. Reached by success, by a 4xx (the subscriber's
  -- config is wrong; retrying cannot fix it), or by exhausting the 5-attempt
  -- backoff ladder.
  terminal              INTEGER NOT NULL DEFAULT 0
);

-- The delivery-log UI: one subscription's attempts, newest first.
CREATE INDEX idx_wsd_sub_attempted
  ON webhookSubscriptionDeliveries (subscription_id, attempted_at_ms DESC);

-- The sweep: `WHERE terminal = 0 AND next_retry_at_ms <= ? ORDER BY
-- next_retry_at_ms ASC LIMIT 50`. Partial on terminal = 0 because finished rows
-- dominate this table in steady state and the sweep never reads them — the
-- same reasoning as 0024's partial index on duplicates. The ASC ordering is not
-- incidental: under a backlog the stalest delivery must be served first, or a
-- busy board can starve an older pending row indefinitely.
CREATE INDEX idx_wsd_pending
  ON webhookSubscriptionDeliveries (next_retry_at_ms ASC)
  WHERE terminal = 0;

-- Liveness. Counts rows the sweep has never attempted, so a cron misfire is a
-- loud number somebody can alert on rather than a queue quietly filling up.
CREATE INDEX idx_wsd_stuck
  ON webhookSubscriptionDeliveries (created_at_ms)
  WHERE attempted_at_ms IS NULL;
