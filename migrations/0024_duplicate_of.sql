-- Evenflow D1 schema — migration 0024: duplicate-of pointer (EFB-30).
--
-- The other half of EFB-26. Deleting a duplicate ticket works, but it throws
-- away the thing that made the duplicate worth noticing: somebody filed this
-- twice, and the second filing usually carries context the first one didn't.
-- Linear's answer — and the one Evan picked over Jira's delete-and-redirect —
-- is to keep the row, point it at the original, and move it to Done.
--
-- One nullable column carries the whole feature:
--
--   duplicate_of_issue_id  the issueCache.id this issue duplicates;
--                          NULL means it is not a duplicate of anything.
--
-- SOFT FK, no REFERENCES clause. This matches every other cross-cache link in
-- the schema (issueCache.board_id, attachmentCache.issue_id, sprintMembership
-- .issue_id — all documented as soft in 0001 and 0010) and it is not merely
-- convention here: DELETE /issues/:id cascades comments in application code
-- and leaves audit rows standing, so a hard FK would either block deleting an
-- issue that something points at, or silently NULL the pointer out and lose
-- the fact that the duplicate ever had a target. A dangling pointer to a
-- deleted original is the honest outcome, and read paths already have to
-- tolerate it — see the resolve step in the API, which returns the pointer
-- whether or not the target still resolves.
--
-- NO CHECK constraint forbidding self-reference. The obvious
-- `CHECK (duplicate_of_issue_id <> id)` is tempting and wrong to rely on:
-- self-reference is only the ONE-hop case of the cycle problem, and the
-- N-hop case (A→B→A) is not expressible in a row-local CHECK at all. The
-- cycle walk in src/routes/issues.ts is the real guard and has to exist
-- regardless; a CHECK that catches 1 of the N cases would just invite the
-- reader to believe the database is enforcing something it isn't.
--
-- Partial index, not a full one. Duplicates are a small minority of any
-- board's rows, and the only queries that touch this column are "is this
-- issue a duplicate" (row-local, already covered by the PK) and the tide
-- loads' `IS NOT NULL` exclusion. WHERE-clause-matching keeps the index to
-- the handful of rows that are actually duplicates instead of carrying a
-- NULL entry for every issue on every board.
--
-- Additive DDL only — one ADD COLUMN, one partial index, no table rebuild.
-- Every existing row gets NULL, which is correct: none of them are duplicates.

ALTER TABLE issueCache ADD COLUMN duplicate_of_issue_id TEXT;

CREATE INDEX IF NOT EXISTS idx_issueCache_duplicate_of
  ON issueCache (duplicate_of_issue_id)
  WHERE duplicate_of_issue_id IS NOT NULL;
