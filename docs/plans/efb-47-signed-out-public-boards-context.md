# EFB-47 — Public boards viewable when signed out

Ticket body: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-47`

## Scope one-liner

Remove the unconditional-redirect for null-JWT visitors on public boards. Signed-out visitors should see a read-only board view; only private boards should redirect. Discovered during EFB-44 phase 6 browser verification.

## Load-bearing surprises

1. **The exact code path is `BoardPage.onMount`** — it redirects to `/` whenever the JWT is null. Unconditional, no `visibility === 'public'` exemption. The API already serves signed-out viewers fine (`role: 'viewer'`, issues endpoint returns 200 with no auth), so the SPA is silently violating a promise the substrate architecture (EFB-24) already delivers on.

2. **The board fetch happens BEFORE we know visibility.** If the redirect check needs `board.visibility`, it has to happen after the board loads. Two shapes:
   - (a) Fetch first, then decide: `if (jwt null AND board.visibility === 'private') redirect` — needs unauthenticated GET /boards to work for public boards (probably already does — verify)
   - (b) Peek visibility from URL/short-id resolution and short-circuit early — no unauth board fetch needed but more complex

Lean: (a) if the unauth board GET already works, cleaner code path.

3. **Read-only mode implications are the meat.** Once signed-out viewers land on the board, many affordances must be hidden or disabled:
   - New-issue button
   - New-sprint button
   - Assignee dropdown on IssueSheet (or disable + show read-only assignee)
   - Delete-from-sheet button (EFB-26)
   - Sprint chip filter (Phase 21c — can filter, no auth needed to read)
   - "Show my tickets" filter chip (EFB-44 already handles this correctly via `<Show when={callerPubkey() !== null}>`)
   - Comment composer (comments read-only or hidden entirely)
   - Drag-and-drop reordering
   - Column-add / column-edit
   - Board settings link

Grep for `callerPubkey`, `claims`, `jwt`, `contributor` in `web/` — anywhere the code branches on "signed in" vs "signed out" is a candidate for read-only-mode gating.

4. **The `assignee_pubkey === null` case from EFB-37 matters here.** EFB-37 shipped placeholder chips for unassigned issues. Signed-out viewer sees those placeholders correctly (no auth needed for render). Good — one less special case.

5. **Public URLs use `/@handle/board-slug`** — same URL scheme signed-in and signed-out. No new route needed.

## Files to touch

| File | Change |
|---|---|
| `web/src/pages/board/BoardPage.tsx` | `onMount` redirect: only if JWT null AND board.visibility === 'private' |
| `web/src/components/IssueSheet.tsx` | Gate mutation affordances behind viewer-authenticated check |
| `web/src/components/*` (multiple) | Same gating for new-issue, new-sprint, drag handles, column controls, comment composer |
| `web/src/pages/board/BoardHeader.tsx` (or wherever settings link lives) | Hide board settings link when signed out |
| Tests | Add signed-out variant tests: viewer sees board, sees issues, sees placeholders, does NOT see mutation controls |

## Where things live

- `callerPubkey()` in `BoardPage.tsx:56`, set from `pubkeyOfJwt(jwt)` at :212
- API auth model: `role: 'viewer'` for anonymous public-board reads; `role: 'contributor'` gates mutations
- EFB-44's `<Show when={callerPubkey() !== null}>` is the model gate for viewer-authenticated affordances

## Testing

- Signed-out viewer on public board: renders full board, no mutation controls visible, comment composer hidden or read-only
- Signed-out viewer on private board: STILL redirects to `/`
- Signed-in viewer: no regression, all affordances present as before
- Signed-out viewer on Kanban view + Backlog view + Icebox view: all read-only, no glitches
- Verify with tide-test-public (public) and evan-s-flow-board (private). EFB-29 hang on tide-test-public may complicate — if the board doesn't load at all, this ticket doesn't test cleanly. Fallback: use another public board or wait for EFB-29 fix.

## Deploy context

- Prod evenflow at v `625e962c` (EFB-44 just shipped).
- No backend changes → no D1 migration. `wrangler deploy` after web build.
- Auth via `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` (personal-account Cloudflare per hard rule).

## Key IDs

- Board: `4042afb7-d1fe-4a80-a311-9de404b0ee14` (private test surface)
- Public board: `97d96cac-85cb-4eec-b974-e92b59da2c78` (tide-test-public) — may have EFB-29 hang
- Sona pubkey: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login`
- API key: `mem_secret_get evenflow_apikey`

## Related

- EFB-44 (shipped): browser verification surfaced this. Filter chip already handles the null-viewer case defensively.
- EFB-24 (shipped): substrate-native public boards; SPA behavior undermines the architectural promise
- EFB-37 (shipped): unassigned placeholder chips work signed-out; no rework needed

## Coordination points — DM me before

- If read-only mode surface is bigger than expected (>5 affordances to gate) — I want to see the list before you widen scope
- Any change to auth flow itself — sign-in redirect logic, JWT expiry handling. Different ticket.
- If unauth board GET DOESN'T work for public boards, that's a backend gap that changes the plan.

## DM FLOW — MANDATORY

1. **DM Sona (session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4`)** with questions.
2. Sona is AFK — replies via channel notifications, may lag.
3. Status DMs at meaningful phases: after audit-of-affordances, after redirect fix, after read-only gating, before deploy.
4. **DO NOT `worker_event_complete` until Sona reviewed AND said shipit.**
5. Use `dm_send` targeting session `f4e8ed22-897d-418a-a96d-1ebe6fa340e4` or `dm_reply`.

## Checkpoint caveat

Multiple parallel dispatches from Sona's session may cause checkpoint clobber (documented in EFB-48). VERIFY YOUR CHECKPOINT BY CONTENT before proceeding. State should say "EFB-47 dispatch". If it says something else, restore-by-content-verification from the brief committed on origin/main is your fallback. Same trap the EFB-44 worker caught.

## Standing rules

- NO deploy without approval.
- PR target: `main`.
- Frontend + minimal-backend only. Do NOT modify substrate or migrations.
- Pre-existing tsc baseline: 2 root + 1 web (SprintArchive:94) as of EFB-44 merge.
