# EFB-57 — Private-board attachments: document the current behavior (Option 1)

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-57`

## Scope one-liner

Ship **Option 1** from the ticket body: UI copy + docs + a decision doc naming the tradeoffs of Options 2-5. Ready for future EFB-57.5 if/when we want to encrypt at the blob layer.

**NOT implementing** server-side encrypt, content-addressed key derivation, signed-URL layer, or public-only restriction. Those are bigger design conversations worth having later.

## Motivation (from ticket)

Discovered during EFB-49 integration test: `blob_url` on attachments is a Blossom content-addressed public URL. `visibility: 'private'` on the board does NOT extend to attachment blobs. Anyone with the URL (or who hashes the same file) can read the blob regardless of board membership. Not a bug — a deliberate design property of BUD-01/02 storage. But surprising to users who read "private board" as "private everything."

Immediate need: honesty in the UI so no user is surprised. Bigger fix (encrypt-at-blob) is a followup.

## Approach

### 1. UI copy (attachment upload dialog)

On the attachment upload dialog for a private board, add a subtle-but-visible warning:

> **Note:** Attachments are stored at content-addressed public URLs. Anyone who has the URL can read the file, regardless of board privacy. This is a property of decentralized storage — see [docs](/docs/attachment-privacy).

Copy tone: informational, not alarming. Users need to make an informed choice, not panic.

**Only show on private boards.** Public boards don't need the warning — anyone can access the board anyway.

### 2. Docs page: `docs/attachment-privacy.md`

Structure:
- **What "private board" means today** — read-access to issues/comments/sprints is gated on membership. Attachments are NOT gated at the blob layer.
- **Why** — Blossom's content-addressing model (BUD-01/02) is the substrate; content-hash URLs are immutable and public by design. Trade-off between decentralized-storage benefits (dedup, portable, verifiable) and traditional-privacy semantics.
- **What this means practically** — anyone with the URL can access. If you upload a sensitive file, treat the URL as sensitive.
- **What we might do about it later** — brief mention of the four options in the ticket (encrypt-server-side, key-derived, signed-URL, public-only), no commitments.
- **What YOU can do today** — don't upload sensitive files to private-board attachments. Use email or a purpose-built storage for genuinely-private files.

### 3. Decision doc: `docs/decisions/2026-07-attachment-privacy.md`

Ready-to-hand doc naming the four upgrade options + their tradeoffs, so when we come back to this we don't re-derive:

- **Option 2 — server-side encrypt-to-audience-key.** Preserves visibility=private semantics. Breaks BYO-Blossom-host (blob stored encrypted; host can't serve it directly; needs proxy layer). Big lift.
- **Option 3 — content-addressed key derivation.** Same content on public + private boards hashes to different blobs. Breaks Blossom's content-addressing benefit. Complex.
- **Option 4 — signed-URL layer.** Cloudflare Worker between client + Blossom; requires per-request signed URL; auth against membership. Preserves Blossom-native storage; adds auth boundary. Medium lift.
- **Option 5 — public boards only.** Simplest, most restrictive. Kills the feature on private boards.

Doc names each option's blast radius, dev cost, and use-case impact. Not a commitment; a memory-in-repo so the next design pass starts warm.

## Load-bearing surprises

1. **No code change to the attachment upload path.** Copy addition is UI-only.
2. **No change to the underlying Blossom integration.** `src/effects/Blossom.ts` stays untouched.
3. **EFB-49 already pins the observed shape** — the integration test asserts URL is public + content-addressed + immutable. If any future change silently shifts to presigned URLs, EFB-49's test fails and forces the design conversation. That's the ratchet already in place.
4. **The UI copy is user-facing text — needs Evan's tone review.** DM me the exact copy draft before merging. Standing rule: no user-facing copy without Evan's voice check.

## Files to touch

| File | Change |
|---|---|
| `web/src/components/AttachmentUploadSection.tsx` (or wherever the upload dialog is) | Add conditional warning on private boards. |
| `docs/attachment-privacy.md` (new) | User-facing explainer. |
| `docs/decisions/2026-07-attachment-privacy.md` (new) | Internal decision-record naming Options 2-5 tradeoffs. |
| Link the docs page from README or wherever attachment docs are indexed. |

## Non-goals

- No implementation of Options 2-5
- No changes to Blossom.ts
- No changes to attachment schema

## Testing

- UI: private board upload → warning visible; public board upload → no warning; toggle board private→public updates state
- Docs render correctly

## Deploy context

- Prod evenflow at `e05819a5` (post-EFB-58)
- Standard evenflow deploy
- No D1 changes

## Coordination points — DM me before

- **The exact UI copy text — DM Sona for Evan's voice review before merging.** Standing rule.
- If the AttachmentUploadSection.tsx path is wrong or the component structure has changed, DM
- Pre-deploy

## DM FLOW — MANDATORY

1. DM Sona (session `session-f4e8ed22897d418a`).
2. Status DMs at meaningful phases: copy draft (for Evan review), docs draft, UI wire, tests.
3. DO NOT `worker_event_complete` until Sona reviewed AND said shipit.

## Checkpoint caveat

Restore by `checkpointId`. State should name "EFB-57 dispatch". If not, DM immediately.

## Standing rules

- No focus rings/outlines on interactive elements
- User-facing copy requires Evan's voice check via Sona
