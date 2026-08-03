# EFB-39 — Homepage: surface the free-tier callouts

Ticket: `https://evenflow.work/api/v0/issues/EFB-39`

## Scope

Add the free-tier framing to `web/src/pages/Landing.tsx`. Ticket body is unusually detailed — read it fully. Evan's core-four + Sona's additions are already listed there. You draft the exact copy strings; Sona reviews for the app's voice; final strings go to Evan for a sign-off before shipping any user-facing text.

## The framing

Evan's line from the ticket body:
> "Everything, at any scale. Free by construction, not by promotion."

That's the load-bearing framing. The inversion is the point — every SaaS "gotcha" (per-seat, per-issue, per-storage-GB, per-API-call, per-integration) is architecturally absent because the metered surfaces don't exist. Not "free for now, will meter later" — free by construction.

## Voice

- Terse. Match the register worker-2 landed for EFB-57 (attachment privacy notice): honest, no corporate hedging, no metaphors that break the frame.
- No metaphors from the nautical/water aesthetic here — this is a marketing-adjacent statement of what the product is; the water imagery belongs on functional UI, not truth-claims.
- Read `web/src/pages/Landing.tsx` for the existing serif-butterfly-wordmark aesthetic. Match its rhythm.

## Structure — from the ticket body

Three bands:
1. **No caps, ever** — unlimited team size, issues, boards, file uploads via BYO S3/Blossom
2. **Full product, not a crippled tier** — sprints/burndown/velocity, public boards, encrypted private, rich comments, cross-board moves, archives, github integration
3. **Developer + AI surface** — API + keys, MCP endpoint, /docs + /evenflow skill, AI-agent invites via pubkey-bound invites (EFB-90)
4. **Identity + data portable** — Nostr / OAuth, substrate-native events, migrate off any time

You may collapse or restructure — but every bullet from the ticket body needs to end up on the page.

## What NOT to include

- **No per-user counts, per-board activity, or anything user-derived** — landing stays signed-out-safe (standing rule)
- No comparison table if it drifts into snark — worth trying, scrap if it doesn't land
- No metering language, no "for now", no "we might" — the whole point is the construction is permanent

## The ONE band you should write copy for first, then DM me before drafting the rest

Draft the SECTION HEADER (candidate: "Everything, at any scale") + the SUBHEAD (Evan's line "Free by construction, not by promotion.") + the FIRST band's copy ("No caps, ever" — 4 bullets). DM me those three pieces before writing the rest. If the voice lands on that band, the rest will follow.

## Testing

- Signed-out visit on desktop + mobile at 375/393/428 + 1024/1440 — copy readable, no user-derived data leaks
- Copy says "unlimited" flat — no routing caveats
- The existing butterfly + serif wordmark identity above your added band is UNTOUCHED
- Playwright screenshots at the three mobile widths + two desktop widths, attached to PR

## Deploy

- Standard evenflow deploy per hard rule
- Prod at `3997aa2a`. No D1 changes.
- Pre-deploy DM to Sona; Sona forwards to Evan for a final voice-check sign-off before merge.

## Coordination — MANDATORY DM points

- Post-brief-read: your read of the existing Landing.tsx voice + structure
- Post-first-band-draft: section header + subhead + "No caps ever" bullets — Sona reviews for voice, then forwards to Evan for sign-off
- Post-full-copy-draft: full page draft, Sona reviews, Sona forwards to Evan
- Pre-deploy always

## Standing rules
- No focus rings/outlines on interactive elements
- User-facing copy requires Evan's voice check via Sona — HARD RULE, do not ship without it
- Own worktree: `git worktree add ../evenflow-efb-39 -b efb-39-homepage-copy off origin/main`
- No shared-checkout git ops
- Session `session-f4e8ed22897d418a`
