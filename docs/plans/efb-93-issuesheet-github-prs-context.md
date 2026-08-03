# EFB-93 — IssueSheet surfaces linked GitHub PRs with clickable links

## What & why

Issues carry `github_links` (populated by EFB-66 webhook rules). The ticket detail sheet (`web/src/components/IssueSheet.tsx`) should surface those as clickable rows: PR number + title + state pill (open/merged/closed/draft) + href to github.com. Hide the section entirely if `github_links` is empty (no "no PRs" empty state).

## Files to touch

| File | Change |
| --- | --- |
| `web/src/components/IssueSheet.tsx` | Add a "Linked pull requests" section. Renders rows from `issue.github_links`. Hide when empty. |
| Related test file (`web/src/components/*.test.tsx` — look for existing IssueSheet tests) | Add a test: mocked issue with 2 github_links renders 2 rows with hrefs and pills; issue with none has no section at all. |

## Load-bearing surprises

- **`github_links` schema.** Grep `git grep -n 'github_links' src/` to see the exact shape the backend serves (open vs merged vs closed vs draft; number/title/url). Match the render to the actual shape — don't invent fields.
- **State pill styling** — the EFB-98 world has an existing `external_state` pill on issue cards (from EFB-66). Reuse that component or its styles; DO NOT create a new "PR state pill" component if one already exists. Grep first.
- **Standing rule: NO focus outlines / focus rings on any interactive element.** Do NOT add `focus:ring-*`, `focus-visible:ring-*`, `focus:outline-*`, `focus-visible:outline-*` classes. If existing IssueSheet has them, do not propagate them.
- **`target="_blank"` + `rel="noopener noreferrer"`** on the anchor — user clicks a github PR, opens in a new tab.
- **IssueSheet style baseline.** Match existing rows / list items in the sheet. No new component-library patterns; use whatever is already imported.

## Testing

- Falsification: seed an issue with one github_link, render, click. Verify href = github.com/... and opens in new tab.
- Empty state: issue with `github_links = null` or `[]` — section is NOT rendered (no header, no empty message).
- Existing IssueSheet tests still pass.
- `cd web && npm test && npm run build`.

## UI verification

- Test locally: `cd web && npm run dev`. Load a private issue that has a linked PR (create one via github webhook if needed).
- Screenshot at 1440px width. DM the screenshot along with your review request.

## Deploy context

- Frontend-only change. Coordinator deploys after review.
- Base: fresh worktree off `origin/main` (`be8caa4`).

## Key IDs

- Ticket: `EFB-93`
- Session: `session-f4e8ed22897d418a`
- Board slug: `evan-s-flow-board`

## Related work

- **EFB-66** — GitHub webhook rules that populate `github_links`.
- **EFB-98** — the manifest refactor (no route changes here since this is pure frontend, but if you touch backend to add a serializer field, `docs/API.md` is the reference).

## Coordination

- DM your brief-read + your read of the current IssueSheet.tsx shape BEFORE writing code.
- DM the screenshot when you're ready for review.
- **No focus rings.** No follow-up tickets (Evan's law).
