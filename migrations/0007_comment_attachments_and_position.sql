-- Evenflow D1 schema — migration 0007: comment attachments + comment
-- body_format + fractional issue positions (phase 18c+d).
--
-- comment_id makes issueAttachmentCache dual-owner: NULL = the attachment
-- belongs to the issue (the sheet's Files panel), non-NULL = it belongs to
-- one comment on that issue. issue_id stays NOT NULL either way — a comment
-- attachment is still scoped to (and capped with) its issue.
--
-- commentCache.body_format follows the 0006 issueCache pattern exactly:
-- new comments are GFM markdown; rows that predate this migration are
-- pinned 'plain' so they keep rendering white-space: pre-wrap.
--
-- issueCache.position is the intra-column sort key (Trello-shape
-- fractional positioning): append = max+1000, insert = midpoint of the
-- neighbors, rebalance to whole steps when midpoints degrade. NULL means
-- "legacy row, order by updated_at_ms DESC after every positioned row" —
-- the first reorder on a column rebalances the whole column to positions.

ALTER TABLE issueAttachmentCache ADD COLUMN comment_id TEXT;
CREATE INDEX IF NOT EXISTS idx_issueAttachmentCache_comment_id ON issueAttachmentCache(comment_id);

ALTER TABLE commentCache ADD COLUMN body_format TEXT NOT NULL DEFAULT 'markdown' CHECK(body_format IN ('plain','markdown'));
UPDATE commentCache SET body_format = 'plain';

ALTER TABLE issueCache ADD COLUMN position REAL;
