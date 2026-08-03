# REST conventions

Companion to [BOUNDARY_DISCIPLINE.md](./BOUNDARY_DISCIPLINE.md). That document
governs what a route accepts once you reach it; this one governs how you find
it in the first place.

## The bug that caused this

A coordinator script attached tickets to a sprint by POSTing to
`/api/v0/boards/evan-s-flow-board/sprints/{id}/issues`. That is the URL the API
*should* have had. The URL it actually had was `.../add-issue`. The server
404'd, the script did not check the status, and the tickets appeared attached
while the database said otherwise.

Three things had to be true at once, and the fix addresses each:

| What went wrong | What now prevents it |
| --- | --- |
| The correct URL was not derivable — the API mixed `add-issue` with `POST /issues` | These conventions |
| Nothing rejected the wrong-shaped URL when it was written | `npm run check:rest-conventions` |
| No artifact listed what the API actually served | `src/routes-manifest.ts` |

Conventions alone would not have helped: they are prose, and prose does not
fail a build. The manifest is what makes them checkable.

## The rules

### 1. Singular when followed by an id, plural for collections

```
GET    /boards               a collection
POST   /boards               create into that collection
GET    /board/:slug          ONE board
GET    /board/:slug/issues   a collection within one board
GET    /issue/:id            ONE issue
```

`/boards/:slug` reads as "the slug of the boards" and is wrong. This was the
single most common violation in the pre-EFB-98 API — 77 of 105 routes.

### 2. No verb in a URL for a CRUD operation

The HTTP method already says what you are doing.

| Instead of | Write |
| --- | --- |
| `POST /issues/:id/move-to-board` | `PUT /issue/:id/board` |
| `PATCH /issues/:id/reorder` | `PUT /issue/:id/position` |
| `POST /boards/:slug/unarchive` | `DELETE /board/:slug/archive` |
| `POST .../sprints/:id/add-issue` | `POST /board/:slug/sprint/:id/issues` |
| `POST .../sprints/:id/remove-issue` | `DELETE /board/:slug/sprint/:id/issue/:issue_id` |

### 3. Genuine state transitions may keep a verb — declared explicitly

Some actions are not CRUD on any resource: starting a sprint, completing one,
transitioning an issue between columns. Those keep a verb, and the manifest
entry must say so:

```ts
{ id: "sprint.start", method: "POST", path: "/board/:slug/sprint/:id/start",
  stateAction: true, ... }
```

`stateAction: true` is opt-in on purpose. An implicit allowlist lets verbs
accumulate quietly; a required flag makes each one a visible decision in a
diff.

The test is whether the segment names a *transition* the resource undergoes
(`start`, `complete`, `transition`) rather than an *operation you perform on
it* (`add`, `remove`, `update`, `move`). If a CRUD verb expresses it, it is not
a state action.

### 4. Removal is DELETE

A `POST` whose last segment means removal — `unarchive`, `remove`, `revoke`,
`detach` — is a `DELETE` on the thing being removed. Paired state uses the same
path with two methods:

```
POST   /board/:slug/archive     archive it
DELETE /board/:slug/archive     un-archive it
```

Note the distinction from *reading* archived data. `GET
/board/:slug/sprint/:id/archived-issues` reads a collection and never mutates
archive state; sharing the word `archive` between the two was itself a source
of confusion, so the read has its own noun.

### 5. Paths are kebab-case; parameters keep snake_case

`/board/:slug/archived-issues`, not `/board/:slug/archived_issues`. Parameters
mirror field names, so `:org_slug` and `:board_id` stay as they are.

### 6. The org parameter is always `:org_slug`

Before EFB-98 the same concept appeared as `:slug` (20 uses), `:handle` (12)
and `:org_slug` (11), so which parameter held the org depended on which file
you were reading. One spelling, everywhere.

### 7. One route per (method, effective path)

Org-scoped routes are served twice — bare and under `/org/:org_slug` — so a
collision can involve a path nobody wrote down. The checker expands every
entry through `effectivePaths()` before comparing.

This rule found a live collision the day it was written: `boards.ts` was
mounted under the org prefix and served `GET /api/v0/orgs/:org_slug/boards`,
which `orgs.ts` had already registered. `orgs.ts` mounted first, so its handler
always won and the boards-router twin was unreachable — a route that existed
only on paper for as long as both had been there.

## How it is enforced

`src/routes-manifest.ts` is the only place a URL pattern may be written.

```
npm run check:rest-conventions   # rules 1-7 above, against the manifest
npm run check                    # typecheck + boundary + boundary-query + this
```

The checker reads the manifest rather than route-file text, and that is the
point. `check:boundary` scans source as text, so a route registered through a
computed path is invisible to it — which is exactly how three `promote_to_*`
routes came to be declared in an allowlist as an audit note instead of being
actually checked. In the manifest, registration *is* declaration: a route that
is not listed is not served, so nothing can hide.

## Adding a route

1. Add an entry to `ROUTES` in `src/routes-manifest.ts`.
2. Run `npm run check:rest-conventions`.
3. Reference it by `id` from tests and web callers — `url("issue.get", { id })`
   — never by a string literal. A literal is how the original bug got written;
   `url()` throws on a missing parameter instead of minting a URL that 404s.
