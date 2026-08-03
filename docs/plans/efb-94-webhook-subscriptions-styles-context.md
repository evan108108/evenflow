# EFB-94 — Webhook subscriptions UI missing default field + button styles

## What & why

On `/@evan108108/evan-s-flow-board/settings` the **Webhook subscriptions** section renders form fields and buttons WITHOUT the app default styles. Adjacent sections (Board defaults, GitHub, Blossom, etc.) look styled correctly. Cause is missing/incorrect className application. Fix: match the adjacent sections' style approach.

## Files to touch

| File | Change |
| --- | --- |
| `web/src/pages/BoardSettings.tsx` or `web/src/components/*Settings*.tsx` (grep for "Webhook subscriptions" string) | Fix field/button className to match adjacent sections. |

**Locate the component first.** `cd /Users/evan/projects/evenflow && git grep -n 'Webhook subscriptions' web/src/` will pinpoint the file(s).

## Load-bearing surprises

- **Style-token approach differs across sections.** Some Settings sections use shared components (`<Field>`, `<Button>`); others use utility-class strings inline. First read a nearby WORKING section (Board defaults, GitHub, Blossom) and see the pattern. Then:
  - If shared components exist → import + use them.
  - If utility-class strings → copy the class string patterns exactly.
- **Evan's law applies.** If you find the class strings are duplicated 3+ times across sections without a helper, extract a small inline `FieldRow` / `Button` helper right here in the fix. Do NOT file a "refactor to helper" follow-up ticket. The refactor IS the fix.
- **NO focus outlines / focus rings — standing hard rule.** Do NOT add `focus:ring-*`, `focus-visible:ring-*`, `focus:outline-*` classes. If existing adjacent sections have them, DO NOT propagate them into the webhook section (and if you're touching the file, consider whether to strip them from siblings — DM me before you do).
- **Tab-order preservation.** After the style fix, tab through the section — order must still be sensible.

## Testing

- Load `/@evan108108/evan-s-flow-board/settings` locally (`cd web && npm run dev`) — the Webhook subscriptions fields/buttons should look identical to adjacent sections.
- Tab through the section — verify tab order.
- Screenshot before/after at 1440px width. DM both.
- `cd web && npm test && npm run build`.

## Deploy context

- Frontend-only. Coordinator deploys.
- Base: fresh worktree off `origin/main` (`be8caa4`).

## Key IDs

- Ticket: `EFB-94`
- Session: `session-f4e8ed22897d418a`
- Board slug: `evan-s-flow-board`
- Settings URL: `/@evan108108/evan-s-flow-board/settings`

## Related work

- **EFB-13** (parent) — Outbound webhook subscriptions feature.
- Adjacent sections to visually match: Board defaults, GitHub, Blossom.

## Coordination

- DM your brief-read + before/after screenshot before completing.
- If the fix requires extracting a helper, do it inline. No follow-up tickets.
- **No focus rings.**
