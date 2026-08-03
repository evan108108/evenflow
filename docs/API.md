# The Evenflow API

How this API is put together, and how to add to it without re-deriving any of
it. The rule sheet lives next door in [REST_CONVENTIONS.md](./REST_CONVENTIONS.md)
— that file is what the checker enforces; this one explains the machinery and
shows you the shapes.

Companion reading: [BOUNDARY_DISCIPLINE.md](./BOUNDARY_DISCIPLINE.md) governs
what a route accepts once you reach it.

---

## The bug all of this exists to prevent

A script attached tickets to a sprint by POSTing to
`/api/v0/boards/evan-s-flow-board/sprints/{id}/issues`. That is the URL the API
*should* have had. The URL it actually had was `.../add-issue`. The server
404'd, the script never checked the status, and the tickets looked attached
while the database disagreed.

Nothing there was exotic. Three ordinary things lined up:

1. The right URL was **not derivable** — the API mixed `add-issue` with
   `POST /issues`, so guessing correctly was luck.
2. Nothing **rejected the wrong shape** when it was written.
3. No artifact said **what the API actually served**, so nobody could check.

Four pieces address those, and none of them work alone:

| Piece | What it fixes |
| --- | --- |
| `src/routes-manifest.ts` | there is now one list of every URL |
| `scripts/check-rest-conventions.mjs` | a wrong-shaped URL fails the build |
| `docs/REST_CONVENTIONS.md` | the rules the checker encodes |
| `src/actions/` | behaviour is testable without naming a URL |

---

## The manifest

`src/routes-manifest.ts` is the only place in the codebase a URL pattern may be
written. Route files, tests, the web app and the docs page all read from it.

```ts
{
  id: "sprint.issues.attach",           // stable handle — callers use this
  method: "POST",
  path: "/board/:slug/sprint/:id/issues",
  orgScoped: true,                       // also served under /org/:org_slug
  file: "sprints.ts",
  auth: "contributor",
  stateAction: true,                     // only for real state transitions
}
```

`id` is the point. Tests and web callers reference routes by id, never by
path, so changing a URL is a one-line edit here instead of a grep across 46
test files.

### Org scoping

Ten routers are mounted twice — bare at `/api/v0`, and again under
`/api/v0/org/:org_slug`. Rather than declare every path twice (which drifts,
which is the thing we are removing), an entry sets `orgScoped: true` and the
router mints both mounts from the one declaration.

`effectivePaths()` is what expands that, and both the URL builder and the
convention checker go through it — so they cannot disagree about what the API
serves.

This matters more than it sounds. A collision can involve a path nobody wrote
down: `boards.ts` mounted under the org prefix served
`GET /api/v0/org/:org_slug/boards`, which `orgs.ts` had already registered.
`orgs.ts` mounts first, so its handler always won and the boards-router twin
was unreachable — a route that existed only on paper. Checker rule 7 found it
by expanding org twins before comparing.

### Building a URL

```ts
import { url } from "../src/routes-manifest";

url("issue.get", { id: "FLOW-42" })
// "/api/v0/issue/FLOW-42"

url("issue.list", { slug: "flow" }, "acme")
// "/api/v0/org/acme/board/flow/issues"
```

`url()` throws on a missing parameter and percent-encodes what you give it.
Both are deliberate:

- **Throwing** turns the silent 404 that opened this ticket into an
  author-time error.
- **Encoding** means you must NOT wrap arguments in `encodeURIComponent`
  yourself. Doing so double-encodes and produces a URL that 404s. Thirteen
  call sites had this bug during the migration.

Never concatenate onto a built URL. `url("sprint.list", { slug }) + "/" + id`
produces `/board/flow/sprints/<id>`, but the route is `/board/:slug/sprint/:id`
— singular. Concatenation bakes in the old convention and cannot survive a
rename. Ask for the route you actually want.

### The auth field

`auth` on a manifest entry is **documentation only**. Authorization is enforced
inside handlers by `requireCaller` / `boardScope` / `orgScope`, which remain
the security boundary. Do not make a security decision from that field.

---

## Actions

**An action is business logic with the HTTP taken out.** Routes are thin
shells; actions never import Hono and never see a `Context`.

That sentence is also the decision procedure. When you are unsure whether
something belongs in `src/actions/`, ask: **would this exist if we were not
serving HTTP?** Yes → it moves. No → it stays in the route.

Applying it honestly means some routes get no action at all, and that is the
right outcome rather than a gap:

| Route | Why it stays whole |
| --- | --- |
| `/.well-known/oauth-protected-resource` | returns a static object literal |
| `GET`/`DELETE /mcp` | one-liners answering `405` |
| `GET /server-pubkey` | one call to a pure lib function plus a cache header |
| `GET /board/:slug/stream` | an SSE stream proxied from a Durable Object — it cannot return through `runJson`, which ends in `c.json` |
| `GET /auth/oauth/start` | PKCE verifier, two `Set-Cookie` headers, a 302 |

Wrapping a constant in an action module is ceremony: it satisfies a shape while
making the code harder to read. Where a transport-heavy route does contain real
logic — the token exchange inside the OAuth callback, the session mint after a
Nostr signature verifies, the tool dispatch inside the MCP envelope — extract
that and leave the shell.

**Why:** before the split, the only way to test a behaviour was to name a URL —
so tests asserted the same string the client used, and a client and server
could disagree about a path while the suite stayed green. That is exactly how
the sprint bug survived. An action is callable directly.

### The interface

```ts
export type ActionInput<Body = undefined> = {
  readonly claims: Claims;          // caller GUARANTEED — route ran requireCaller
  readonly token: string;           // raw bearer, "" when unused
  readonly orgSlug: string | null;  // null on the bare mount
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly body: Body;              // already decoded by the route's schema
};
```

`PublicActionInput` is the same with `claims: Claims | null`, for routes
reachable anonymously — `/api/v0/*` runs behind *optional* auth so public
boards read without sign-in.

Pick deliberately: the type is the documentation. `ActionInput` means a caller
is guaranteed and the 401 already happened. `PublicActionInput` means anonymous
access is a case this code has thought about.

`token` is a field rather than a second argument because
`ensurePersonalOrg` / `upsertMembership` publish signed kind-30521 grants on
the caller's behalf — business logic that happens to need a credential.

### The split

```ts
// src/actions/comments.ts — the domain
export const createComment = (
  input: ActionInput<typeof PostCommentBody.Type>,
): Effect.Effect<Result, CommentsFailure, CommentServices> =>
  Effect.gen(function* () {
    const issue = yield* fetchIssueForRole(input.params["id"] ?? "", pubkey, "contributor");
    ...
  });
```

```ts
// src/routes/comments.ts — the shell
comments.post(path("comment.create"), async (c) => {
  const program = Effect.gen(function* () {
    const claims = yield* requireCaller(c.get("claims"));
    const body = yield* parseRouteBody(c, PostCommentBody);
    return yield* createComment(
      actionInput(claims, c.req.param(), body, { orgSlug: c.req.param("org_slug") ?? null }),
    );
  });
  return runJson(c, program, 201);
});
```

### Two boundaries that are load-bearing

**Parse the body IN THE ROUTE.** `check:boundary` scans route files as text for
the `parseRouteBody` marker. Move the parse into the action and the ratchet
goes blind to it — the exact class of blind spot this work exists to close. The
same applies to `parseRouteQuery` and to `readJsonBody` on routes still on the
`unmigrated` allowlist: EFB-87's re-audit *fails* an entry whose file shows no
body-read marker. The schema lives with the logic that consumes it; the route
imports it back.

**`errorResponse` stays in the route.** Turning a failure union into a status
code is the one part that genuinely is transport. Each router owns a distinct
union with domain-specific reasons, and collapsing them would either lose
reasons or grow a union nobody can read.

### Failure vocabulary

Tagged classes live in `src/lib/errors.ts` — `ValidationError`,
`QueryValidationError`, `ConflictError`, `NotFoundError`, `RateLimitError`.
Actions raise them. `src/routes/errors.ts` keeps `errorResponse` and
`readJsonBody`.

---

## Mounting

`src/router.ts` holds the one mount table. `src/index.ts` and
`tests/harness.ts` both call `mountAll()`, so the app under test *is* the app
that ships.

That was not true before: the list was copied into four files and had drifted.
Six mounts existed in `index.ts` and in no harness, so the org-scoped github,
imports and search routers — 11 effective paths — were served in production and
exercised by nothing. A hand-copied harness fails open: it silently tests a
smaller app than the one you deploy.

**Order is load-bearing.** Hono resolves by registration order, so routers that
own a specific path mount before the mirrored board-family routers that would
otherwise swallow it. Each such constraint carries a comment at its entry.
`tests/router.test.ts` pins the three that matter.

---

## Auth levels

| Level | Meaning |
| --- | --- |
| `public` | no caller needed |
| `optional` | works anonymously, richer with a caller |
| `caller` | any authenticated caller |
| `viewer` | can read this board |
| `contributor` | can write issues/comments on this board |
| `admin` | can change board or org settings |
| `owner` | can delete, or transfer ownership |

Reads on public boards sit at `viewer` and resolve anonymously.
Every mutation gates on `requireCaller` first.

---

## Adding a route

1. Add an entry to `ROUTES` in `src/routes-manifest.ts`.
2. `npm run check:rest-conventions`.
3. Write the action in `src/actions/<family>.ts`, including its body schema.
4. Register a thin route: extract params, `parseRouteBody`, call the action,
   `runJson`.
5. Test the action directly in `tests/actions/<family>.test.ts`. You do not
   need to assert anything about the URL — the manifest, the checker and the
   mount-table test cover routing once, for everything.
6. Reference it from callers by id: `url("your.route.id", { ... })`.

`npm run check` runs `typecheck:src` + `check:boundary` +
`check:boundary-query` + `check:rest-conventions`.

---

## Testing discipline

**A test you have not seen fail is a test you are trusting on faith.** Before
you rely on an assertion, break the thing it guards and watch it go red — and
watch how many OTHER tests stay green, because that number tells you whether
anything else was covering the behaviour.

Two cases from this migration, both of which passed for the wrong reason first:

- An ordering guard was pinned by moving a body parse above its gate. Exactly
  one test reddened and 1049 stayed green. The green is the finding: nothing
  else covered the ordering, which is why the flip was invisible.
- A slug-transposition guard used fixtures where the org and the board had
  *different* slugs. A transposition just missed the lookup and 404'd, so the
  test passed without ever exercising the confusion. Rewritten so the org and
  one of its boards share a slug with different rosters, a transposition
  resolves a REAL board and every layer succeeds — only the authorization
  answer is wrong.

**After any input-shape change, re-verify your guards against the NEW
implementation.** A mutation check run against the old shape proves nothing
about the new one. The same slug guard above survived a refactor from
`params` to a named field still green *and now vacuous*: the seed used the old
shape, the field came out null, the lookup took its no-org branch, and the
right answer arrived through the wrong path. A green test after a refactor is
not the same test.

## Anti-patterns, with the real cases

Everything below was in this codebase. None of it is hypothetical.

**Verb in a URL for a CRUD operation.**
`POST .../sprints/:id/add-issue` → `POST /board/:slug/sprint/:id/issues`.
`POST /issues/:id/move-to-board` → `PUT /issue/:id/board`.
`PATCH /issues/:id/reorder` → `PUT /issue/:id/position`.
The method already says what you are doing.

**Plural followed by an id.** `/boards/:slug` reads as "the slug of the
boards". 77 of 105 routes had this.

**A verb route for what is a field.** `POST /issues/:id/duplicate-of` had
*byte-identical* authorization to `PATCH /issue/:id` —
`fetchIssue(id, pubkey, "contributor")` in both. So it was a field, and folding
it into PATCH deleted ~130 lines that PATCH already implemented. The test for
whether a sub-resource is earned is whether it has a rule of its own:
`PUT /issue/:id/board` keeps one because it needs write access on **two**
boards, and burying that in a PATCH branch would hide a security check inside a
conditional.

**Carving out an exception so your own path passes.** The first draft of
`duplicate-of` kept the verb and taught the checker to allow a trailing `-of`.
If you are writing an exception for your own case, you probably do not have a
principle. The checker has zero exceptions.

**Renaming a URL someone else holds.** `POST /api/v0/webhooks/github/:board_id`
is saved in every repo's settings on github.com. It was briefly renamed during
this migration — and it never violated the rule anyway, because `webhooks` is
followed by the literal `github`, not by a parameter. Run the rule against the
path before assuming.

**Hand-writing a URL you then hand to a user.** `github.ts` built
`webhook_url` — the string the UI tells you to paste into GitHub — as a literal
in two places. The `/docs` page had 22 curl samples pointing at paths that no
longer existed. Both dispense 404s to humans. Both build from the manifest now,
and `web/src/pages/docs/rest-spec.test.ts` fails if a sample's URL is not
served by the route it documents.

**A guard that stops guarding.** `tests/provenance-lane-b.test.ts` reads route
files as raw text. When those callsites moved into an action module, the guard
would have kept passing while proving nothing. A source-scanning test must
follow the code it guards.

**Best-effort hiding a permanent failure.** The board page fetched
`${apiBase}/members`, which for a personal board built a URL no route has ever
served. It 404'd every time and a `.catch()` swallowed it. If a call can never
succeed, "best-effort" is not the right description of it.
