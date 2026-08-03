# EFB-72 + EFB-73 — GitHub rules follow-ups (bundle)

Two related fixes to the github rules engine, both stemming from the 2026-08-02 dogfood incident where 38 tickets on evan-s-flow-board showed stuck "PR in review" pills after their PRs merged.

Ticket URLs:
- https://evenflow.work/api/v0/issues/EFB-72 (opened → In Review transition rule)
- https://evenflow.work/api/v0/issues/EFB-73 (set_column updates container)

**Read the ticket bodies first — they carry the full context, this doc is orientation + coordination only.**

## The incident that spawned these

The pill-vs-merge bug root-caused today:
- **Rule 1 (fixed via re-seed, not code):** merged rule on prod stored only `transition_to_column` — no pill-flip. Re-seeded via `PUT /boards/:slug/github {preset: "defaults"}` and the DB now has the full 2-action array. Verified: current merged rule id `95df2e41-ea44-4f26-848d-519758f40647` has `do: [set_external_state=pr_merged, transition_to_column=done]`.
- **Backfill:** 38 tickets flipped `pr_review → pr_merged` via D1 REST API (using EVENFLOW_CF_ACCOUNT_ID + EVENFLOW_CF_API_KEY + EVENFLOW_CF_EMAIL from mem_secret — X-Auth-Email + X-Auth-Key Global-API-Key auth, NOT Bearer). Scoped to `board_id = '4042afb7-d1fe-4a80-a311-9de404b0ee14'` AND external_state = 'pr_review' AND all PRs in github_links have state=merged. 5 tickets with any open PR were correctly skipped.

**Evan asked for EFB-72 explicitly**: *"Do we not have a rule that when a ticket has a PR in review the ticket gets moved to in review? If not we need that rule."*

**EFB-73 is the container-follow-through gap** exposed by the same incident — 8 tickets ended up `column=Done, container=backlog`, appearing "stuck in Backlog" while the column had moved.

## Bundle strategy

Both changes touch the github rules/execute engine and share the deploy + re-seed step. Bundle into ONE PR:
1. `src/github/rules.ts` — add transition to opened/reopened/ready_for_review rules (EFB-72)
2. `src/github/execute.ts` — set_column also updates container across category boundaries (EFB-73)
3. `src/lib/status-change.ts` if needed — populate `to_container` field
4. `src/routes/github.ts` if needed — emit `issue.container_changed` alongside `issue.transitioned` when container changes (mirrors EFB-66's discipline of "both change → both emit")
5. Tests for both changes
6. Deploy
7. Re-seed: `PUT /boards/evan-s-flow-board/github {"preset": "defaults"}` — critical or the rules change ships to code but not to prod DB
8. Backfill the 8 wrong-container tickets: EFB-64, EFB-65, EFB-66, EFB-67, EFB-68, EFB-69, EFB-70, EFB-71 (all currently `column=Done, container=backlog`; set container=active)

## Load-bearing surprises from the day

- **The merged-rule bug WAS NOT a `seedPreset` bug.** JSON.stringify handles arrays fine (re-seed today proved it). The stale seed was from a deploy that pre-dated commit `b26782e` (2026-07-30 15:14 UTC, "Rules `do` accepts action list"). This means: **if you edit `DEFAULT_PRESET_RULES`, boards using the `defaults` preset do NOT automatically pick up your change — they keep whatever was seeded at PUT time. Post-deploy you must call PUT /:slug/github {preset:"defaults"} on every board that uses defaults, or the code and DB drift.**
- **`STATUS_ONLY_PRESET_RULES` is derived from DEFAULT_PRESET_RULES** by stripping `transition_to_column` actions. So adding transitions to DEFAULT_PRESET_RULES ALSO changes what status_only strips. Read the mapping carefully — you probably want status_only to still be pill-only. The existing filter (`withoutTransitions`) will do the right thing automatically, but verify by reading the resulting shape.
- **Category constants:** `todo, in_progress, in_review, done, blocked` (src/columns.ts:1). `in_review` is valid.
- **First-match-per-event evaluation:** rules sort by priority ascending and the first ENABLED matching rule fires — its ENTIRE `do` array runs. Adding a transition action to an existing pill-set rule is safe; it doesn't create ordering issues.
- **Merged rule sets `pr_merged` pill + moves to Done in one atomic fire** — this is the pattern to follow. Same array shape for opened/reopened/ready_for_review, but transitioning to `in_review` instead of `done`.
- **Container derivation** (EFB-73): the mapping is a design call — my lean is `done → active` (belongs with the sprint that shipped it), `in_review / in_progress → active` (belongs with current work), `todo / blocked → don't touch container`. DM before implementing if you want to argue for a different mapping.
- **`insertStatusChange` already supports `to_container`** (from EFB-56). If the container is changing, populate it; if not, pass null.
- **BoardEvent emission:** EFB-66's discipline says both changes need both events. When container ALSO changes, emit `issue.container_changed` in addition to `issue.transitioned`. Otherwise SSE clients see column change but not container change and their local state drifts.

## D1 backfill mechanism (for the 8-ticket container cleanup)

Use the same pattern as today's pill backfill. Credentials from mem_secret:
- `EVENFLOW_CF_ACCOUNT_ID` (Cloudflare account id for evan108108@gmail.com personal account)
- `EVENFLOW_CF_API_KEY` (Global API Key)
- `EVENFLOW_CF_EMAIL` (evan108108@gmail.com)

Auth is `X-Auth-Email` + `X-Auth-Key` headers (NOT Bearer — Global API Key uses two-header pattern). D1 REST endpoint:
```
POST https://api.cloudflare.com/client/v4/accounts/$ACC/d1/database/67efa394-dc02-41e3-883a-b2ee885b1190/query
```
Body `{"sql": "..."}`. The wrangler CLI and CLOUDFLARE_API_TOKEN Bearer both fail with 7403 against this account — do NOT waste time on those paths.

**Board id for evan-s-flow-board: `4042afb7-d1fe-4a80-a311-9de404b0ee14`.**

Backfill SQL (verify count matches 8 before running the UPDATE):
```sql
SELECT short_id FROM issueCache
WHERE board_id = '4042afb7-d1fe-4a80-a311-9de404b0ee14'
  AND container = 'backlog'
  AND column_id IN (SELECT id FROM columnCache WHERE category = 'done');
-- Expect: EFB-64, EFB-65, EFB-66, EFB-67, EFB-68, EFB-69, EFB-70, EFB-71 (8 rows)

UPDATE issueCache SET container = 'active', updated_at_ms = <now>
WHERE board_id = '4042afb7-d1fe-4a80-a311-9de404b0ee14'
  AND container = 'backlog'
  AND column_id IN (SELECT id FROM columnCache WHERE category = 'done');
-- Expect: changes = 8
```

## Testing

- Unit: `evaluateDelivery` on `action=opened` → effects include both `set_external_state(pr_review)` AND `set_column(In Review)`.
- Unit: `evaluateDelivery` on `action=synchronize` → effects include ONLY `set_external_state(pr_review)` (regression guard — never re-transition on push).
- Unit: `applyEffect` with `set_column` targeting done-category on issue with `container=backlog` → produces both `set_column` AND `set_container=active` audit rows.
- Unit: `applyEffect` with `set_column` targeting todo-category → NO container change.
- Integration: fire a signed webhook `pull_request opened` against a ticket in Backlog/Todo → ticket lands in In Review column, pill = pr_review. SSE emits `issue.transitioned`.
- Integration: fire a signed webhook `pull_request closed merged=true` against a ticket in Backlog/In Review → ticket lands in Done column AND container=active, pill = pr_merged. SSE emits both `issue.transitioned` AND `issue.container_changed`.
- Post-backfill SQL smoke: `SELECT COUNT(*) FROM issueCache WHERE board_id = '4042afb7-d1fe-4a80-a311-9de404b0ee14' AND container='backlog' AND column_id IN (SELECT id FROM columnCache WHERE category='done')` returns 0.
- `check:boundary` clean.
- Baseline: 2 root pre-existing + 0 web = 2. Held.

## Deploy

- Standard evenflow deploy per hard rule (never deploy prod convex — this is CF Workers, safe).
- No new D1 migrations (this is code + data cleanup, not schema).
- Prod current: `66aa749b` (post-EFB-39). Verify with `wrangler deployments list` against the account before your deploy.
- **Post-deploy: MANDATORY `PUT /boards/evan-s-flow-board/github {"preset": "defaults"}`** to re-seed. Verify the three opened/reopened/ready_for_review rules now have array-form `do`. Without this, the code change ships but the rules on prod stay old and the whole ticket is a no-op.

## Coordination — MANDATORY DM points

- Post-brief-read: your read of whether STATUS_ONLY_PRESET_RULES should also gain the transition (probably NOT — status_only was pill-only intent) AND your read of the container-derivation mapping (default lean: done/in_review/in_progress → active; todo/blocked → no change).
- Pre-D1-write always. The mem_secret CF token has broad write access to evenflow D1 — a wrong WHERE clause could damage other boards' data. Board-scope every UPDATE.
- Pre-deploy always.
- Post-deploy: DM with re-seed confirmation (dump the three modified rules' shapes) AND backfill count confirmation.

## Standing rules

- Assignee never removed by system, nothing auto-assigned — untouched by this ticket, but do not ADD any assignment logic
- Never deploy prod convex — this is CF Workers, safe
- No focus rings on interactive elements — N/A this ticket
- `mem_secret_get` via MCP, not CLI
- Own worktree: `git worktree add ../evenflow-efb-72-73 -b efb-72-73-github-rules-followups off origin/main`
- No shared-checkout git ops
- Session `session-f4e8ed22897d418a`
