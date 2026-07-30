-- 0015 — unify Visibility + Privacy into one setting.
--
-- Before this migration BoardSettings shipped TWO overlapping controls:
--   * "Privacy"    → boardCache.is_encrypted (real crypto: 16.5 audience
--                    keys, encrypted publish, per-member grants)
--   * "Visibility" → boardCache.visibility   (app-level ACL only)
-- Two fields, two meanings, one confused user. `visibility` wins and
-- becomes the single source of truth:
--   public  = plaintext publish to the 4a substrate, anonymous read
--   private = members only; once the board's audience is minted every
--             event publishes encrypted via the 16.5 machinery
--
-- The application layer stops reading is_encrypted entirely — "encryption
-- is live" is now derived as (visibility = 'private' AND audience_pubkey IS
-- NOT NULL), which is exactly equivalent to is_encrypted = 1 for every row
-- that exists (initializeBoardAudience only ever set the two together).

-- Boards that were actively using 16.5 encryption are private, full stop.
-- (Reconciles any row where the two controls disagreed.)
UPDATE boardCache SET visibility = 'private' WHERE is_encrypted = 1 AND visibility != 'private';

-- Evan's board is visibility='private', is_encrypted=0 — the now-meaningless
-- "app-level-only privacy" state. Per his direction its data is already
-- public, so resolve it to public rather than to encrypted.
UPDATE boardCache SET visibility = 'public' WHERE id = '4042afb7-d1fe-4a80-a311-9de404b0ee14';

-- is_encrypted stays as a DEAD column. Dropping it in SQLite means
-- rebuilding the table, and D1 cannot rebuild an FK-referenced parent; a
-- later cleanup migration can do it properly. Nothing reads it after this
-- migration — initializeBoardAudience keeps writing it only so hand-run SQL
-- still tells the truth.
