// EFB-98: the two things about search that are testable WITHOUT FTS5.
//
// tests/dbMock.ts does not implement FTS5, and tests/search-query.test.ts
// explains at length why asserting ranking or indexing against the mock would
// assert the mock and nothing else — those claims live in
// tests/integration/search.test.ts against a real D1.
//
// What IS assertable here is everything that happens BEFORE the index is
// touched, which is exactly the part the action module's header calls the whole
// of the access control: the board gate runs first, and a query carrying no
// searchable term is answered without reading FTS at all. Neither test names a
// URL.

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  Jwt,
  JwtTest,
  JWT_TEST_CLAIMS,
  makeAuditLogTest,
  makeAudienceTest,
  makeBoardEmitterTest,
  type AppServices,
} from "../../src/effects";
import { searchBoard } from "../../src/actions/search";
import { actionInput } from "../../src/actions/types";
import { makeDbMock } from "../dbMock";
import { CALLER } from "../harness";

const makeDeps = () => {
  const db = makeDbMock();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtTest as Layer.Layer<Jwt>,
    db.layer,
    makeAuditLogTest().layer,
    makeBoardEmitterTest().layer,
    makeAudienceTest().layer,
  ) as unknown as Layer.Layer<AppServices>;
  return { db, layer };
};

const run = <A, E>(deps: ReturnType<typeof makeDeps>, program: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(Effect.provide(program as never, deps.layer));

/** A private board owned by someone else — invisible to our caller. */
const seedForeignBoard = (deps: ReturnType<typeof makeDeps>) => {
  deps.db.boards.push({
    id: "b1", pubkey: "someone:else", slug: "theirs", title: "Board", description: null,
    columns: JSON.stringify(["Todo", "Done"]), labels: "[]", member_policy: "invite",
    is_encrypted: 0, org_id: null, visibility: "private", created_at_ms: 1, updated_at_ms: 1,
  });
};

describe("search action", () => {
  it("refuses a board the caller cannot see, before any index read", async () => {
    const deps = makeDeps();
    seedForeignBoard(deps);

    const exit = await run(
      deps,
      searchBoard(
        actionInput(JWT_TEST_CLAIMS, { slug: "theirs" }, Effect.succeed({ q: "anything" }), { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("keeps the gate ahead of the body parse, so an invisible board is not a 400", async () => {
    // The order is load-bearing and cannot be seen from the outside: if the
    // parse ran first, this malformed-body-on-an-invisible-board case would
    // fail with the parse's ValidationError instead of the gate's failure, and
    // the wire answer would flip from 404 to 400. Yielding a failing body
    // Effect is how a test can tell which one ran.
    const deps = makeDeps();
    seedForeignBoard(deps);
    let parseRan = false;

    const exit = await run(
      deps,
      searchBoard(
        actionInput(
          JWT_TEST_CLAIMS,
          { slug: "theirs" },
          Effect.sync(() => {
            parseRan = true;
            return { q: "anything" };
          }), { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(parseRan).toBe(false);
  });

  it("answers a query with no searchable term as empty results, not a 400", async () => {
    // `???` carries no letter or digit run, so ftsMatchExpression returns null
    // and the action short-circuits — an answerable query with no matches
    // rather than a malformed request.
    const deps = makeDeps();
    deps.db.boards.push({
      id: "b1", pubkey: CALLER, slug: "kb", title: "Board", description: null,
      columns: JSON.stringify(["Todo", "Done"]), labels: "[]", member_policy: "invite",
      is_encrypted: 0, org_id: null, visibility: "public", created_at_ms: 1, updated_at_ms: 1,
    });

    // Anonymous, because a public board is searchable without signing in —
    // which is why the action takes a PublicActionInput.
    const exit = await run(
      deps,
      searchBoard(actionInput(null, { slug: "kb" }, Effect.succeed({ q: "???" }), { grants: null })),
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value).toEqual({ issues: [], comments: [] });
    }
  });
});
