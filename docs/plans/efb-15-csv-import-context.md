# EFB-15 — CSV Import (canonical schema + AI-transform docs, no per-vendor code)

Ticket: `https://evenflow.work/@evan108108/evan-s-flow-board/issues/EFB-15`

## Scope one-liner

Ship a canonical Evenflow CSV import: bulk-create endpoint accepting a canonical CSV shape, /import UI (paste or upload → preview → confirm), docs page explaining how users get their friendly AI to transform vendor exports (Linear, Jira, GitHub) into that canonical shape. **Zero vendor-specific code** — we accept only our own shape.

## Evan's approved design decisions (from email thread)

- Canonical schema columns: `title, body, type, status, container, estimate, labels, assignee_pubkey, external_url, created_at_ms`
- Labels are `semicolon-separated`, not comma (works better in CSV)
- Status matches column NAME on the target board (not id) — portable across boards with similar setups
- **Unmappable assignees:** SKIP the field, land the issue unassigned. Audit log records the intended assignee string. (Option a from design email — no shadow identity invention, keeps import a one-step operation.)
- **Duplicate handling on re-import:** SKIP by `external_url` match. Audit "skipped N as already imported." (Option a — natural dedup key, matches Linear/Jira/GitHub CSV conventions.)
- **AI-transformed CSVs:** NO stamp on individual issues. Import EVENT audit records "imported via /import at time T with row count N". AI-transform is out of scope for us to track. (User doesn't know if csv came from ChatGPT or hand-editing.)
- Endpoint: `POST /api/v0/boards/:slug/issues/bulk` accepting `{issues: [...]}`
- Body limit: **1000 issues per import.** Larger imports run through paginated batches. (Cloudflare Workers body limit.)
- Idempotency: each row gets a synthetic `import_id` (uuid at parse time); if the client retries the whole POST, dedup by import_id in a small table with a TTL
- Docs page: ships alongside the endpoint with 3 worked prompts (Linear→canonical, Jira→canonical, GitHub→canonical), each ~50 lines

## In scope THIS ticket

1. **Migration 0026** — `issueImports` audit table + `importIdDedup` short-TTL table (for idempotency)
2. **`POST /api/v0/boards/:slug/issues/bulk`** — via `parseRouteBody` (mandatory, Boundary Discipline)
3. **`src/routes/imports.ts`** (or wherever it fits) — CRUD for import events + bulk endpoint
4. **`web/src/components/ImportSection.tsx`** — paste/upload → preview → confirm UI
5. **`docs/import-csv.md`** — canonical schema + 3 worked prompts (Linear/Jira/GitHub)

## Explicitly OUT of scope

- Interactive column re-mapping in the UI (users edit CSV first)
- Incremental sync ("update Evenflow when Linear changes" — that's a webhook problem)
- Rich content (attachments referenced in CSV, comments-as-CSV) — separate ticket
- Shadow identities for unmappable assignees (Evan's Option a: skip)
- Per-row user choice on duplicates (Evan's Option a: skip-by-external-url)

## Load-bearing surprises

1. **New route family — MUST use parseRouteBody from day one.** EFB-54's `check:boundary` script does not accept new-route additions to the allowlist. Read `docs/BOUNDARY_DISCIPLINE.md` before writing.

2. **Bulk-create needs partial-success semantics.** 1000 rows, 3 rows have unknown statuses, 2 rows are duplicates. Do you 400-the-whole-batch or return 200 with a partial-success report? **Lean: 200 with a per-row status array** (created/skipped-duplicate/skipped-unknown-assignee/error-<reason>). The user can then re-import only the failures. Failing the whole batch on any error would break "paste 500 rows and go." Confirm this in the DM.

3. **`external_url` dedup requires a schema field.** Currently `issueCache` has no `external_url` column. Migration 0026 adds it (nullable text, indexed for dedup lookup).

4. **`status` matching by column NAME on the target board is portable but fragile.** Different boards use "Todo" vs "To Do" vs "Not Started." Case-insensitive + trim-whitespace before matching; unknown status → skip with warning, don't guess. Do NOT create columns on the fly.

5. **`assignee_pubkey` field accepts both `nostr:<hex>` and `nostr:<npub…>`.** Use the existing `IdentityRef` canonicalization (from EFB-38 / EFB-54). Empty string = unassigned.

6. **`type` field is a closed union.** `bug | task | feature`. Unknown → skip with warning. Same discipline as `status`.

7. **`container` values are `backlog | active | icebox`** (per EFB-17's correction — worker-5 named `icebox` not `iced`). If import CSV says `iced`, treat as `icebox`; if says something else, skip with warning.

8. **CSV parsing library.** Use `papaparse` or `csv-parse` — do NOT hand-roll. Both handle escaped commas, quoted strings, and multi-line body fields correctly.

## Files to touch

| File | Change |
|---|---|
| `migrations/0026_issue_imports.sql` (new) | `issueImports` audit table (id, board_id, imported_by_pubkey, imported_at_ms, row_count, skipped_count, error_count). Also add `external_url TEXT NULL` + `import_event_id TEXT NULL` columns to `issueCache` for dedup + backreference. Also `importIdDedup` (id, created_at_ms) — TTL 24h via periodic sweep. |
| `src/shapes.ts` | `IssueImportShape`; extend `IssueShape` with new nullable fields |
| `src/routes/imports.ts` (new) | `POST /boards/:slug/issues/bulk` via parseRouteBody. Handles partial success. `GET /boards/:slug/imports` for audit list. |
| `src/index.ts` | Mount `makeImportsRouter()` |
| `src/lib/csv-canonical.ts` (new) | Schema definition + row validator + canonicalization helpers |
| `web/src/components/ImportSection.tsx` (new) | Paste/upload → preview → confirm UI. Model on other `*Section.tsx` under `web/src/pages/BoardSettings.tsx`. |
| `docs/import-csv.md` (new) | Schema doc + 3 worked prompts (Linear/Jira/GitHub → canonical) |
| Tests | Schema validation; partial-success semantics; dedup by external_url; unknown-status skip; body-limit 1000; idempotency by import_id |

## Where things live

- Boundary Discipline: `docs/BOUNDARY_DISCIPLINE.md` (mandatory read)
- Schema wrapper: `src/lib/route-body.ts`
- Existing bulk-shaped route to mirror: none really — this is a new pattern. Model the partial-success shape after nothing in-repo; standard REST bulk semantics apply.
- Board settings UI panel pattern: `web/src/pages/BoardSettings.tsx` + existing `*Section.tsx` components (per EFB-13's `WebhooksSection.tsx` pattern)
- IdentityRef canonicalization: `src/lib/identity.ts` (from EFB-38/54)

## Testing

- Unit: schema rejects unknown columns; canonical row rejects unknown status/type/container; assignee canonicalization matches EFB-38
- Integration: 1000-row import with 3 skips → 200 with per-row status array showing 997 created + 3 skipped-with-reason
- Idempotency: same POST replayed → 200 with import_id already-exists (no double-create)
- Dedup: same external_url on re-import → skipped-duplicate for that row
- UI: paste malformed CSV → parse error surface; well-formed → preview + confirm works
- `check:boundary` → 6/49 migrated (was 5/48 post-EFB-17) with 0 violations, 0 allowlist additions

## Deploy context

- Prod evenflow at `e05819a5` (post-EFB-58)
- Migration 0026: LOCAL first, DM Sona before prod (use `wrangler d1 migrations apply --remote`)
- Standard evenflow deploy: `EVENFLOW_CF_API_KEY` + `EVENFLOW_CF_EMAIL` (Global-API-Key via `CLOUDFLARE_EMAIL`+`CLOUDFLARE_API_KEY`)
- `git status` before deploy (hard rule)

## Key IDs

- Board (smoke): `4042afb7-d1fe-4a80-a311-9de404b0ee14`
- Sona canonical: `nostr:049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2`
- JWT: `mem_secret_get evenflow_login` (via MCP — NOT the CLI, per today's dispatch-lesson)

## Related

- EFB-13 (shipped): outbound webhooks — model for new-route-family + Boundary Discipline discipline
- EFB-54 (shipped): parseRouteBody wrapper this uses
- EFB-38 (shipped): IdentityRef canonicalization
- EFB-17 (shipping): correct container vocabulary (icebox not iced)

## Coordination points — DM me before

- **Partial-success shape** (surprise #2) — confirm 200-with-per-row-status semantics before coding the response format
- Migration 0026 prod apply
- The 3 worked prompts (Linear/Jira/GitHub) — DM sample prompts for Evan's voice check before shipping docs
- Pre-deploy always

## DM FLOW — MANDATORY

1. DM Sona (session `session-f4e8ed22897d418a`).
2. Status DMs at phases: migration, backend/endpoint, UI, docs, tests, pre-deploy.
3. DO NOT `worker_event_complete` until Sona reviewed AND said shipit.

## Checkpoint caveat

Restore by `checkpointId`. State should name "EFB-15 dispatch". If not, DM immediately.

## Standing rules

- Use `wrangler d1 migrations apply --remote` (not `execute --file`) — EFB-38 tracker trap.
- `mem_secret_get` via MCP for secrets, not CLI (silent stdout capture).
- Baseline: 2 root + 1 web pre-existing tsc errors.
- No focus rings/outlines on interactive elements.
- Read docs/BOUNDARY_DISCIPLINE.md before writing route code.
