# EFB-18 — Org-level teams: DECISION DOC ONLY, no code

Ticket: `https://evenflow.work/api/v0/issues/EFB-18`

## Scope — this is a doc ticket, not a code ticket

Ticket body has explicit "punt to conversation before writing code" note. This dispatch is a decision-record doc under `docs/decisions/2026-08-org-teams.md`. **Zero code changes. Zero migrations. Zero shape edits.**

## What to produce

A ~500-word decision doc covering:

1. **The problem** — from the ticket body: "every board member added one at a time via invite; doesn't scale for a real org."

2. **The three design directions** the ticket already names, each as its own subsection:
   - **Option A: Teams as first-class objects.** Named team → membership propagates to boards.
   - **Option B: Default org team.** Every org auto-provisions "All members" team; per-board opt-in checkbox.
   - **Option C: Per-board access mode.** Boards marked private / team / org-wide; membership derived + audit-stamped.

3. **The five conversation-needed questions** from the ticket body, each with tradeoff analysis and a lean:
   - Persist team-member as separate rows vs derive live?
   - Private-board key grants at team-scope: per-member wrap vs team-shared with per-member key-wrap?
   - Role precedence: contributor via team A + admin via team B → which wins?
   - UI: dedicated `/orgs/:slug/teams` page vs fold into Members?
   - Default team as implicit-unrenamable vs real-editable?

4. **A recommendation** — the option or hybrid you think is right, with clear reasoning. This is not the deciding vote — Evan owns the design call — but a recommendation grounded in current codebase constraints is what makes the doc useful when Evan reads it.

5. **What implementation would look like** — one short paragraph per option, roughly: which files/tables would need touching, migration shape, D1 impact. Enough for whoever picks up the implementation ticket later to estimate scope.

## What NOT to produce

- Migration files (even skeleton)
- Schema changes
- Endpoint scaffolding
- Any TypeScript beyond what fits inline in the doc as an illustrative type sketch

## Testing

- `docs/decisions/2026-08-org-teams.md` renders (it's just markdown)
- No tests to add or run

## Deploy

- No deploy — pure doc ticket
- Merge PR when Sona approves
- Prod stays at `3997aa2a`

## Coordination — MANDATORY DM points

- Post-brief-read: your outline before writing the full doc
- Post-draft: DM me the full doc for review before merging PR
- If you feel one option is SO clearly correct that "recommendation" collapses into "this is what we should do" — that's fine, name it that way in the doc but flag it in your DM
- Pre-merge always

## Standing rules
- Own worktree: `git worktree add ../evenflow-efb-18 -b efb-18-org-teams-doc off origin/main`
- No shared-checkout git ops
- Session `session-f4e8ed22897d418a`
