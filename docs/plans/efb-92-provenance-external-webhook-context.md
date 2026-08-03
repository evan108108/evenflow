# EFB-92 — 4th ProvenanceSource literal for external-actor webhook attribution

## What & why

`ProvenanceSource` is a closed 3-literal union declared at `src/lib/route-body.ts:245`:
- `"route.caller"` — end-user via HTTP API
- `"user.explicit"` — set via user action tag/UI
- `"audit.system"` — Sonata itself (cron, tombstone, backfill)

EFB-63 landed the github webhook path using `ProvenanceFromStoredActor(actor)` → `audit.system`, byte-identical to pre-EFB-58 behavior. That's an HONEST fit *today* but loses attribution: the PR author who triggered the webhook is a real external human, not "Sonata acted."

This ticket mints a 4th literal (e.g. `"external.webhook"`) to distinguish "Sonata itself acted" from "an external integration acted on behalf of an identified external actor." Generalizes beyond github to future Stripe/Linear/etc.

## Design decisions to make BEFORE coding

1. **Name:** `external.webhook` vs `external.integration` vs `platform.webhook`. Argue on merits, propose one, DM me. I'll ratify or push back.
2. **Shape:** flat literal (`external.webhook`) vs sub-typed (`external.webhook` + `platform: "github" | "stripe" | …`). EFB-63 keeps type shapes lean — argue for flat unless there's a compelling reason.
3. **`ProvenanceFromExternalActor(...)` constructor signature** — sibling to `ProvenanceFromStoredActor`. Params: `platform: string`, `externalId?: string`, `externalHandle?: string`?
4. **BOUNDARY_DISCIPLINE.md rationale** — the closed-union claim needs a written justification for the extension. Draft the paragraph.

## Wire-byte invariant (non-negotiable)

The builder at `src/lib/publish-*.ts` reads only `provenance.pubkey`, NOT `provenance.source`. Adding a literal MUST NOT change wire bytes of any existing published event. Verify by: run the full test suite before your changes, then after — every existing "published wire bytes" fixture snapshot must match. If any snapshot diff, you've unintentionally broadened.

## Files to touch

| File | Change |
| --- | --- |
| `src/lib/route-body.ts` | Extend `ProvenanceSource` Schema.Literal with the new literal. Add `Provenance` sub-type if using sub-fields. |
| `src/actions/github.ts` (~line 169 has ProvenanceSource comment) | Switch webhook callsite from `ProvenanceFromStoredActor` to new `ProvenanceFromExternalActor(...)` returning the new literal. |
| `src/lib/provenance.ts` (if exists) or wherever constructors live | Add `ProvenanceFromExternalActor(...)`. |
| `docs/BOUNDARY_DISCIPLINE.md` | Extend the closed-union claim with the 4th literal + rationale. |
| Tests | Existing tests for github webhook attribution must switch expected source. Every OTHER test's wire bytes must stay identical. |

## Load-bearing surprises

- **EFB-98's manifest-driven routes** — action bodies now flow through `ActionInput`. The github webhook is one of these — verify the provenance is constructed in the action, not the route.
- **`audit.system` was the pre-EFB-58 default.** Some existing test snapshots may explicitly assert `audit.system` for github webhook paths — update those. NEVER cast around it — that erases the audit trail.
- **This ticket is COMPILE-TIME ONLY** for downstream consumers. Do not add differential behavior based on the new literal — that's a follow-up-of-follow-up. Scope is: literal exists + github callsite wired.
- Post-EFB-98 architecture: read `docs/API.md` for how actions consume `ActionInput`. If you touch route files, the manifest is single source of truth.

## Not scope

- Any differential downstream behavior (Sonata log-lines, audit-view distinction, UI treatment) — punt to follow-up.
- Retroactive re-attribution of already-published events.

## Testing

- Snapshot every existing "wire bytes of published event" test — must stay byte-identical.
- New test: github webhook path publishes with new source literal; existing `pubkey` unchanged.
- `npm run typecheck:src && npm test`.

## Deploy context

- Backend only. Do NOT deploy — coordinator will after review.
- Base: fresh worktree off `origin/main` (`be8caa4`).

## Key IDs

- Ticket: `EFB-92`
- Session: `session-f4e8ed22897d418a`
- API base: `https://evenflow.work/api/v0`

## Related work

- **EFB-58** — Typed provenance for identity references (parent of the closed-union).
- **EFB-63** — Lane B provenance via sidecar (where the audit.system fit was flagged as honest-but-lossy).
- **BOUNDARY_DISCIPLINE.md** — the constraint doc; extension needs justification here.

## Coordination

- DM me your name + shape proposal BEFORE editing. I ratify, then you go.
- DM if the wire-byte invariant looks ambiguous.
- Small overlap risk with EFB-83 in github.ts — coordinate via worktree; likely different lines.
