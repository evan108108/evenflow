-- Evenflow D1 schema — migration 0028: per-subscription member gate (EFB-62).
--
-- 0025 shipped outbound webhooks with private boards refused outright. This
-- migration is the column that lets that refusal become a gate instead: the
-- identity a delivery is checked against.
--
-- ── WHY A COLUMN WAS UNAVOIDABLE ─────────────────────────────────────────
--
-- "Only deliver if the subscriber is still a board member" has no subject in
-- the 0025 schema. `webhookSubscriptions` records what to send and where, and
-- nothing at all about WHO asked for it — the route authorized the creating
-- caller and then dropped them on the floor. So there was no pubkey to check a
-- roster against, at any of the three candidate gate points. Every design for
-- this ticket needs this column; only its lifecycle was ever in question.
--
-- ── WHY NULLABLE ─────────────────────────────────────────────────────────
--
-- Rows created before this migration have no creator to record — the identity
-- was never captured, and inventing one (the board owner, say) would be a
-- fabricated authorization record in a security-gate column, which is worse
-- than an honest absence. NULL means "unknown subscriber", and the dispatch
-- path reads it as FAIL CLOSED on a private board: no known member, no
-- delivery. On a public board the column is not consulted at all, so existing
-- public subscriptions — the only kind 0025 permitted — keep working untouched.
--
-- That asymmetry is the whole point. A NULL is harmless where the board's
-- contents are public anyway and disqualifying where they are not, which is
-- exactly the posture a backfill could not have given us.
--
-- ── WHY NOT A SEPARATE AUDIT TABLE ───────────────────────────────────────
--
-- A dropped delivery needs a record, and `webhookSubscriptionDeliveries` is
-- already that record — 0025 built it as an audit trail explicitly ("the
-- delivery log is an audit trail, and one that vanishes with the thing it
-- audits is not an audit trail"). A membership drop at sweep time is a row
-- going terminal with its reason in `response_body_snippet`, the same shape
-- `webhook-secret-unavailable` already uses. A second table would split one
-- delivery's history across two places for no gain.
--
-- Enqueue-time drops deliberately write NO row. A revoked subscriber on a busy
-- board would otherwise mint one audit row per event forever, unbounded, all
-- saying the same thing. The state worth auditing is the transition — a
-- delivery that was queued while the subscriber was a member and refused when
-- it came due — and that one does get a row, because the row already exists.

ALTER TABLE webhookSubscriptions ADD COLUMN creator_pubkey TEXT;

-- The sweep re-checks membership per due delivery, joining subscription to
-- roster by this column. Indexed because the gate reads it on every delivery
-- of every private board, which is the one hot path this column has.
CREATE INDEX idx_webhookSubscriptions_creator
  ON webhookSubscriptions (creator_pubkey)
  WHERE creator_pubkey IS NOT NULL;
