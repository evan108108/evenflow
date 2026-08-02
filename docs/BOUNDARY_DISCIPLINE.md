# Boundary Discipline

**A boundary that says "yes" when it should say "no, and here's why" is a bug — even when nothing crashes and every test passes.**

This is the developer guide for how request bodies **and query strings** enter evenflow. Read it before you write a route handler.

## Why this exists

In one day, eight bugs shipped or were narrowly caught. Different subsystems, different authors, one shape:

| Bug | What the boundary accepted | What the caller got |
|---|---|---|
| EFB-38 | `assignee_pubkey` as any string | Work assigned to a non-member, stored |
| EFB-42 | `:pubkey` in a non-canonical form | Silent 404 for a real person |
| EFB-51 | Unnormalized input to bulk dedupe | Silent double-write |
| EFB-53 | Unknown keys in a PATCH body | **200 OK, change silently dropped** |
| EFB-33 | `assignee_pubkey` where `actor_pubkey` was meant | False attribution on a signed public event |
| EFB-35 | Cross-board attachment reference | Isolation silently unasserted |
| EFB-36 | A join that skipped declaration republish | Silent roster drift; zero encrypted events delivered |
| EFB-24 | Three variants at once | Fork gate, never-scheduled publish, tests certifying the bug |

None of these threw. Every one returned a success. That is the disease: **silent success**. The cost was 6–8 hours in a single day, spent one symptom at a time.

The common cause is that a handler receives `Record<string, unknown>` and then hand-checks whatever the author remembered to check. What the author forgot is, by construction, invisible — there is no error, just a plausible-looking result.

## The four invariants

Every request body crossing into evenflow must satisfy all four. They are provided **by construction** by `parseRouteBody`, not by handler code that remembers to call them.

1. **Unknown keys are rejected.** `400`, naming the offending field. A typo (`titl`) or a wrong guess (`assignee` for `assignee_pubkey`) must fail loudly. This is the direct fix for EFB-53.
2. **Wrong types are rejected.** `400`, naming the field. `priority: "high"` where a number is meant does not coerce.
3. **Required-but-missing is rejected.** `400`, naming the field.
4. **Output is canonical.** The schema returns the normalized form, and downstream code operates on that. It never re-parses, re-normalizes, or second-guesses. This is the direct fix for EFB-38 and EFB-42.

## How to write a route

```ts
import { Schema } from "effect";
import { parseRouteBody, IdentityRefFromInput } from "../lib/route-body";

const PatchIssueBody = Schema.Struct({
  title: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  assignee_pubkey: Schema.optional(Schema.NullOr(IdentityRefFromInput)),
  priority: Schema.optional(Schema.NullOr(Schema.Int)),
});

// In the handler:
const body = yield* parseRouteBody(c, PatchIssueBody);
// body.assignee_pubkey is already canonical `<provider>:<id>` — or null, or absent.
```

Use `effect/Schema` — imported as `import { Schema } from "effect"`. **Not `@effect/schema`**: that is the pre-3.10 package, and since Effect 3.10 Schema lives in core. Adding it would install a duplicate of something we already have.

### Schemas are pure, static, and DB-free — by design

**Any check that needs a database read, or a scope parameter the route hasn't resolved yet, belongs in the handler as a named authorization step — not in the schema.**

This is not a limitation of the pattern. It is the property that makes schemas testable without a database, composable across routes, and safe to hoist to module scope.

The worked example is assignee validation, which is genuinely two questions:

- *"Is this a well-formed identity reference?"* — **shape.** Pure. Belongs in the schema. `IdentityRefFromInput` canonicalizes `049b…`, `nostr:049b…`, and `npub1…` to one form, or fails with `assignee_pubkey`.
- *"Is this person on **this board's** roster?"* — **state and authorization.** Needs `Db` and a `board.id` that isn't known until after the body is parsed and the issue fetched. Belongs in the handler, via `isRosterMember`, failing with `not-a-member`.

Folding the second into the schema would force `parseRouteBody` to carry `R = Db`, invert the handler's parse-then-fetch order, and make every schema require a live database to unit-test.

Both still answer `400`. The split is about where the check lives, not what the caller sees.

## Provenance — naming which person a pubkey is

`IdentityRefFromInput` answers *"is this a well-formed identity?"*. It cannot answer *"is this the RIGHT person?"* — every pubkey in this codebase is a `string`, so an assignee, an author, a mover of a card and an audience target are all mutually substitutable as far as the compiler is concerned.

EFB-33 is what that costs. `buildKanbanStatusChange` needed the actor who moved a card; the event carried none; the first draft reached for `issue.assignee_pubkey` — the owner of the work, usually somebody else entirely. It compiled. All 676 tests passed. It would have published false attribution to a signed public relay, where it cannot be retracted.

This is the same family as EFB-53 and the checker in the meta-lesson below: **a guard that looks total and isn't.** `string` on an identity reference looks like typing. It types the shape and says nothing about the role, and the role is the part that was wrong.

```ts
export const Provenance = Schema.Struct({
  source: ProvenanceSource,   // "route.caller" | "user.explicit" | "audit.system"
  pubkey: IdentityRefFromInput,
});
```

**`source` names the SEMANTIC ROLE of the pubkey, not the pipeline it travelled through.** A person can hold two roles in one request — the caller who posts a comment is also its author — and `source` picks which one is being asserted. Read `route.caller` as "this pubkey is the authenticated caller of the request being served," not "this value once passed through a route."

The three values are a **closed union**. Do not add a fourth without a real use case:

| `source` | The claim being made |
|---|---|
| `route.caller` | The JWT-authenticated caller of *this* request acted. |
| `user.explicit` | An admin is acting on behalf of another user's issue (bulk operations). |
| `audit.system` | No live human actor — server-generated tombstones, backfills, republishes. |

Construct one through a named helper rather than a literal:

```ts
ProvenanceFromCaller(claims)        // takes Claims, NEVER a pubkey string
ProvenanceFromSystem()              // takes nothing — nobody to name
ProvenanceFromStoredActor(pubkey)   // audit.system, re-attesting a stored identity
```

`ProvenanceFromCaller` is the strong one, and the reason is that it **takes `Claims` and not a string**: there is no spelling of it that accepts a different person's pubkey. Prefer it wherever claims are in scope. `ProvenanceFromStoredActor` does take a bare string, and its safety is weaker and different in kind — the name, not the type, is what protects you. `ProvenanceFromStoredActor(issue.assignee_pubkey)` reads false on the page, where `actorPubkey: issue.assignee_pubkey` read fine.

### Scope it to actor slots only

**Provenance is for the ACTOR of a signed event — the person who did the thing.** It is not for references.

- `assignee_pubkey` on an issue is a *reference* (who owns the work), not an actor. Leave it.
- `p`-tag targets are *audience*. Leave them.
- Pubkey lookups on read paths are *queries*. Leave them.

Over-migration widens the type without adding safety and dilutes what `Provenance` signals when you do see it. Of the five `buildKanban*` builders, exactly two have an actor slot — `buildKanbanComment.author` and `buildKanbanStatusChange.actor`. `buildKanbanBoard` and `buildKanbanSprint` carry no pubkey at all, and `buildKanbanIssue` carries only the assignee reference. Two is the complete set, not a partial migration.

### Rename the field when you migrate it

`actorPubkey: string` → `actor: Provenance`, not `actorPubkey: Provenance`. The rename is what turns every un-migrated callsite into a **missing-field** error instead of a type mismatch that a `as any` can silence. The compile errors are the migration guide.

### Provenance is compile-time only

Only `.pubkey` reaches the wire. `source` exists to make the callsite name the role, and adding it to the event as a tag would be an on-wire compatibility change requiring a mirrored update in the gateway's validators. Events built through `Provenance` are byte-identical to the ones built before it — which is a property worth *proving* by diffing builder output against the previous implementation, not asserting.

### Assert the substitution is impossible

Guard the near-miss with `@ts-expect-error`, which fails the build if the line below it *does* compile:

```ts
// @ts-expect-error — a bare pubkey string is not a Provenance.
actor: issue.assignee_pubkey,
```

An unused `@ts-expect-error` is itself a tsc error, so a clean typecheck is positive evidence that the substitution still fails — not an assumption that it does.

## Anti-patterns

**Reading the body yourself.**

```ts
const body = yield* readJsonBody(c);           // ✗ untyped bag
const title = body["title"] as string;          // ✗ a lie the compiler believes
```

`readJsonBody` returns `Record<string, unknown>`. Every field access is an unchecked assumption, and unknown keys are invisible. This is the pre-EFB-54 shape and the reason `PATCH /issues/:id` returned `200` while dropping `assignee` on the floor.

**Allowing an unknown key through "for compatibility."** A client sending a key we don't understand is a client with a bug, or a client written against a version we no longer serve. Both deserve an error; neither deserves silence.

**Re-normalizing downstream.** If a handler calls `canonicalizeIdentityRef` on a value the schema already returned, one of the two is wrong. The schema's output is canonical — that is invariant 4.

**Validating in the schema what the schema cannot see.** See the DB-free rule above. A schema that needs a board id is a schema that will be built per-request, and per-request schemas are just handler code with extra steps.

## The CI check

```
npm run check:boundary
```

`scripts/check-boundary-discipline.mjs` scans every `POST`/`PATCH`/`PUT` handler in `src/routes/` and reports how each one reads its body.

Modelled on adaptengine-worker's `contracts/check-breaking-changes.mjs`: plain `.mjs`, one greppable `[boundary]` prefix, and a two-tier outcome where acknowledged debt warns and everything else fails.

### The allowlist is a ratchet, not an amnesty

`scripts/boundary-allowlist.json` lists routes that predate this pattern. It may only shrink.

- Every entry carries a **sunset date**, and the check **fails** once that date passes — it does not warn. A date that only warns is documentation. Failing forces anyone who needs more time to extend the date in a PR, where the decision is visible in review instead of buried in CI output nobody reads.
- Sunsets more than 180 days out are **rejected outright**. `"sunset": "2099-01-01"` is an amnesty wearing a ratchet's clothes.
- Entries for routes that have since been migrated are reported as prunable.
- **New routes may not be added.** Write them against `parseRouteBody`.

### Bodiless routes are declared, not detected

Some routes read no request body at all — they act on path params and caller identity. Those go in the allowlist's `noBody` section **with a reason**.

They are declared rather than inferred, and that distinction is load-bearing. The checker resolves same-file helpers one level deep, and that is provably incomplete: `POST …/attachments` hides its multipart read inside `readUpload`'s `Effect.gen`, and the scanner cannot see through it. Two earlier drafts of the checker misreported that route — and `POST /signin/nostr` and the GitHub webhook — as bodiless.

If "no body read detected" auto-exempted a route, the failure mode would be a route silently skipping validation forever. **That is precisely the bug class this document exists to close, so the tool refuses to infer safety from silence** and makes a human say it once, in writing.

A declaration outranks detection in both directions: a route declared as unmigrated debt stays debt even when the scanner finds nothing, and only positive evidence of migration overrides the declaration.

## Migrating a route

1. Write the `Schema.Struct` for its body. Start from what the handler currently validates by hand.
2. Replace `readJsonBody` with `parseRouteBody`.
3. Delete the hand-rolled shape checks the schema now covers. Keep the authorization checks.
4. Remove the route from `boundary-allowlist.json`.
5. Run `npm run check:boundary` and `npm test`.

Existing behavior must not change except that previously-silent failures now return `400`. If a migration changes a status code or an error `reason` string, that is a separate decision needing its own ticket — say so rather than folding it in.

**A note for the first per-subsystem migration:** `readJsonBody` is currently defined *six times* — exported from `src/routes/errors.ts` and copy-pasted into five route files. Consolidating those into the one in `errors.ts` should be that migration's first move. It is the same drift this document is about, living inside the tooling the document describes.

## Query strings (EFB-71)

Everything above is about bodies. A query string is the same boundary with the same disease, and it went unnoticed a year longer because the API for reading one *looks* safe.

```ts
const status = c.req.query("status");
```

That reads a param. It cannot report an unknown one — not because it forgets to, but because it was never shown the rest of the query string. A handler reading seven params from a request carrying eight is blind to the eighth by construction.

The bug that filed this ticket:

```
GET /boards/evan-s-flow-board/issues?status_id=deadbeef&limit=3   → 200, 3 issues
GET /boards/evan-s-flow-board/issues?limit=3                      → 200, 3 issues
```

Identical. `status_id` is not a field — the real one is `column_id` — and the endpoint said yes anyway. The caller reasoned from a filtered-looking answer that had never been filtered, and got three diagnoses wrong before checking the field name.

### `parseRouteQuery`

Same file, same parse options, same reason grammar:

```ts
import { Schema } from "effect";
import { parseRouteQuery, QueryString } from "../lib/route-body";

const ListIssuesQuery = Schema.Struct({
  status: QueryString,
  container: QueryString,
  column_id: QueryString,
  limit: QueryString,
  after: QueryString,
});

// In the handler:
const q = yield* parseRouteQuery(c, ListIssuesQuery);
```

The load-bearing detail is that the wrapper reads the **whole** query string (`c.req.query()` with no argument). That is the only shape from which "you sent something I do not accept" is answerable at all.

Three things follow from query strings being untyped text:

- **Values are strings.** A param that must be a number is a string the schema constrains. The schema is mostly a list of *accepted keys*, and the key set is the point.
- **Policy stays in the handler.** `limit`'s ceiling, `container`'s vocabulary, `column_id`'s existence on this board, a cursor's stream agreement — all still named handler steps, exactly as the DB-free rule requires. The schema validates SHAPE.
- **Errors answer `invalid-query`, not `invalid-body`.** A `QueryValidationError` carries the same `<key>-unknown` reason grammar, under an envelope that doesn't send a GET's caller looking at a body they never wrote.

Repeated keys (`?status=a&status=b`) still collapse to the last value, unchanged from before. Rejecting them is the same class of tightening and is deliberately *not* bundled in — it is its own decision.

### The query CI check

```
npm run check:boundary-query
```

`scripts/check-boundary-query.mjs`, with `scripts/boundary-query-allowlist.json` as its ratchet. Same contract as the body check: sunsets fail rather than warn, 180-day horizon, new routes may not be added. It scans **every verb**, since a query string rides any request.

It shares `scripts/lib/route-scan.mjs` with the body check — handler location is identical work, and two copies would diverge on the first fix.

**One deliberate difference: there is no `noQuery` declaration list.** Applying the declare-don't-detect rule literally here would have meant ~50 declarations written in a single commit, because query params ride every verb rather than the body-bearing three. Fifty entries added in one sitting is not fifty routes read — it is a checkbox, and it is *worse* than honest silence, because it launders an inference into a human declaration that gets cited later as verification.

> **A declaration's evidentiary weight cannot exceed what the process that produced it could have earned.**

So the check states its blind spot instead of papering over it. Every successful run prints:

```
[boundary-query] 89 handler(s) had no detected query read — that is not proof they read none.
[boundary-query] 10 registration(s) use a non-literal path and are invisible to this scan entirely.
```

The `noQuery` declarations land in the per-subsystem migration tickets, where someone is actually reading the route. That is earned declaration rather than inherited.

### The check proves it can fail, on every run

`tests/boundary-query.test.ts` runs the checker against synthetic fixtures in `tests/fixtures/boundary-query/` and asserts a **non-zero exit** on an un-migrated handler and zero on a migrated one.

A check that has only ever been observed passing is indistinguishable from a check that cannot fail — if the marker list stops matching, or the registration regex silently misses every route, the output is a cheerful `OK` either way. Pinning the failure in a test makes the guard's own decay a red test instead of a quiet green one. Evidence stapled to a PR proves the check worked once; a test proves it still does.

## Related tickets

- **EFB-71** *(shipped)* — the same strict-unknown rule for query params. `parseRouteQuery`, the `check:boundary-query` ratchet, and `GET /boards/:slug/issues` as the reference migration. See the query-string section above.
- **EFB-53** — `PATCH /issues/:id` accepted unknown keys silently. Closed by construction when the reference route migrated; the strict-unknown tests in `tests/boundary-discipline.test.ts` are its regression guard.
- **EFB-58** *(shipped)* — typed provenance for identity references in signed-event contexts. Applied the `Provenance` struct to both signed-event builders that have an actor slot, and added the constructors. See the Provenance section above.
- **EFB-38 / EFB-42 / EFB-51** — the identity bugs `IdentityRefFromInput` exists to prevent.
- **EFB-33** — the attribution bug `Provenance` exists to prevent.

## Meta-lesson: the tool is a boundary too

The first two drafts of `check-boundary-discipline.mjs` silently exempted `POST /signin/nostr` and the GitHub webhook — two of the most security-sensitive routes in the app — because their body reads used accessors the checker's pattern list didn't name.

The checker was, in other words, a boundary that said "yes" when it should have said "no, and here's why". It had the exact defect it was written to find.

Generalize it as **declaration over detection**. Any detector's silence is ambiguous: it can mean "no violation here" or "my detection didn't reach here", and those are indistinguishable from the outside. Worse, the pattern list is an implicit contract — adding a new way to read a body silently exempts every route that adopts it. A declaration inverts that: the declaration is the evidence of intent, and the scanner's job shrinks to detecting *drift from what was declared*. Silence stops being load-bearing.

Apply the same suspicion to any tool that promises to protect you. Ask what its silence actually proves.

**It recurred while EFB-71 was being built.** The shared scanner resolves a same-file helper's body so a read hiding one level deep is still seen — but only for helpers written as `= (c) => { … }`. A helper written in the *concise* arrow form, `= (c) => Effect.gen(function* () { … })`, had its argument list captured and its body silently discarded. `requestedDays` in `sprints.ts` is written exactly that way and reads `c.req.query("days")`; both GET tide routes call it, and both were reported as reading no query at all.

Nobody found that by reviewing the scanner. It surfaced because a *second* check was pointed at the same machinery and the numbers didn't match what a human count of `grep -rn 'c.req.query'` produced. The generalizable move is the cheap one: **when you build a detector, compare its output against a dumber tool's output on the same input.** Where they disagree, the sophisticated one is usually the one that is wrong, and the disagreement is the only signal that a blind spot exists at all.
