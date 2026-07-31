-- Evenflow D1 schema — migration 0022: plaintext substrate publish (EFB-24).
--
-- Public boards have always written D1 and fanned out over SSE while
-- publishing nothing to 4a: kinds 30550-30554 were declared in comments and
-- in migration 0001's table headers, but no code ever emitted them. Private
-- boards got their substrate mirror in phase 16.5 (encrypted 30555-30557
-- wraps) and tide readings got theirs in EFB-22 (30560/30565). This migration
-- carries the last piece — the cache columns that record where a public
-- board's plaintext event landed.
--
-- One nullable column per cache, matching the name and semantics already
-- established by orgCache (0004) and sprintTideSnapshot (0021):
--
--   substrate_event_id  the 4a event id, stamped after a successful publish;
--                       NULL means the publish never landed.
--
-- A NULL is never load-bearing. The publish is best-effort and fired off the
-- request path (Effect.forkDaemon), so a gateway outage costs a substrate
-- event and nothing else — the *Cache row is already committed, the SSE
-- envelope already went out, and every event is rebuildable from the cache
-- row it mirrors. Read paths must therefore treat NULL as "not published
-- yet", never as "this entity is broken".
--
-- Deliberately no indexes. sprintTideSnapshot (0021) carries a partial
-- `WHERE substrate_event_id IS NULL` index for a future retry sweep, which is
-- cheap there — one row per sprint per day. These five are the hot write
-- tables, and the same index would churn on every single write: a fresh row
-- enters the index as NULL and leaves it microseconds later when the publish
-- stamps it. The retry sweep is still unbuilt (see TODO(substrate-retry) in
-- src/membership.ts); when it lands, whoever builds it can add the indexes it
-- actually needs and measure the cost then.
--
-- Additive DDL only — five ADD COLUMNs, no table rebuilds. Nothing here
-- rewrites existing rows: every pre-existing entity keeps substrate_event_id
-- NULL, which is exactly right, because none of them were ever published.

-- kind:30550 fa:KanbanBoard
ALTER TABLE boardCache        ADD COLUMN substrate_event_id TEXT;

-- kind:30551 fa:KanbanIssue
ALTER TABLE issueCache        ADD COLUMN substrate_event_id TEXT;

-- kind:30552 fa:KanbanComment
ALTER TABLE commentCache      ADD COLUMN substrate_event_id TEXT;

-- kind:30553 fa:KanbanStatusChange
ALTER TABLE statusChangeCache ADD COLUMN substrate_event_id TEXT;

-- kind:30554 fa:KanbanSprint
ALTER TABLE sprintCache       ADD COLUMN substrate_event_id TEXT;
