# EFB-67 — Mobile board header (compact vertical space)

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-67`

## Scope one-liner

On mobile the board-page header lays out at desktop density and overflows the viewport horizontally. Users have to page-scroll horizontally to reach action buttons and filter chips. Nothing broken, pure visibility+usability. Ship a mobile-specific header design that stacks vertically and sheds density below a breakpoint.

## Evan's ask (verbatim)

> "On Mobile the header gets messy and cut off (everything works fine this is pure visibility and usability issue). We should perhaps have a mobile specific header that is designed for the compact vertical space."

## Attachments — READ FIRST

Two mobile screenshots via AgentMail. `mcp__agentmail__get_attachment` with:
- inboxId: `sona@agentmail.to`
- threadId: `dc766fb6-aa8d-477f-9721-051b0a75e648`
- attachmentIds:
  - `6b6cb8a2-73a8-4c0e-85e3-40f8b8ea3d39` — `1000021592.jpg` — page horizontally scrolled, shows overflow
  - `7f7f1d18-641a-4dc0-a429-34f94979492e` — `1000021590.jpg` — natural mobile viewport, crammed layout

## What the screenshots show

**Screenshot 2 (natural viewport):**
- Row 1: Evenflow logo | breadcrumb (Boards / @evan108108 / Evan's Flow Board) | user avatar — WRAPS awkwardly, breadcrumb hits avatar
- Row 2: Large "Evan's Flow Board" title
- Row 3: EFB tag | Sprints button (right-aligned) — space between wasted
- Row 4: Settings | + New Issue (full width)
- Row 5: Kanban | Backlog | Icebox | Sprint 1 · 6d remaining — LAST tab cuts off at right edge
- Row 6: Show my tickets | Assignee | Label filter chips
- Row 7: Todo column starts

**Screenshot 1 (horizontally scrolled):**
- Sees the parts that were cut: user avatar centered oddly, board title in isolation, action buttons scattered at wide-viewport positions. Layout expects ~1024px+ and doesn't collapse.

## Mobile-specific header design (approved leans)

Below breakpoint 768px:

1. **Compact top strip** — Evenflow logo (small) left, user avatar right. Full width, single row, nothing else.
2. **Breadcrumb** — truncate middle: `Boards / … / Evan's Flow Board`. Board name may wrap to 2 lines.
3. **Board title** — reduce ~48pt → ~28pt on mobile.
4. **Action row** — `+ New Issue` (primary, full-width or 2/3-width); `Settings` becomes gear icon (no label); `Sprints` becomes icon button.
5. **View tabs (Kanban/Backlog/Icebox/Sprint 1)** — `overflow-x: auto` INSIDE the tab row. User sees Kanban selected + partial next, swipe-horizontal within the row (not the page).
6. **Filter chips (Show my/Assignee/Label)** — same treatment: horizontal-scroll-inside-row.
7. **Complete sprint** — hides on mobile behind Sprints icon menu OR `⋯` overflow menu. Not primary enough to earn vertical space on small screens.

## Load-bearing surprises

1. **Test on real mobile viewport OR DevTools emulator at 375×812, 393×873, 428×926 minimum.** Emulator lies about touch but fine for layout.
2. **The Kanban columns already scroll horizontally** — do NOT accidentally break that by adding a competing horizontal-scroll context in the header. Two scoped contexts on one page must be scoped to their respective containers.
3. **Existing mobile default IS the Linear-style vertical Kanban** (Phase 79 shipped). This ticket ADDS to that — HEADER collapse, not column layout change.
4. **No focus rings/outlines** on interactive elements (standing rule).
5. **Icon buttons need aria-labels** for accessibility — the visible label goes away, the semantic label stays. Settings → `aria-label="Board settings"`; Sprints → `aria-label="Sprint controls"`.

## Files to touch (educated guess — grep to confirm)

- `web/src/pages/board/BoardPage.tsx` — where the board header renders
- `web/src/components/BoardHeader.tsx` (or similar) — layout probably lives here
- CSS: whichever pattern this repo uses (component-scoped, module, or `board.css`) — media queries at 768px

If a distinct `MobileBoardHeader` component reads cleaner than media-query-conditional rendering, worker's call. Solid supports both patterns.

## Testing

- Real mobile browser or DevTools at 375, 393, 428: assert header fits WITHOUT horizontal page scroll
- Assert `+ New Issue` remains primary CTA (visible without scroll or menu)
- Assert view tabs reachable via horizontal-swipe-WITHIN-tab-row (not page-scroll)
- Assert filter chips same
- Desktop viewport (≥1024px): header UNCHANGED — pin the desktop layout in a snapshot or explicit-width test to catch regression
- Landscape mobile (~800px wide): probably stays with mobile treatment since vertical space is compressed there too

## Non-goals

- Not redesigning desktop header
- Not adding an app-wide hamburger menu (this is board-header only)
- Not changing Kanban column layout (Phase 79 already made it Linear-style vertical on mobile)
- Not touching sprint filter chip logic (EFB-45's territory)

## Related

- Phase 79 (shipped): Linear-style vertical Kanban view + mobile default — completes the mobile story that Phase 79 left desktop-header-shaped
- EFB-44 (shipped): Board view filters — the filter chips row
- EFB-45 (shipped): Unify sprint filter — the Sprint 1 tab shape

## Deploy context

- Prod evenflow at `30d455af` (post-EFB-56)
- No D1 changes
- Standard evenflow deploy per hard rule
- **Web bundle change** — SPA cache eviction matters, wait a couple minutes before render check on real device

## Key IDs

- Board (smoke): `4042afb7-d1fe-4a80-a311-9de404b0ee14` (@evan108108/evan-s-flow-board)
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login` (via MCP, NOT the CLI)

## Coordination points — DM me before

- Breakpoint choice if you find the codebase uses something different from 768
- If `+ New Issue` needs a different mobile shape (worker's judgement, but DM if you're diverging from the brief)
- Any accessibility trade-off you're not sure about
- Pre-deploy always

## DM FLOW — MANDATORY

1. DM Sona (session `session-f4e8ed22897d418a`).
2. Status DMs at meaningful phases: post-brief-read (with grep of current header structure), design skeleton, wire, tests, pre-deploy.
3. DO NOT `worker_event_complete` until Sona reviewed AND said shipit.

## Standing rules

- No focus rings/outlines
- User-facing copy stays as-is (no new strings needed)
- Baseline: 2 root + 1 web pre-existing tsc errors
- Work in your OWN worktree per today's shared-checkout discipline (git worktree add ../evenflow-efb-67 -b efb-67-mobile-header)
- Do NOT run git checkout/pull/reset/merge in the shared checkout
