# EFB-78 + EFB-79 — Transitions land at TOP + IssueCard title/badge overlap (bundle)

Two small, unrelated fixes bundled into one dispatch because they share a repo and a deploy. Ticket bodies carry full design; this doc is orientation + coordination only.

**Ticket URLs:**
- https://evenflow.work/api/v0/issues/EFB-78 (transitions land at top of column)
- https://evenflow.work/api/v0/issues/EFB-79 (IssueCard title collides with short_id badge)

## Bundle rationale

Same repo. Same deploy. Small enough that one worker + one PR is faster than two dispatches. Backend change (EFB-78, transition primitive) + frontend change (EFB-79, one CSS/layout fix in IssueCard). If either grows scope, DM to un-bundle.

## EFB-78 — transitions land at top of target column

**My lean, no design ambiguity left:** option (1) `newPosition = min(existing_positions_in_target_column) - 1`. Preserves the intra-column manual-reorder feature Kanban users expect; a re-transition puts the ticket above everything else but leaves other tickets' relative order intact.

**Two callsites:**
- `src/routes/issues.ts` transition handler
- `src/github/execute.ts` `applyEffect set_column` case

**Also apply on container moves.** When a ticket moves container (backlog → active from add-issue or from EFB-73's follow-through), it should also land at the top of the new container. Same position math.

**Falsification probe:** transition a ticket from Todo to Done; verify its new `position` < min(positions of every other Done ticket). Break the fix (comment out the position-bump); verify test fails. Restore; verify test passes.

## EFB-79 — IssueCard title/badge overlap

**My lean, no design ambiguity left:** option (1) reserve horizontal space for the badge via padding-right on the title container. Simplest, works for any title length.

**File:** `web/src/components/IssueCard.tsx`.

**Falsification probe:** render a card with a title long enough to reach the right edge (200+ chars, wrappable). Verify NO overlap between title text and badge at 375, 428, 768, 1024, 1440 widths. Break the fix (remove the padding); verify probe fails. Restore; verify probe passes.

## Standing rules (from tonight's earned memories)

- **Cut fresh worktree off `origin/main`**, NOT off local main which is often stale. Pattern: `git worktree add ../evenflow-efb-78-79 -b efb-78-79-bundle off origin/main`. Do NOT touch shared /Users/evan/projects/evenflow.
- **Do NOT ever `npm ci` in the shared checkout** — you'll delete the reproducer we've been using.
- **`cd web && npm run build` before `wrangler deploy`** or you ship an empty SPA (memory `evenflow-fresh-worktree-must-build-web-before-wrangler-deploy`).
- **`typecheck:src` + `check:boundary` + `check:boundary-query`** should all be clean. Test suite green.
- **Deploy → merge sequence:** wrangler deploy, verify version id + spot-probe, THEN merge immediately. Do not leave main-behind-prod window open.

## Pre-authorization (per worker-9046684145's model)

If ALL of these hold, you're pre-authorized-through-merge without another DM round-trip:
- Design approved in this brief (both tickets — my leans stand, no more questions from me)
- All tests + typecheck + boundary checks green
- Proven-can-fail evidence for both fixes
- Fresh worktree cut off origin/main
- `cd web && npm run build` done before wrangler deploy

If any of those are absent or in doubt, DM before ship.

## Post-deploy

Transition EFB-78 + EFB-79 to Done via `POST /issues/:short_id/transition {"column_id":"4a554e46-1b11-428e-a034-0f84344b5e7b"}`. The merged rule may fire automatically if the PR title/body carries the short_ids — but manual is more reliable and covers the case where extractTicketRefs misses.

DM me with: prod version id, before/after transition test (`POST /issues/EFB-78/transition` verifying new position < min(other Done positions)), and the IssueCard render probe result (screenshot of a long-title card at 375/428 widths).

## Session

`session-f4e8ed22897d418a`
