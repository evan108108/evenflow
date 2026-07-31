# EFB-30 — Duplicate-of pointer + auto-move to Done + tide filter (Linear-style)

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-30`

## Scope one-liner

The "duplicate side" of EFB-26 (delete-from-sheet). Instead of deleting a duplicate ticket, mark it as "duplicate of another" — automatically move to Done, keep the pointer so context isn't lost, and exclude from tide metrics so it doesn't count as extra committed work.

## Prior approval (from earlier session)

Evan reviewed Jira/Linear approaches and picked **Linear-style**:
- Duplicate ticket auto-moves to Done column
- Stores `duplicate_of` pointer (issue id) on the original
- Tide metric filter excludes duplicates from committed_pts / done_pts (they don't count as extra work)
- Preserves audit trail (nothing deleted, just marked)

Not-in-scope alternatives explicitly rejected:
- Delete + redirect (Jira-style) — loses audit
- Merge fields into original — too complex, unclear conflict resolution

## Load-bearing surprises

1. **Migration required.** New column `duplicate_of_issue_id TEXT NULL` (or similar) on `issueCache`. Migration 0024 (or wherever the counter lands post-EFB-24's 0022). Local apply first, DM Sona before prod.

2. **Tide filter change ripples to EFB-22's snapshot math.** `sprintTideSnapshot` counts committed_pts and done_pts — both need to exclude issues where `duplicate_of_issue_id IS NOT NULL`. If not, marking a duplicate as duplicate would REDUCE committed_pts (issue moves to Done) which is correct, but wouldn't reduce it because it was already Done — actually simpler than I first thought. Verify tide math against the actual query.

3. **UI affordance in IssueSheet.** The existing "delete" affordance from EFB-26 becomes one of two: "Delete" (destructive, cascades to worker's board.deleted-cascade concern) OR "Mark as duplicate of..." (opens issue picker, sets pointer, auto-transitions to Done). Consider: is delete still a first-class action, or does "mark as duplicate" replace it for most cases? Design call in-ticket. My lean: keep both, but "mark as duplicate" is the primary affordance and delete is behind an "advanced" reveal.

4. **The linked-issue picker needs a search.** For a board with 100+ issues, scrolling isn't viable. Search-as-type filter over the picker (probably reusing EFB-44's assignee picker component pattern).

5. **Circular duplicate check.** Prevent A→B→A pointer cycles. Simple: if setting duplicate_of on A, check target B's duplicate_of chain doesn't lead back to A.

6. **Tombstone / substrate consideration (post-EFB-32):** marking a duplicate is like a lightweight tombstone — should it publish a `duplicate_of` field on 30551 (KanbanIssue) events? Lean: yes, add `fa:duplicate_of` tag when set. Consumers replaying the substrate should see the pointer. Gateway validator update: probably accept unknown tags already; verify.

## Files to touch

| File | Change |
|---|---|
| `migrations/0024_duplicate_of.sql` (new) | Add `duplicate_of_issue_id TEXT NULL REFERENCES issueCache(id)` (soft FK, per project convention) |
| `src/shapes.ts` IssueShape | Add `duplicate_of_issue_id: string \| null` |
| `src/routes/issues.ts` | New action or PATCH extension: `mark_duplicate_of` takes target issue id, checks circular, auto-transitions to Done, sets pointer |
| `src/lib/tide/facts.ts` (or wherever tide math lives) | Exclude issues where `duplicate_of_issue_id IS NOT NULL` from committed_pts + done_pts |
| `src/lib/audience/audience-events.ts` | `buildKanbanIssue` optionally includes `fa:duplicate_of` tag |
| `src/audiences.ts` | `emitSecureBoardEvent` for issue.updated includes duplicate_of when set |
| `web/src/components/IssueSheet.tsx` | "Mark as duplicate of..." action opens picker, sets pointer |
| `web/src/components/IssuePicker.tsx` (new or extended) | Search-as-type filter over board's issues |
| `web/src/pages/board/BoardPage.tsx` (or wherever cards render) | Duplicate cards display with a subtle "→ #issue-N" indicator so it's visible without opening the sheet |
| Tests | Migration 0024 applies; marking as duplicate auto-Dones; tide excludes duplicates; circular prevention; substrate publishes fa:duplicate_of tag |

## Testing

- Mark issue A as duplicate of B → A auto-moves to Done, A.duplicate_of_issue_id = B.id
- Circular: attempt A as duplicate of B when B already points at A → 400 `{reason: "circular_duplicate"}`
- Tide snapshot on a board with duplicates → committed_pts and done_pts exclude the duplicate rows
- Substrate: post-mark, 30551 publish carries `fa:duplicate_of` tag with B's id
- UI: duplicate cards render with indicator; picker searches
- Full suite green

## Deploy context

- Prod evenflow at v `8e8d531b`
- Migration 0024: LOCAL first, DM Sona before prod
- No gateway change needed (validator accepts unknown tags per existing shape)
- Standard evenflow deploy: `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` per hard rule
- Tracker backfill discipline: use `migrations apply --remote` not `execute --file` (per EFB-38 postmortem, tracker skip is real)

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14` (@evan108108/evan-s-flow-board)
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`

## Related

- EFB-26 (shipped): delete-from-sheet — the "delete side" of this ticket. Duplicate-of is the "preserve-with-pointer side."
- EFB-22 (shipped): tide math being modified
- EFB-24 (shipped): substrate event vocabulary being extended
- EFB-32 (shipped): tombstone pattern — duplicate_of is a lighter-weight variant

## Coordination points — DM me before

- Circular check design (probably fine to just walk 5 hops, DM if considering something clever)
- Whether "Delete" and "Mark as duplicate" both exist in the sheet menu, or duplicate replaces delete
- Migration 0024 prod apply
- Any change to tide math semantics beyond exclusion (e.g. should duplicates count against velocity? my lean is no, but this is a product call)

## DM FLOW — MANDATORY

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. Sona is AFK; replies via channel notifications.
3. Status DMs at meaningful phases: design pick on delete-vs-duplicate coexistence, migration, backend, UI, pre-deploy.
4. **DO NOT `worker_event_complete` until Sona reviewed AND said shipit.**
5. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Checkpoint caveat

Multiple parallel dispatches out. VERIFY BY CONTENT. State should say "EFB-30 dispatch". If not, restore from brief.

## Standing rules

- NO deploy without approval. PR target: `main`.
- Migration prod apply requires DM confirmation.
- Baseline: 2 root + 1 web pre-existing tsc errors.
- Use `migrations apply --remote` (not `execute --file`) for tracker safety.
