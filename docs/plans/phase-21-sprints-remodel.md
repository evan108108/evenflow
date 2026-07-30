# Phase 21 — Sprints, remodeled

Status: planning
Owner: Evan
Written: 2026-07-30

## What we're changing and why

Today the Backlog view crams three concepts into one page: an "Active" section (issues with `container=active`, grouped by column), a "Sprints" block (planning + started, each holding issues by `sprint_id` regardless of container), and a flat Backlog list. Because sprint membership is independent of container, an active-container issue that's in a sprint shows up in BOTH the Active section AND the sprint's section on the same page. Users read that as "why is this card here twice?" and the whole surface stops making sense.

We're going to fix it by treating **sprint** and **container** as two orthogonal dimensions with clean, non-overlapping views on top:

- **Kanban view** = the doing surface. Shows `container=active` issues. Always. Sprints are irrelevant to whether a card appears here — a card is on the Kanban because someone said "we're working on this."
- **Backlog view** = the planning surface. Shows `container=backlog` issues, organized into planning-sprint sub-buckets (if the team uses sprints) or a flat list (if they don't).
- **A card is in exactly one physical place at a time.** No duplication, ever.

Sprints stay optional. Kanban-only, pull-based teams never touch the "+ New sprint" button and the model behaves like a normal Kanban board. Scrum-style teams use sprints as batched-work groupings, get real velocity, and get sprint history.

## Model

### Domain

- **Issue** carries `container` (`active | backlog | iced`), `column_id`, and `sprint_id` (nullable). These are three orthogonal dimensions. `sprint_id` is the CURRENT sprint membership, not the historical set.
- **Sprint** carries `id`, `name`, `goal`, `status` (`planning | active | completed`), `planned_days`, `started_at_ms`, `completed_at_ms`.
- **New: SprintMembership audit** — `sprint_id, issue_id, added_at_ms, removed_at_ms, was_completed_in_sprint`. This is what makes history queryable ("issue X was in Sprint 5, was incomplete when 5 closed"). Written on every add/remove/carry-over.

### Container ↔ sprint independence

- Adding an issue to a sprint does NOT move its container. A `container=backlog` issue with `sprint_id = X` sits in Sprint X's bucket on the Backlog view; the same issue with `container=active` sits on the Kanban.
- Removing an issue from a sprint does NOT change its container. Just clears the `sprint_id`.
- Promoting/demoting between `active` / `backlog` / `iced` is unchanged and independent of any sprint membership.

### Sprint lifecycle

1. **Create sprint (status=planning)** on Backlog view. Empty bucket appears. Drag `container=backlog` issues in to shape it. Set `planned_days` override if you want a different length than the board default. Sprint has a goal, name, editable both.
2. **Delete planning sprint** — hard delete. Every member issue has its `sprint_id` cleared (back to the unassigned Backlog pile). Membership audit rows for this sprint are deleted too (a planning sprint that never started has no history worth keeping). Confirmation dialog: "Delete Sprint 12? Its N issues go back to the Backlog." No confirmation if the sprint is empty.
3. **Start sprint (status=active)** flips the status, stamps `started_at_ms`. Kanban view gets a new **sprint filter chip** ("Sprint 12") in its header — clicking it filters Kanban to only issues where `sprint_id = active sprint`. Chip off = show all active. No physical move happens; no issue's container changes.
4. **Add mid-sprint** — set `sprint_id = active sprint`. Audit row written. Card now counts toward that sprint's committed points; velocity report distinguishes mid-sprint adds from initial commitment.
5. **Complete sprint (status=completed)** stamps `completed_at_ms`. For every issue with `sprint_id = completed sprint`:
   - If the issue's column is `Done` (column category = `done`), leave `sprint_id` alone. It stays a member of the completed sprint (that's how history works). Audit row marks `was_completed_in_sprint = true`.
   - If NOT done, the user picks: **carry over** (rewrite `sprint_id` to the next planning sprint if one exists, else null), or **drop** (`sprint_id = null`, back to unassigned backlog). Audit row marks `was_completed_in_sprint = false` and records the destination.
   - Kanban's Done column visibly shrinks (its current-sprint filter empties for this sprint) until Sprint 13 has its own done items.
6. **Delete active or completed sprint** — NOT allowed in v1. Active sprints must be Completed first (which is the graceful path). Completed sprints are history and shouldn't be deletable — the audit trail is load-bearing for velocity and past-work queries. Follow-up if it ever matters: an "archive sprint" verb that hides it from lists but keeps rows.

## Views

### Backlog view (rewritten)

Three sections top-to-bottom, all showing ONLY `container=backlog` issues:

1. **Planning sprints** — one section per `status=planning` sprint. Header: name (editable), goal, `planned_days` field, `Start sprint` button. Cards drag in/out.
2. **Unassigned Backlog** — flat list of `container=backlog && sprint_id=null`, ordered by `position`.
3. **Icebox drop strip** at the bottom (dragging any card here sets `container=iced`).

Removed: the Active section. Removed: any Active-container issues appearing on this page.

Sidebar (or a collapsible right panel): **Sprints** panel showing:
- `Planning` — the same sprints as above (nav shortcut).
- `Active` — the current started sprint if any. Click → jumps to Kanban with the sprint filter chip on.
- `Completed` (collapsed by default) — reverse-chronological list. Click a completed sprint → sprint archive page.

### Kanban view (small changes)

- Adds a **sprint filter chip** in the header when there's an active sprint. On by default the first time you visit after starting a sprint. Toggle to show all `container=active`.
- **Done column** filter defaults to "this sprint" when the chip is on. When no active sprint (kanban-only teams), Done shows "last N days" (default 14, configurable per board). A "Show all" flip on the column header always exists.
- No other structural changes.

### Sprint archive page (new)

Route: `/@handle/board/xxx/sprints/<sprint-id>`.

- Header: sprint name, goal, dates (`started_at_ms` → `completed_at_ms`), duration in days, points committed at start, points completed by end, points carried, mid-sprint adds count.
- Body: every issue that was ever a sprint member (from the audit table), grouped as:
  - **Completed in sprint** — `was_completed_in_sprint = true`.
  - **Carried over** — `was_completed_in_sprint = false` with `carried_to_sprint_id != null`.
  - **Dropped** — `was_completed_in_sprint = false` with `carried_to_sprint_id = null`.
- Each row: title, ref, completed-at, assignee avatar. Read-only.

### Sprints list page (new)

Route: `/@handle/board/xxx/sprints`.

Three sections: Planning / Active / Completed (paginated). Each row is a card with sprint name, dates, status, points completed (for completed sprints), a velocity delta vs the rolling 3-sprint average.

## Schema changes

Migration `0017_sprint_lifecycle.sql`:

```sql
-- Audit trail: which sprints an issue has ever been in and what happened.
CREATE TABLE sprintMemberships (
  id TEXT PRIMARY KEY,
  sprint_id TEXT NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  added_at_ms INTEGER NOT NULL,
  removed_at_ms INTEGER,
  was_completed_in_sprint INTEGER NOT NULL DEFAULT 0,  -- set at sprint-complete time
  carried_to_sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL
);
CREATE INDEX idx_sprintMemberships_issue ON sprintMemberships(issue_id);
CREATE INDEX idx_sprintMemberships_sprint ON sprintMemberships(sprint_id);

-- Sprint metrics we compute at complete-time so archives are cheap to read.
ALTER TABLE sprints ADD COLUMN points_committed_start INTEGER;
ALTER TABLE sprints ADD COLUMN points_completed INTEGER;
ALTER TABLE sprints ADD COLUMN points_carried INTEGER;
ALTER TABLE sprints ADD COLUMN adds_mid_sprint INTEGER NOT NULL DEFAULT 0;

-- Per-board Done-column window when no active sprint (kanban-only teams).
ALTER TABLE boards ADD COLUMN done_window_days INTEGER NOT NULL DEFAULT 14;
```

Backfill: for every existing issue with `sprint_id != null`, write a `sprintMemberships` row with `added_at_ms = issues.created_at_ms` (best-effort — we don't have the real add time from before this migration).

## API changes

### New endpoints

- `POST /api/v0/sprints/:id/complete` — body `{ carryOver: "next_planning" | "drop", nextSprintId?: string }`. Runs the completion logic: marks Done issues, carries non-Done issues per policy, writes metrics, flips status.
- `DELETE /api/v0/sprints/:id` — allowed ONLY when `status = planning`. Clears `sprint_id` on every member issue, deletes membership audit rows for this sprint, deletes the sprint row. 409 on active or completed sprints.
- `GET /api/v0/sprints/:id/archive` — returns the sprint archive page payload: sprint metadata, three membership groups (`completed_in_sprint`, `carried_over`, `dropped`).
- `GET /api/v0/boards/:slug/sprints?status=<...>` — list sprints by status with metrics.

### Modified endpoints

- `POST /api/v0/sprints/:id/add-issue` — writes a `sprintMemberships` row (with `added_at_ms=now`) in addition to updating `issues.sprint_id`. If sprint is `active`, increments `sprints.adds_mid_sprint`.
- `POST /api/v0/sprints/:id/remove-issue` — writes `removed_at_ms=now` on the open membership row.
- `POST /api/v0/sprints/:id/start` — snapshots `points_committed_start = sum of estimates for current members`.

### Kanban read filter

- `GET /api/v0/boards/:slug/issues` — accepts `sprint_id=<id>` filter. When absent, returns all `container=active` (current behavior).
- `GET /api/v0/boards/:slug/issues?container=active&column=done` — respects `done_window_days` when no active sprint filter is present.

## Migration strategy (data)

Existing boards that already have sprints with issues assigned:

1. Run migration 0017 → creates `sprintMemberships`, adds columns.
2. Backfill script: for each `(sprint, issue)` pair where `issues.sprint_id = sprint.id`, insert one `sprintMemberships` row with `added_at_ms = issues.created_at_ms`, `was_completed_in_sprint = 0`, `removed_at_ms = null`. Best-effort — we can't recover real add times.
3. For any sprint with `status=completed`, additionally mark rows `was_completed_in_sprint = 1` if the issue's column category is `done`; otherwise leave the row as-is (represents "was in sprint at time of completion but not done, and we don't know if it was carried or dropped").
4. Existing `container=active` issues with `sprint_id` set: unchanged. They live on the Kanban already; the sprint chip filter will pick them up.

## UI changes (concrete file list)

- `web/src/pages/board/BacklogView.tsx` — remove Active section entirely. Restructure into: planning-sprint sections (top), Unassigned Backlog (middle), Icebox strip (bottom). Add right-hand Sprints panel (or a slide-out).
- `web/src/pages/board/KanbanView.tsx` — sprint filter chip in header (when there's an active sprint), Done-column "this sprint / last N days / all" toggle.
- `web/src/pages/board/BoardPage.tsx` — drop-handler simplification: no more "if dropping sprint-assigned issue on backlog, remove from sprint" special-casing, because sprint membership is now purely additive/removable in isolation.
- `web/src/pages/SprintArchive.tsx` — new page for `/@handle/board/xxx/sprints/<id>`.
- `web/src/pages/SprintsList.tsx` — new page for `/@handle/board/xxx/sprints`.
- `web/src/pages/board/store.ts` — `startSprint`/`completeSprint`/`addIssueToSprint`/`removeIssueFromSprint` updated for the new API contracts; new `sprintArchive(id)` and `sprintsList(status)` fetchers.
- `src/routes/sprints.ts` — new complete handler, membership audit writes on add/remove, archive endpoint.
- `src/routes/issues.ts` — accept `sprint_id` filter, respect `done_window_days`.

## Slicing

- **21a — Foundational remodel (schema + Backlog surgery).** Migration 0017, membership audit writes, drop Active section from Backlog view, sprint sub-buckets, Sprints panel. Kanban unchanged behaviorally. Ship-ready standalone.
- **21b — Sprint completion + carry-over + archive page.** Complete-sprint endpoint with carry policy, sprint archive page, sprint metrics.
- **21c — Kanban sprint filter chip + Done window.** Chip in header, Done column window per board.
- **21d — Sprints list page + basic velocity.** `/sprints` page. **Velocity for everyone** — simple rolling average of points-completed over the last N days (N defaults to `board.default_sprint_days`, configurable per board). Same math whether the board uses sprints or not: sum the estimates of every issue transitioned into a `done`-category column within the trailing window, divide by the window in the display unit (per day / per week / per configured sprint length). Powers "we ship ~14pts every 2 weeks" for kanban-only teams and gives scrum teams a comparison against per-sprint committed vs completed.

Ship 21a first — it removes the duplication confusion that started this whole conversation. 21b unlocks sprint history. 21c and 21d are polish and can wait.

## Explicit non-goals (this phase)

- **Auto-planning next N sprints from velocity + backlog order + issue estimates.** Deferred (Evan flagged as future).
- **Capacity meter while dragging into a planning sprint.** Nice to have; needs 21d velocity to exist first.
- **Multi-sprint membership** (Jira-style). Sticking with single-value `sprint_id` + audit trail. The trail gives us the "which sprints has this been in" answer without complicating the primary field.
- **Sprint templates / recurring sprint auto-create.** Deferred.
- **Cross-board sprints.** Sprints stay board-scoped.

## Verification

- Backlog view never shows an `container=active` issue.
- Kanban view never shows a `container=backlog` or `container=iced` issue.
- No card appears in two sections on any view.
- Kanban-only workflow: create a board, don't create any sprints, use Kanban normally. Everything works. Done column shows last 14 days.
- Scrum workflow: create 3 backlog issues, create Sprint 1, drag all 3 in, Start, promote one to Active from Kanban, mark it Done, Complete sprint (choose "carry over" for the other two). Verify: Kanban's Done shrinks, Sprint 1 archive shows 1 completed + 2 carried, Sprint 2 (auto-created or existing planning sprint) now has the 2 carried issues.
- Audit table: after the workflow above, `sprintMemberships` has 3 rows for Sprint 1 (one with `was_completed_in_sprint=1`, two with `carried_to_sprint_id=<sprint 2 id>`), plus 2 fresh rows for Sprint 2's carried issues.
