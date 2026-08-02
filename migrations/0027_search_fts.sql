-- Evenflow D1 schema — migration 0027: full-text search (EFB-14).
--
-- FTS5 indexes over the two things people actually search for: issue
-- title/body, and comment body. Board-scoped queries, BM25 ranking, nothing
-- else. Filters (type/status/assignee/sprint) and cross-board search are
-- deliberately NOT here — see docs/plans/efb-14-search-mvp-context.md.
--
-- ── WHAT IS AND IS NOT SECRET HERE ──────────────────────────────────────
--
-- The ticket asked whether private-board bodies could be indexed at all, on
-- the theory that they might be encrypted at rest. They are not, and the
-- distinction is worth writing down because it is easy to get backwards.
--
-- `issueCache.body` and `commentCache.body` are PLAINTEXT columns in this
-- database, on every board, regardless of visibility. Nothing writes
-- ciphertext into them: src/routes/issues.ts binds the body straight from the
-- request. What kind:30556 encrypts (src/audiences.ts secureBoardEvent) is the
-- OUTBOUND substrate mirror — the gift-wrapped copy published to 4a for a
-- board whose `encryption_active` is set. That is transport/publication
-- confidentiality, not at-rest confidentiality, and it never writes back to
-- these tables. Migration 0015 says the same thing from the other side:
-- `boardCache.visibility` is "app-level ACL only".
--
-- So these FTS tables are a derived copy of plaintext that is ALREADY in this
-- database, reachable by the same Worker binding, one `SELECT body FROM
-- issueCache` away. Indexing a private board's text therefore widens no
-- exposure that the source table did not already have. Excluding private
-- boards from the index would buy exactly zero confidentiality and would make
-- search silently useless on the boards people use most.
--
-- The control that DOES matter is at query time, and it lives in the route:
-- POST /boards/:slug/search runs resolveBoardScope(..., "viewer") BEFORE it
-- touches these tables, so a caller who cannot see the board gets 404 without
-- a single FTS row being read. If anyone later adds a search path that reaches
-- these tables without that gate, this comment is the thing they broke.
--
-- ── WHY STANDALONE FTS5 TABLES, NOT `content=` EXTERNAL-CONTENT ─────────
--
-- FTS5's external-content mode (content='issueCache') stores no text of its
-- own, which is the storage-efficient choice and the one most examples show.
-- It is not the choice here, for two reasons:
--
--   1. Correctness posture. External-content deletes are performed by feeding
--      the OLD column values back in ('delete' command). If a trigger's OLD
--      values ever disagree with what was indexed — a column added later, a
--      trigger that fires on the wrong UPDATE OF list — the index does not
--      error. It silently drifts, and the only symptom is search quietly
--      missing or duplicating rows. A standalone table's delete is
--      `DELETE FROM ... WHERE id = old.id`: it either removed the row or it
--      did not.
--
--   2. Board scoping. `board_id` is carried here as an UNINDEXED column, so
--      the board filter applies inside the FTS query with no join back to
--      issueCache. For comments that matters more than convenience:
--      commentCache has no board_id at all (only issue_id), so scoping
--      comment search without denormalization means a join per query.
--
-- The cost is a second copy of title/body text, and DELETE/UPDATE doing a
-- scan over the unindexed `id` column. At kanban scale — thousands of issues
-- per board, and title/body edits being a human-speed operation — that is
-- nothing. If this table ever gets big enough for the scan to show up, the
-- migration to external-content is mechanical and the query shape above is
-- what it should be measured against first.
--
-- ── TOKENIZER ───────────────────────────────────────────────────────────
--
-- `unicode61`, FTS5's default, with diacritics folded. Explicitly NOT porter
-- stemming and explicitly no prefix (`term*`) expansion in the query builder:
-- the MVP brief scopes fuzzy matching out, and both of those change recall in
-- ways worth deciding on deliberately rather than inheriting from a migration.
-- Both are one-line follow-ups if search feels too literal in practice.

-- ── issueCacheFts ── title + body, board-scoped ──────────────────────────
CREATE VIRTUAL TABLE issueCacheFts USING fts5(
  id UNINDEXED,        -- issueCache.id; the delete/update key
  board_id UNINDEXED,  -- denormalized from issueCache for board scoping
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ── commentCacheFts ── body only, board-scoped via denormalized board_id ─
--
-- `board_id` is resolved through the parent issue at trigger time. A comment
-- whose issue is somehow absent indexes with board_id NULL, which matches no
-- board filter and is therefore invisible to search — fail-closed, which is
-- the right direction for a row we cannot authorize.
CREATE VIRTUAL TABLE commentCacheFts USING fts5(
  id UNINDEXED,        -- commentCache.id; the delete/update key
  issue_id UNINDEXED,  -- for hydrating results back to their issue
  board_id UNINDEXED,  -- denormalized via issueCache for board scoping
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ── issueCache triggers ──────────────────────────────────────────────────
--
-- UPDATE fires on `OF title, body, board_id` rather than on every UPDATE.
-- issueCache is written on every drag between columns, every position
-- rebalance, every status change; reindexing text that did not change on each
-- of those would be pure write amplification. The three named columns are
-- exactly the ones this index stores.

CREATE TRIGGER issueCacheFts_ai AFTER INSERT ON issueCache BEGIN
  INSERT INTO issueCacheFts (id, board_id, title, body)
  VALUES (new.id, new.board_id, new.title, coalesce(new.body, ''));
END;

CREATE TRIGGER issueCacheFts_ad AFTER DELETE ON issueCache BEGIN
  DELETE FROM issueCacheFts WHERE id = old.id;
END;

-- Delete-then-insert rather than UPDATE: FTS5 tables accept UPDATE, but
-- delete+insert is the shape that stays correct if a column is added to this
-- index later and someone forgets to extend a SET list.
--
-- The commentCacheFts leg exists because issues MOVE between boards
-- (src/routes/issues.ts, POST /issues/:ref/move updates issueCache.board_id).
-- Without it, a moved issue's comments would keep answering searches scoped to
-- the board they came FROM — a cross-board leak on a private destination, and
-- silent, because nothing else in the system reads commentCacheFts.board_id.
CREATE TRIGGER issueCacheFts_au AFTER UPDATE OF title, body, board_id ON issueCache BEGIN
  DELETE FROM issueCacheFts WHERE id = old.id;
  INSERT INTO issueCacheFts (id, board_id, title, body)
  VALUES (new.id, new.board_id, new.title, coalesce(new.body, ''));
  UPDATE commentCacheFts SET board_id = new.board_id WHERE issue_id = new.id;
END;

-- ── commentCache triggers ────────────────────────────────────────────────

CREATE TRIGGER commentCacheFts_ai AFTER INSERT ON commentCache BEGIN
  INSERT INTO commentCacheFts (id, issue_id, board_id, body)
  VALUES (
    new.id,
    new.issue_id,
    (SELECT board_id FROM issueCache WHERE id = new.issue_id),
    new.body
  );
END;

CREATE TRIGGER commentCacheFts_ad AFTER DELETE ON commentCache BEGIN
  DELETE FROM commentCacheFts WHERE id = old.id;
END;

CREATE TRIGGER commentCacheFts_au AFTER UPDATE OF body ON commentCache BEGIN
  DELETE FROM commentCacheFts WHERE id = old.id;
  INSERT INTO commentCacheFts (id, issue_id, board_id, body)
  VALUES (
    new.id,
    new.issue_id,
    (SELECT board_id FROM issueCache WHERE id = new.issue_id),
    new.body
  );
END;

-- ── backfill ─────────────────────────────────────────────────────────────
--
-- Idempotent and safe to re-run: each side clears its index first, so running
-- this twice yields the same rows rather than doubling every document. The
-- DELETEs are unconditional (not `WHERE id IN (...)`) because the whole point
-- is to converge the index on the source tables, including dropping any index
-- row whose source row is already gone.
--
-- These run inside the migration so a freshly-migrated database is searchable
-- immediately, with no separate backfill step to forget. Verification is a
-- row-count comparison against the source tables — see the ticket's deploy
-- notes.

DELETE FROM issueCacheFts;
INSERT INTO issueCacheFts (id, board_id, title, body)
SELECT id, board_id, title, coalesce(body, '') FROM issueCache;

DELETE FROM commentCacheFts;
INSERT INTO commentCacheFts (id, issue_id, board_id, body)
SELECT c.id, c.issue_id, i.board_id, c.body
FROM commentCache c
LEFT JOIN issueCache i ON i.id = c.issue_id;
