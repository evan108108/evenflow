-- Evenflow D1 schema — migration 0026: CSV import (EFB-15).
--
-- Bulk-create from a CANONICAL Evenflow CSV shape. There is no vendor-specific
-- code anywhere in this feature: a user asks their AI to transform a Linear /
-- Jira / GitHub export into our columns, and we accept only our own shape. So
-- nothing here names a vendor, and nothing here should ever start to — a
-- `jira_key` column would be the first crack in that.
--
-- ── WHY TWO TABLES, WHEN ONE PRIMARY KEY WOULD DEDUPE ────────────────────
--
-- The import id is minted client-side when the CSV is PARSED, and travels with
-- the POST. That makes replay detection a primary-key insert rather than a
-- heuristic — "did I already run this exact import?" is answered by whether the
-- row is there, not by comparing row counts and hoping.
--
-- One table could carry that. Two exist because the two facts have genuinely
-- different retention:
--
--   issueImports      WHO imported HOW MANY rows into WHICH board, and WHEN.
--                     An audit fact. Permanent, and small — six integers and
--                     two ids per import, no per-row detail.
--
--   issueImportDedup  the exact RESPONSE BODY to replay if the same import id
--                     arrives again. Bulky (a per-row status entry for up to
--                     1000 rows) and only useful inside the retry window, so it
--                     is swept at 24h.
--
-- Collapsing them would force one retention policy onto both, and both choices
-- are wrong: keeping the reports forever grows the table by ~100KB per import
-- for data nobody reads after the tab closes, and expiring the audit destroys
-- the record of who imported what. The split is the retention difference, not
-- normalization for its own sake.
--
-- `issueImportDedup`, not the brief's `importIdDedup`. The README's warning
-- about the two webhook families ("mind the prefix — these are unrelated and
-- must never be joined") cuts the other way here: these two ARE one family and
-- the shared `issueImport` prefix says so. A bare `importIdDedup` reads like a
-- third, unrelated import mechanism.
--
-- ── WHY `external_url` IS UNIQUE PER BOARD, AND WHAT THAT DOES NOT MEAN ──
--
-- Re-importing a CSV must not duplicate the issues it already created. The key
-- is `external_url` — the vendor's permalink for the row, which every one of
-- Linear/Jira/GitHub emits and which survives a title edit on either side.
--
-- The handler checks for the duplicate BEFORE inserting and reports that row as
-- `skipped-duplicate`, which is the path every normal re-import takes. The
-- UNIQUE index exists for the window that check cannot cover: two imports of
-- the same CSV in flight at once, where both SELECTs miss and both INSERTs
-- proceed. Without the constraint that races to two copies silently — the
-- precise shape of EFB-51, where an unnormalized bulk dedupe produced a silent
-- double-write.
--
-- The handler does NOT translate a constraint violation into `skipped-duplicate`.
-- It reports that row as failed and names the race. Mapping the two together
-- would mean any UNIQUE failure — including one from a bug we have not found
-- yet — gets reported as a routine, expected skip, which is a boundary saying
-- "yes" where it should say "no, and here's why" (docs/BOUNDARY_DISCIPLINE.md).
-- The pre-check and the constraint answer different questions and get different
-- answers.
--
-- Scoped `(board_id, external_url)`, not global: importing one Linear export
-- into two boards is legitimate — a team splitting a backlog does exactly that
-- — and a global unique index would silently make the second board's import
-- come back empty.
--
-- PARTIAL on `external_url IS NOT NULL`. Every issue that predates this
-- migration, and every issue created through the normal UI, has NULL here, and
-- SQLite treats NULLs as distinct in a unique index anyway. Restricting the
-- index to non-NULL rows keeps it to the imported minority instead of carrying
-- an entry per issue on every board — the same reasoning as 0024's partial
-- index on duplicates.
--
-- ── `import_event_id` — the backreference ────────────────────────────────
--
-- Points at `issueImports.id`. This is the column that answers "where did this
-- issue come from?" long after the import report has been swept, and it is also
-- the reason no AI-provenance flag is needed on the issue itself: an import is
-- recorded as an EVENT, and whether the CSV came from ChatGPT or from someone
-- editing cells by hand is not a fact we can observe or should claim to.
--
-- SOFT FK, no REFERENCES clause — consistent with every cross-cache link in
-- this schema (issueCache.board_id, attachmentCache.issue_id, 0025's delivery
-- rows). An issue must survive the expiry or deletion of its import record;
-- losing the pointer's target costs provenance, while a hard FK would make
-- deleting an import record either impossible or silently destructive.
--
-- Additive DDL only — two ADD COLUMNs, two new tables, no table rebuild. Every
-- existing issueCache row gets NULL for both, which is correct: none of them
-- were imported.
--
-- CREATE TABLE without IF NOT EXISTS, per 0025's reasoning: in a migration that
-- ESTABLISHES a feature, `IF NOT EXISTS` turns "the shape I asked for was not
-- achieved" into "no error", which is the DDL rendering of silent success. A
-- bare CREATE TABLE fails loud on collision, which is the only useful outcome.

ALTER TABLE issueCache ADD COLUMN external_url TEXT;
ALTER TABLE issueCache ADD COLUMN import_event_id TEXT;

-- Both the dedup pre-check ("has this board already imported this URL?") and
-- the race backstop. See the header for why this is UNIQUE and why the handler
-- still pre-checks.
CREATE UNIQUE INDEX idx_issueCache_board_external_url
  ON issueCache (board_id, external_url)
  WHERE external_url IS NOT NULL;

-- "Which issues came from this import?" — the provenance read, and the query a
-- future undo-an-import would run. Partial for the same reason as above.
CREATE INDEX idx_issueCache_import_event
  ON issueCache (import_event_id)
  WHERE import_event_id IS NOT NULL;

-- ── issueImports ── permanent audit of import EVENTS ─────────────────────
CREATE TABLE issueImports (
  -- The client-minted import id, echoed back in the response. PRIMARY KEY, so
  -- a replayed POST collides here rather than being detected by a count.
  id                 TEXT    PRIMARY KEY,
  board_id           TEXT    NOT NULL,
  imported_by_pubkey TEXT    NOT NULL,
  imported_at_ms     INTEGER NOT NULL,
  -- Rows in the submitted batch. created + skipped + failed = row_count, and a
  -- reader who finds otherwise has found a bug rather than a rounding.
  row_count          INTEGER NOT NULL,
  created_count      INTEGER NOT NULL,
  -- Deliberately not created: duplicate external_url, or a status/type/
  -- container value this board has no home for. An expected outcome.
  skipped_count      INTEGER NOT NULL,
  -- Rows that could not be created for a reason we did not choose. Distinct
  -- from skipped because the two need different reactions: a skip is the
  -- feature working, a failure is something to look at.
  failed_count       INTEGER NOT NULL,
  -- How many rows named an assignee this board could not map, and so landed
  -- unassigned (Evan's Option a — no shadow identity is ever invented). Counted
  -- rather than only reported per-row because the per-row detail is swept at
  -- 24h and "we quietly dropped 40 assignees" must outlive that.
  unmapped_assignees INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_issueImports_board
  ON issueImports (board_id, imported_at_ms DESC);

-- ── issueImportDedup ── 24h replay window ────────────────────────────────
--
-- Retention sweep is opportunistic-on-write, following 0016's
-- githubWebhookDedup precedent: this needs no new cron branch, and an import is
-- rare enough that sweeping on the write path costs nothing measurable. The
-- index keeps that delete cheap.
CREATE TABLE issueImportDedup (
  -- Same value as issueImports.id. Separate table, so this one can be swept
  -- without touching the audit row.
  id            TEXT    PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  -- The verbatim response body of the original POST. Replayed byte-for-byte on
  -- a retry, so a client that lost the first response gets the SAME per-row
  -- outcomes rather than a fresh report describing a board that has since
  -- moved on.
  response_json TEXT    NOT NULL
);

CREATE INDEX idx_issueImportDedup_created
  ON issueImportDedup (created_at_ms);
