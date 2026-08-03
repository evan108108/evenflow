# EFB-67 v2 — Mobile board header (separate component + media query, per Evan)

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-67`

## What happened before

v1 shipped as `c2e361f` (deploy `dab4742c`), was rolled back to `f03ebcc3` after Evan verified on his real phone that the header was WORSE than pre-fix. Screenshot showed breadcrumb wrapping to 4 lines, `+ New issue` rendered as a huge full-height button, sprint tab still clipping. v1 used a shared JSX tree + JS-class-based approach with `flex-wrap: wrap` and scoped CSS under `.board-page.mobile`. Reached the DOM correctly but produced a broken layout at real mobile viewports.

**Both v1's PR body and DM to me flagged the ceiling honestly** ("mechanism verified, not outcome verified"). I approved on mechanism evidence anyway. That's on me. The rollback isn't a judgment on v1's worker; it's a design pivot Evan directed after seeing the real output.

## THE LOAD-BEARING FINDING FROM v1's WORKER (added post-completion DM)

Worker-1's held-state checkpoint from v1 listed likely failure suspects in ranked order **before shipping**. The top entry was: *"the breadcrumb row above `.board-header` is NOT styled by this ticket (separate component above the header) — could still overflow."*

**The four-line breadcrumb wrap Evan saw comes from a component ABOVE `.board-header`, not from the header itself.** A header-only redesign — even done correctly with Evan's separate-component + media-query approach — will still leave that overflow if you don't ALSO fix the breadcrumb component. This is the most important thing in this brief.

**First thing you do**: grep for the breadcrumb — likely in `web/src/components/board/` or similar — find the component that renders `Boards / @evan108108 / Evan's Flow Board` above the header. That component's mobile layout is IN SCOPE for this ticket, not out of it. If it's a single shared component with no mobile variant, decide: give it its own mobile mode via media query, OR truncate/collapse it on mobile (probably: `Boards / … / Evan's Flow Board` middle-elision, one line, no wrap).

## Evan's directive (verbatim)

> "The header issue on mobile. Just create a new mobile only header that uses media call to choose the header."

## Scope

Ship a **separate `MobileBoardHeader` component** + **CSS media query** that renders `MobileBoardHeader` below the mobile threshold and the existing desktop header above it. This is different from v1 — v1 explicitly avoided a separate component to keep signed-out/read-only conditions (from EFB-47) in one place. Evan has weighed that tradeoff and chosen the separate-component path anyway. Don't try to talk him out of it; **implement his design**.

## Required approach — non-negotiable

- **Two components**: keep the existing `BoardHeader` (desktop) untouched; add `MobileBoardHeader` (new file, `web/src/components/board/MobileBoardHeader.tsx` or wherever fits the repo convention)
- **CSS media query decides which renders** — NOT a JS-based class swap. Use `@media (max-width: 768px)` (or the codebase's existing mobile-breakpoint variable if there is one — grep for it first)
- **BOTH components render** in the JSX tree; CSS `display: none` hides the one not matching the viewport. That way no runtime JS decision, no flicker, no window-resize listener needed
- **Reuse EFB-47's signed-out / read-only logic in both components** — accept a bit of duplication rather than a shared tree; that's the cost Evan is willing to pay for clean separation

## Design for MobileBoardHeader (the actual layout)

Look at the screenshot of the broken v1 render in the AgentMail attachments (thread `dc766fb6-aa8d-477f-9721-051b0a75e648`, message `<CAG+abp5ZrKsvq1XSS3_cBFC01mevNn052pwTz-YJTYcv-B-ZAQ@mail.gmail.com>`, attachment id `6528ebad-50a5-4f38-9f3f-d4bd62288960`). What went wrong:
1. Breadcrumb wraps to 4 lines because it's inside a flex container that got squeezed by avatar
2. `+ New issue` button is oversized because `flex: 1 1 auto` on `.btn-solid` gave it all remaining space in a wrapped row
3. Logo + breadcrumb + avatar together consume too much vertical space

Target layout for `MobileBoardHeader`:

```
Row 1 (compact top strip, single line, always fits):
  [logo-icon] [board-name (truncate)]                  [avatar]

Row 2 (title, if you keep one — Evan can live without it since Row 1 has the name):
  [Board title, ~24pt, one line, truncate]

Row 3 (actions row):
  [+ New Issue]  [Settings icon]  [Sprints icon]  [Complete-sprint icon or hidden]

Row 4 (view tabs, horizontal-scroll-inside-row):
  [Kanban] [Backlog] [Icebox] [Sprint 1]  ← scroll

Row 5 (filter chips, horizontal-scroll-inside-row):
  [Show my tickets] [Assignee] [Label]  ← scroll
```

Key differences from v1:
- **Drop the breadcrumb entirely on mobile.** The board name is in Row 1, the URL is in the address bar, the user knows where they are. Breadcrumb on mobile is pure clutter.
- **Board title is optional** — if you keep it, one line, truncate; if you drop it, Row 1 carries the name.
- **`+ New Issue` is a normal-size button**, NOT the flex-grow full-width thing v1 shipped. Icon + label, sized to content, sits next to the two icon buttons.
- **Icon buttons stay `sr-only`-labeled** for accessibility (v1 got this right; keep the pattern).
- **Kanban columns already scroll horizontally on desktop; mobile is vertical (Phase 79)** — so no double-scroll-context risk. But keep tabs/chips scoped `overflow-x: auto` on the ROW not the page.

## What to touch

| File | Change |
|---|---|
| `web/src/components/board/MobileBoardHeader.tsx` (new) | Full component, mirroring signed-out/read-only conditionals from BoardHeader |
| `web/src/pages/board/BoardPage.tsx` | Render BOTH `<BoardHeader />` and `<MobileBoardHeader />`; CSS hides the wrong one |
| `web/src/lib/board.css` | `@media (max-width: 768px) { .board-header-desktop { display: none } }` and `@media (min-width: 768.01px) { .board-header-mobile { display: none } }` |
| **REPLACE** the `.mobile` class binding in `BoardPage.tsx` with a two-component render + CSS media-query gate | Media-query approach per Evan |
| **REMOVE** the `.board-page.mobile` CSS blocks from board.css | Superseded by MobileBoardHeader's own scoped styles |
| **The breadcrumb component (above `.board-header`)** — find it, add mobile treatment | Load-bearing per v1 worker's own postmortem |

### KEEP from v1 (per v1 worker's own report):

- **The `.sr-only` utility CSS class** — didn't exist in codebase before v1; useful regardless of approach; keep it
- **2.75rem tap targets** on icon buttons — good reference value, keep the pattern
- **The scoped `overflow-x` with `flex: 0 0 auto` children** on tabs/chips rows — correct pattern, apply it in MobileBoardHeader
- **Title/spacer sizing values** as reference (~28pt title, spacer:none on mobile) — apply in MobileBoardHeader
- **`lib/layout.ts isMobileHeader()` helper + its 13-width lockstep property test** — orthogonal to the component-vs-media-query question, correct, worth keeping. If you don't use it for choosing header, KEEP it anyway — it's a useful invariant guard. Only remove if it becomes actively dead code after this ticket.

Git-wise: **start from `origin/main` (currently `c2e361f` which has v1)**, work in your own worktree. Rather than a wholesale revert, KEEP the reusable parts named above and REPLACE the choose-with-JS-class mechanism with choose-with-media-query. Two logical commits or one — worker's call, whatever reads cleaner.

## Testing — this ticket does NOT ship without real mobile verification

The v1 lesson: **mechanism-verified is not outcome-verified.** For this ticket, don't merge (or ask for shipit) until at least ONE of:
- A real phone loads the deployed URL and looks right (portrait, 375-428 CSS-px width)
- DevTools or Playwright with true viewport control renders the deployed URL and screenshots look right at 375/393/428 CSS-px

**Emulating viewport via `window.resizeTo` or forcing `innerWidth` does NOT count.** Neither does eyebrowse without a viewport-control primitive. If your environment can't do either of the real checks, DM me and I'll get Evan to do the phone check before shipit.

I know that's a hard bar. It's the bar that v1 didn't meet, which is why we're re-dispatching.

Unit tests (still needed but not sufficient):
- MobileBoardHeader renders under viewport ≤768px
- Desktop BoardHeader renders under viewport ≥769px
- Both maintain signed-out / read-only invariants matching EFB-47
- Desktop layout is unchanged (visual snapshot or explicit-width test)

## Files NOT to touch

- `src/**` — this is web-only
- Anything github or backend
- The two rolled-back-then-re-added CSS lines Evan may have opinions on later — hold on aesthetic decisions until basic layout works

## Deploy

- Prod evenflow: **currently `f03ebcc3`** (post-rollback of EFB-67 v1; still has EFB-66)
- Standard evenflow deploy per hard rule
- No D1 changes
- Standard git-status-before-deploy

## Key IDs

- Board (smoke): `4042afb7-d1fe-4a80-a311-9de404b0ee14`
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login` via MCP
- v1 rollback context: prod was `dab4742c`, rolled back to `f03ebcc3` at 2026-08-01T02:52Z per Evan's phone screenshot

## Related

- EFB-67 v1 (rolled back): `c2e361f` merged, `dab4742c` deployed, `f03ebcc3` rolled back to. Shipped shared-tree + JS-class approach; produced worse layout than pre-fix on real phone.
- EFB-47 (shipped): Signed-out board render — logic MobileBoardHeader must mirror
- Phase 79 (shipped): Linear-style vertical Kanban on mobile — this ticket ONLY changes header, not columns

## Coordination points — DM me before

- **Any deviation from Evan's directive** (separate component + media query). Do NOT re-argue for the shared-tree approach; that debate is closed.
- **If your worktree environment cannot verify at real viewport** — DM me and I will get Evan to check on his phone before shipit
- Pre-deploy always
- Copy strings: `Board settings` and `Sprint controls` sr-only labels from v1 are approved for reuse; anything new needs Evan's voice check

## DM FLOW — MANDATORY

1. DM Sona (session `session-f4e8ed22897d418a`).
2. Status DMs at: post-brief-read (with your read of the current layout code + your plan), post-revert-of-v1, post-new-component-wire, pre-deploy, post-deploy pre-shipit (with viewport verification evidence).
3. DO NOT `worker_event_complete` until Sona reviewed AND said shipit. Real-viewport evidence is a hard prerequisite this time.

## Standing rules

- No focus rings/outlines on interactive elements
- Baseline: 2 root pre-existing, 0 web (post EFB-65)
- Work in your OWN worktree: `git worktree add ../evenflow-efb-67-v2 -b efb-67-v2-mobile-header off origin/main`
- Do NOT run git checkout/pull/reset/merge in the shared checkout
- `mem_secret_get` via MCP for secrets, not CLI
