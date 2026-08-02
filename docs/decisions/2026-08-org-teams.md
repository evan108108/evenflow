# Org-level teams: bulk grant board access

**Status:** Open. No option chosen — this doc exists to make the choice cheap, not to make it.
**Date:** 2026-08
**Tickets:** EFB-18. Two follow-ups to be filed (see *Follow-ups*).
**Prod:** unaffected (`3997aa2a`). No code, migrations, or shape edits accompany this doc.

## The situation

EFB-18 opens: *"Right now every board member is added one at a time via invite. Doesn't scale for a real org."*

**That premise is half wrong, and the half that's wrong is load-bearing.** Bulk grant already exists. Every org member already has contributor on every board in the org, unconditionally, with no invite and no checkbox.

Two files carry it, both worth opening rather than taking on trust here:

- `boardRoleFromOrgRole` (`src/authz.ts:137-142`) projects org roles onto boards — owner→owner, admin→admin, member→contributor — and `effectiveBoardRole` (`authz.ts:155-171`) returns the **strongest** of that projection, the caller's explicit `boardMemberCache` row, a public viewer floor, and a legacy creator fallback. The module header says so outright (`authz.ts:3-8`); `tests/orgs.test.ts:378` pins it.
- `boardMemberPubkeys` (`src/audiences.ts:75-90`) unions `boardMemberCache` with *every row of `orgMemberCache` for the board's org* — so the crypto layer independently reaches the same roster, and every org member already holds a private-board key grant.

Nothing in the UI says this, which is why the ticket didn't notice. What EFB-18 actually names is **subsetting**, in two forms that should not share a ticket:

- **Gap 1 — additive.** Grant to *some* org members rather than all. Genuinely absent; this is the ticket's real request.
- **Gap 2 — restrictive.** Make a board *narrower* than its org. Also absent, and differently shaped: `strongest()` (`authz.ts:144-149`) is a floor nothing can lower, so a `visibility:"private"` board inside a shared org is readable **and writable** by every org member. That violates the `private` contract rather than merely lacking a feature — filed separately.

## The constraint that shapes every option

Before A/B/C, one fork binds: **is a group a substrate object or a D1-authoritative one?**

`migrations/README.md` is explicit: canonical state lives in signed 4a events, and the `*Cache` tables are projections that "can be truncated and rebuilt from 4a at any time." Only a named handful — `sessionCache`, the webhook families, `issueImports` — have D1 as source of truth, each an exception the README justifies.

A group is therefore either a **substrate object** (a signed declaration with `groupCache` as a rebuildable projection — consistent with every other first-class noun, costs a wire-shape decision) or **the sixth D1-authoritative exception** (simpler, but a cache truncation silently drops access grants). Grants are already substrate-published: `upsertMembership` (`src/membership.ts:73-102`) publishes a kind-30521 grant addressed to `<org_slug>` or `<org_slug>/<board_slug>`, so a group-scoped grant needs a third addressing form either way.

A naming hazard sits on top. `orgCache.kind` already takes `'personal' | 'team'`, and `'team'` is live vocabulary: every org created at `/o/new` is `kind:"team"` (`src/routes/orgs.ts:206,221`), badged "· team" in the UI (`web/src/pages/HandlePage.tsx:204`). No group entity exists today, so the word is available only by taking it from the org-vs-personal distinction. **Naming the new object Groups** avoids the collision for one word's cost; renaming the org kind is substrate-visible (`src/shapes.ts:598`) and touches a CHECK constraint D1 can only widen by ADD COLUMN.

## The cost that shapes the answer

One number should drive this more than any UI question.

`rotateBoardAudience` (`src/audiences.ts:373-456`) runs when a member is removed from a private board. It bumps the epoch, revokes **every** grant on the board — not just the departing member's (`:389-392`) — and re-issues for each remaining member, one row per member **per live device** per epoch (`issueGrantsForMember` :175, `liveSessionPubkeys` :93). It is deliberately **not** best-effort: `src/routes/orgs.ts:77-84` requires that "the epoch bump must land before the roster shrinks; failures abort the removal."

So removing one person from a group applied to six private boards costs six epoch bumps × remaining members × devices, all of which must succeed or the removal fails. **Every decision about *when* to bump the epoch is a hidden performance and availability decision.**

The asymmetry that follows drives the recommendation: **additive** grants only add rows and never rotate; **restrictive** scoping is where the entire epoch cost lands.

## The three directions

**Option A — named Groups (additive subsetting).** The only genuinely new object, and the ticket's real request. Closes Gap 1; composes with existing precedence, since a group-derived role becomes one more argument to `strongest()` rather than a new rule; triggers no rotation. Costs the substrate-vs-D1 fork, a new grant addressing form, and a UI surface. **Lift: medium.**

**Option B — default org team.** Already shipped as `boardRoleFromOrgRole`; nothing in the UI exposes it, which is why the ticket describes it as missing. Building it as a *team* re-implements working behavior. The only live choice inside B is whether to add opt-**out** — Gap 2 in a team costume, carrying all of its risk and all of the epoch cost above. **Lift: near-zero to surface; large to make optional.**

**Option C — per-board access mode.** Today's world is already "private + team + org-wide" collapsed into "public + private-that's-actually-org-wide," so C is really about making the *restrict* case possible — Gap 2 does its load-bearing work, and the `team` tier additionally needs A. Its audit stamp also reverses the current design: org-derived access writes no `boardMemberCache` row, so "the row still exists, stamped via team X" means materializing rows the system deliberately derives live. **Lift: large, gated on both A and Gap 2.**

## The five open questions

**Persist group-member rows, or derive live?** The codebase already answered the analogous case: org-derived access is rowless, derived per call. *Lean: derive*, with audit provenance in a separate append-only trail rather than a mutable membership row.

**Key grants at group scope: per-member, or group-shared with per-member wrap?** Settled by the cost section. A shared key reduces wrap count but relocates rotation, and honest revocation still rotates something. *Lean: per-member for v1* — additive-only groups never rotate, so this turns urgent only alongside Gap 2.

**Role precedence — contributor via group A, admin via group B?** Already solved: `ROLE_RANK` (`src/roles.ts:19-25`) is one ladder across both scopes and `strongest()` reduces over it. *Lean: strongest-wins, by reuse* — answering differently would make groups the only subsystem with its own precedence rule.

**UI: `/orgs/:slug/teams` or fold into Members?** The proposed URL doesn't fit the namespace: the web shape is `/@handle/*` (`web/src/App.tsx:60-63`), with no `/orgs/:slug` family. And `/:handle/members` registers before the `/:handle/:board_slug` catch-all with **no reserved-child-slug list in `src/`**, so a board slugged "members" is already shadowed and `/:handle/teams` would mint a second trap. *Lean: fold into `OrgMembers` as a tab.*

**Default team implicit-unrenamable, or real and editable?** Largely moot — the default team is the org, already implicit and unrenamable. The live question is whether it can be *disabled*, which is Gap 2. *Lean: leave implicit.*

## Recommendation

**Option A, named Groups, scoped to additive grants only.**

B is already shipped and C is gated on Gap 2, so A is the only direction that adds capability rather than renaming or reversing what exists. Constraining v1 to *additive* grants — groups may raise a member's role, never lower the org floor — keeps the change monotonic: no board that works today changes behavior, `strongest()` gains an argument instead of an exception, and no epoch rotates.

That leaves Gap 2 unsolved deliberately. Lowering the floor changes access on boards that already exist, is where the rotation cost lives, and starts with Evan naming what `private` ought to mean inside a shared org. Shipping A first also makes C cheap later, since C's `team` tier is A's grant surface relabelled.

A recommendation, not a verdict — and the case for doing nothing until a real org actually hits Gap 1 is stronger than it looks, given org-wide sharing already works.

## What implementation would look like

**Option A.** A `groupCache` + `groupMemberCache` pair plus a `groupBoardGrant` join, in `migrations/0027_*.sql` — forward-only, `IF NOT EXISTS`, **no FKs** (`0001_init.sql:14-19`: D1 cannot rebuild a populated FK-referenced parent), identity columns in canonical `<provider>:<id>` form (`0023_identity_ref_normalize.sql`). `src/authz.ts` gains one query in `effectiveBoardRole` and one argument to `strongest()`; `src/roles.ts` needs no new vocabulary. `src/membership.ts` grows a group branch on `upsertMembership`'s `GrantTarget`, and `audiences.ts:75-90` must union group members into `boardMemberPubkeys` or private boards will authorize members they cannot decrypt for. **Two traps:** `isRosterMember` (`src/lib/identity.ts:57-68`) deliberately bypasses `effectiveBoardRole`, so group-derived members silently fail assignee validation until it is taught about groups; and new membership SQL must be added to `tests/dbMock.ts` or unit tests won't see it. Routes follow `docs/BOUNDARY_DISCIPLINE.md`; UI is a tab in `web/src/pages/OrgMembers.tsx`. D1 impact: one extra indexed read per board authorization.

**Option B.** Surfacing existing behavior is UI-only — a line in `BoardSettings`, no migration. The opt-out variant needs a `boardCache.org_access` column (ADD COLUMN), a change to `boardRoleFromOrgRole`'s unconditional projection, a default preserving current access on every existing private board, and the full rotation cost per toggle.

**Option C.** A `boardCache.access_mode` column backfilled to `org-wide`, all of Option A beneath it, Gap 2 resolved first, and the audit-stamp question settled — either materialized `boardMemberCache` rows with a `via` column, reversing today's derive-live design, or a separate append-only audit table.

## Follow-ups

Both found while writing this doc; both to be filed as their own tickets, neither fixed here.

1. **`visibility:"private"` boards inside shared orgs are org-readable/writable** — `strongest()` (`authz.ts:144-149`) is a floor that cannot be lowered. Shaped like a security defect rather than a design question; wants a security read-through and a prod probe (post an issue to a private board as an org member holding no `boardMemberCache` row — expect 200 where 403 is intended).
2. **Reserved-handle-child list is missing** — `/:handle/members` (and any future `/:handle/teams`) silently shadows a board of that slug. `RESERVED_ORG_SLUGS` (`src/roles.ts:39-59`) guards org slugs only; no board-slug equivalent exists.

## Revisit when

- A real org hits Gap 1 — someone needs to share with *part* of the org. Until then A's cost is real and its benefit hypothetical.
- Gap 2 gets its semantics named. That decision, not this one, unlocks C.
- `rotateBoardAudience` shows up in latency or D1 write volume. Measurement settles the key-grant question better than argument.
