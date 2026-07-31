# Importing issues from a CSV

Evenflow imports **one CSV shape: its own.** There is no Linear importer, no Jira
importer, no GitHub importer, and there is not going to be one.

That is a deliberate trade, and it is worth stating plainly because the
alternative looks friendlier at first glance. A per-vendor importer is a promise
to track every exporter's column renames, date formats, and status vocabularies
forever, and it fails the moment someone arrives from the tracker nobody wrote an
adapter for. Instead, the conversion is done by the thing that is already good at
it: you export from your tracker, hand the file to an AI assistant with one of
the prompts below, and it hands back canonical CSV. Evenflow validates that and
nothing else.

The three worked prompts (Linear, Jira, GitHub) are served at
[`/docs#import`](https://evenflow.work/docs#import), where they can be copied
directly. They live in `web/src/pages/docs/import-prompts.ts` — one copy, so the
page and this document cannot drift apart.

## The canonical shape

```
title,body,type,status,container,estimate,labels,assignee_pubkey,external_url,created_at_ms
```

| Column | Required | Notes |
|---|---|---|
| `title` | **yes** | Whitespace-trimmed. A blank title rejects the row. |
| `body` | no | Markdown. |
| `type` | no | `task`, `feature`, `bug`, `story`, `improvement`, `chore`. Case-insensitive. Defaults to `task`. |
| `status` | no | A column **name** on the destination board, matched case- and whitespace-insensitively. Defaults to the board's first enabled column. |
| `container` | no | `backlog`, `active`, `icebox`. `iced` is accepted as the pre-EFB-17 spelling. Defaults to `backlog`. |
| `estimate` | no | Non-negative whole number. |
| `labels` | no | **Semicolon**-separated: `auth;urgent`. Commas are the field separator, so they cannot also separate labels. |
| `assignee_pubkey` | no | See [Assignees](#assignees) — usually best left blank. |
| `external_url` | no | The original ticket's permalink. This is the **dedup key**; see [Re-importing](#re-importing). |
| `created_at_ms` | no | Unix timestamp in **milliseconds**, so an imported backlog keeps its real age. |

Anything else is an error. A column Evenflow does not recognise rejects the
import and names itself, rather than being silently dropped — a `titl` header
that imported 400 issues with no titles would be worse than a failed import.

## Limits

- **1000 rows per import.** Larger files import in batches.
- Unknown columns, missing titles, and bad value types reject the **whole batch**
  before anything is written.
- Duplicates, unknown statuses, and unmappable assignees do **not** reject the
  batch — they are reported per row. See [Partial success](#partial-success).

## Partial success

Two kinds of problem exist, and they get different answers.

**Shape problems reject everything.** An unknown column, a missing title, an
estimate that is text rather than a number — these are decidable from the row
alone, the file is wrong, and importing 996 of 1000 rows from a broken file just
means cleaning up afterwards. The error names the offending row indices:

```json
{ "error": "invalid-body", "reason": "issues-rows-7-14-22" }
```

**State problems are reported per row and the rest still lands.** Whether
`In Rvw` names a column on *this* board, whether this ticket was already
imported, whether that assignee is a member *here* — none of these can be known
from the file, only from the board. A 500-row paste must not die on row 3:

```json
{
  "import_id": "…",
  "counts": { "total": 500, "created": 496, "skipped": 3, "failed": 0, "unassigned": 12 },
  "rows": [
    { "row": 0, "status": "created", "short_id": "FLOW-41" },
    { "row": 1, "status": "skipped", "reason": "duplicate-external-url", "existing_short_id": "FLOW-12" },
    { "row": 2, "status": "skipped", "reason": "unknown-status", "value": "In Rvw" },
    { "row": 3, "status": "created", "short_id": "FLOW-42", "assignee_skipped": "jane@acme.com" }
  ]
}
```

`row` is the 0-based index in the submitted array, so results line up with the
preview table.

Read `created`, `skipped` and `unassigned` as three different facts:

- `skipped` — **no issue was created.**
- `unassigned` — the issue **was** created; only its assignee field was dropped.
- `failed` — no issue was created, for a reason we did not choose. Rare, and the
  only one of the three worth investigating.

## Assignees

An assignee that cannot be matched to a member of the destination board is
**dropped, and the issue imports unassigned.** Evenflow never invents a
placeholder identity for a name it does not recognise.

This is why the prompts tell the AI to leave `assignee_pubkey` blank rather than
filling it with an email or a display name: `jane@acme.com` is not an Evenflow
identity and cannot become one, so the row imports unassigned either way. The
difference is only whether the report tells you it happened. Every dropped
assignee is reported on its row and counted in the import audit as
`unmapped_assignees`, so the count survives even after the detailed report is
swept.

Assign properly after import, or add the people to the board first and re-run
with real pubkeys — the duplicate check means re-running is safe.

## Re-importing

Rows are deduplicated by `external_url`, scoped to the board. Re-importing the
same file skips everything already brought in, and reports each skip against the
issue it resolved to. Rows without an `external_url` cannot be deduplicated and
will import again — which is the main practical reason to keep the column.

Importing the same export into **two different boards** works: the dedup is
per-board, because splitting one backlog across two boards is a legitimate thing
to do.

Retrying the *same* import is also safe. Each import carries an `import_id`
minted when the file is parsed, and re-POSTing it replays the original report
instead of creating a second copy. That window lasts 24 hours; after it, the
`external_url` dedup is what protects you.

## Two consequences worth knowing about

**1. Imported issues are not mirrored to the 4a substrate.**

Normally a public board's issue is mirrored to the substrate as a signed kind
30551 event, and the row records its id in `substrate_event_id`. Imported issues
carry `NULL` there, permanently and by design — publishing per issue would mean
one gateway round-trip per row inside a single request, which is not reachable
for a 1000-row import at any timeout.

This is stated in the API response rather than left to be inferred from a NULL
column, so nobody files it as a bug:

```json
"substrate": { "state": "not_applicable_for_imports", "reason": "…" }
```

**2. An import emits ONE event, not one per issue.**

A 1000-row import fires a single `issues.imported` board event carrying a summary
(`import_id`, `count`, `created`, `skipped`, `unassigned`) — not 1000
`issue.created` events. One user action, one event. A thousand would storm every
open board tab and, post-EFB-13, bury webhook subscribers behind a sweep that
delivers 50 a minute.

Two things follow:

- SSE clients should **refetch** on `issues.imported` rather than expecting
  per-issue payloads.
- A webhook subscription carrying an `assignee` predicate will **not** fire on an
  import. The aggregate has no single assignee to match, so a "notify me about my
  issues" subscription stays silent through one. Unfiltered subscriptions get
  their single delivery normally. If per-user notification on imports matters to
  you, that needs a follow-up ticket — it is not something the current predicate
  grammar can express.

## API

```
POST /api/v0/boards/:slug/issues/bulk
```

Requires `contributor` on the board.

```json
{
  "import_id": "3f1c2b8a-0000-4000-8000-000000000001",
  "issues": [
    { "title": "Fix the login redirect", "type": "bug", "labels": ["auth", "urgent"] }
  ]
}
```

Note that `labels` is a JSON **array** here, not a semicolon-joined string.
Semicolon separation is a CSV encoding detail — it exists because commas are the
field separator — and it stops at the browser. The API never sees one, and so
never has to guess whether a `;` inside a label was a separator or a character.

Mint `import_id` when the file is parsed, not when the request is sent. An id
minted per-request is fresh on every retry and deduplicates nothing.

```
GET /api/v0/boards/:slug/imports
```

The permanent audit list: who imported how many rows, when, and how many
assignees could not be mapped. Per-row detail is not here — that lives in the
24-hour replay window.

## Getting the CSV

Use the prompt for your tracker at [`/docs#import`](https://evenflow.work/docs#import).
Each one tells the assistant the canonical header, the value vocabularies, the
per-vendor quirks worth knowing (Jira repeats the `Labels` column; GitHub exports
mix pull requests in with issues), and — importantly — to leave a field blank
rather than invent it.

Then paste the result into **Board settings → Import from CSV**, which parses it
in the browser, validates every row against the same schema the server uses, and
shows you what will happen before anything is written.
