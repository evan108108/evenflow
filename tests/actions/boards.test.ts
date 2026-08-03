// EFB-98: board behaviours proved by calling the action DIRECTLY.
//
// Not one test in this file names a URL. That is the point of the split — the
// old shape of these assertions went through `h.app.request("/api/v0/board/…")`,
// so the test depended on the same string the client depended on, and a client
// and a server could disagree about a path while the suite stayed green.
// Routing is proved separately and once: the manifest declares the URLs,
// check-rest-conventions enforces their shape, and tests/router.test.ts asserts
// the mount table.
//
// The two cases worth having here beyond CRUD are the ones the family gotcha
// is about: `orgSlug` reaching the action as BUSINESS INPUT. `createBoard`
// branches on its presence, and until EFB-98 that branch read a Context, which
// meant it could not be exercised without standing up a router on the right
// mount. Both arms are now one function call each.

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  Jwt,
  JwtTest,
  JWT_TEST_CLAIMS,
  makeAuditLogTest,
  makeAudienceTest,
  makeBoardEmitterTest,
  makeFourATest,
  type AppServices,
} from "../../src/effects";
import {
  boardVelocity,
  createBoard,
  deleteBoard,
  getBoard,
  listBoards,
  setBoardArchived,
  updateBoard,
} from "../../src/actions/boards";
import { actionInput } from "../../src/actions/types";
import { makeDbMock } from "../dbMock";
import { CALLER } from "../harness";

/** A layer with just the services the board actions ask for. */
const makeDeps = () => {
  const db = makeDbMock();
  const audit = makeAuditLogTest();
  const emitter = makeBoardEmitterTest();
  const audience = makeAudienceTest();
  const foura = makeFourATest();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtTest as Layer.Layer<Jwt>,
    db.layer,
    audit.layer,
    emitter.layer,
    audience.layer,
    foura.layer,
  ) as unknown as Layer.Layer<AppServices>;
  return { db, audit, emitter, audience, foura, layer };
};

const run = <A, E>(deps: ReturnType<typeof makeDeps>, program: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(Effect.provide(program as never, deps.layer));

/** An org the caller owns, so both create arms have somewhere to land. */
const seedOrg = (deps: ReturnType<typeof makeDeps>) => {
  deps.db.orgs.push({
    id: "o1", slug: "acme", display_name: "Acme", avatar_url: null, bio: null,
    kind: "team", created_by: CALLER, substrate_event_id: null,
    created_at_ms: 1, updated_at_ms: 1, deleted_at_ms: null,
  });
  deps.db.orgMembers.push({
    org_id: "o1", pubkey: CALLER, role: "owner", added_by: CALLER, added_at_ms: 1,
    substrate_event_id: null,
  });
};

const seedBoard = (deps: ReturnType<typeof makeDeps>, over: Record<string, unknown> = {}) => {
  deps.db.boards.push({
    id: "b1", pubkey: CALLER, slug: "kb", title: "Board", description: null,
    columns: JSON.stringify(["Todo", "Done"]),
    labels: "[]", member_policy: "invite", is_encrypted: 0, org_id: "o1",
    visibility: "private", issue_prefix: "KB", next_issue_number: 1,
    default_sprint_days: 14, done_window_days: 14, archived_at_ms: null,
    created_at_ms: 1, updated_at_ms: 1, ...over,
  });
  deps.db.boardMembers.push({
    board_id: "b1", pubkey: CALLER, role: "owner", added_by: CALLER, added_at_ms: 1,
    substrate_event_id: null,
  });
};

describe("board actions", () => {
  // ── the family gotcha: orgSlug is business input, and it branches ───────

  it("creates inside the named org when orgSlug is present", async () => {
    const deps = makeDeps();
    seedOrg(deps);

    const exit = await run(
      deps,
      createBoard(
        actionInput(JWT_TEST_CLAIMS, {}, { slug: "new", title: "New board" }, {
          orgSlug: "acme",
          token: "t",
        }),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.db.boards).toHaveLength(1);
    // The board landed in the org that was NAMED, not in a personal one.
    expect(deps.db.boards[0]!["org_id"]).toBe("o1");
    expect(deps.db.orgs).toHaveLength(1);
  });

  it("ensures a personal org when orgSlug is null — the bare mount", async () => {
    // Same action, same caller, one field different. Before the split this
    // arm could only be reached by mounting the router at a different prefix.
    const deps = makeDeps();

    const exit = await run(
      deps,
      createBoard(
        actionInput(JWT_TEST_CLAIMS, {}, { slug: "solo", title: "Solo board" }, { token: "t" }),
      ),
    );

    expect(exit._tag).toBe("Success");
    // A personal org was minted rather than a named one being looked up.
    expect(deps.db.orgs).toHaveLength(1);
    expect(deps.db.orgs[0]!["kind"]).toBe("personal");
    expect(deps.db.boards[0]!["org_id"]).toBe(deps.db.orgs[0]!["id"]);
  });

  it("refuses a slug already used inside the same org", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedBoard(deps);

    const exit = await run(
      deps,
      createBoard(
        actionInput(JWT_TEST_CLAIMS, {}, { slug: "kb", title: "Clash" }, {
          orgSlug: "acme",
          token: "t",
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    // The conflict is discovered before anything is written.
    expect(deps.db.boards).toHaveLength(1);
  });

  // ── reads ───────────────────────────────────────────────────────────────

  it("reads a public board anonymously, because getBoard takes a nullable caller", async () => {
    // The auth posture is visible in the signature: getBoard accepts a
    // PublicActionInput, so passing null is a case it has to handle rather
    // than something that happens to work.
    const deps = makeDeps();
    seedOrg(deps);
    seedBoard(deps, { visibility: "public" });

    const exit = await run(
      deps,
      getBoard(actionInput(null, { slug: "kb" }, undefined, { orgSlug: "acme" })),
    );

    expect(exit._tag).toBe("Success");
  });

  it("does not leak a private board to an anonymous caller", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedBoard(deps);

    const exit = await run(
      deps,
      getBoard(actionInput(null, { slug: "kb" }, undefined, { orgSlug: "acme" })),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("rejects a limit that is not a positive integer", async () => {
    // `limit` is a query param, which is HTTP — and also business input. It
    // arrives as a field, so the rule is testable without a query string.
    const deps = makeDeps();
    seedOrg(deps);
    seedBoard(deps);

    const exit = await run(
      deps,
      listBoards(actionInput(JWT_TEST_CLAIMS, {}, undefined, { query: { limit: "0" } })),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("hides archived boards from the list unless include_archived=1", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedBoard(deps, { archived_at_ms: 5 });

    const hidden = await run(
      deps,
      listBoards(actionInput(JWT_TEST_CLAIMS, {}, undefined, { query: {} })),
    );
    const shown = await run(
      deps,
      listBoards(
        actionInput(JWT_TEST_CLAIMS, {}, undefined, { query: { include_archived: "1" } }),
      ),
    );

    expect(hidden._tag).toBe("Success");
    expect(shown._tag).toBe("Success");
    const boardsOf = (e: typeof hidden) =>
      e._tag === "Success" ? (e.value as { boards: unknown[] }).boards : [];
    expect(boardsOf(hidden)).toHaveLength(0);
    expect(boardsOf(shown)).toHaveLength(1);
  });

  it("falls back to the board's own window when ?days is nonsense", async () => {
    // Verbatim behaviour: an unparseable `days` is IGNORED rather than 400,
    // and the response echoes the window actually used.
    const deps = makeDeps();
    seedOrg(deps);
    seedBoard(deps, { visibility: "public", done_window_days: 30 });

    const exit = await run(
      deps,
      boardVelocity(
        actionInput(null, { slug: "kb" }, undefined, {
          query: { days: "banana" },
          orgSlug: "acme",
        }),
      ),
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect((exit.value as { window_days: number }).window_days).toBe(30);
    }
  });

  // ── mutations ───────────────────────────────────────────────────────────

  it("refuses to rename the issue prefix once issues exist", async () => {
    // Paired with the case below so this cannot pass for the wrong reason: a
    // 404 on the board would also leave `issue_prefix` untouched. The ONLY
    // difference between the two is next_issue_number.
    const deps = makeDeps();
    seedOrg(deps);
    seedBoard(deps, { next_issue_number: 4 });

    const exit = await run(
      deps,
      updateBoard(
        actionInput(JWT_TEST_CLAIMS, { slug: "kb" }, { issue_prefix: "NEW" }, { orgSlug: "acme" }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    // 409 prefix-locked-issues-exist — the row is untouched.
    expect(deps.db.boards[0]!["issue_prefix"]).toBe("KB");
  });

  it("renames the prefix freely while the board has no issues yet", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedBoard(deps, { next_issue_number: 1 });

    const exit = await run(
      deps,
      updateBoard(
        actionInput(JWT_TEST_CLAIMS, { slug: "kb" }, { issue_prefix: "new" }, { orgSlug: "acme" }),
      ),
    );

    expect(exit._tag).toBe("Success");
    // Upper-cased on the way in — validatePrefix is a transform, not a shape,
    // which is why it stays a handler check rather than moving into the schema.
    expect(deps.db.boards[0]!["issue_prefix"]).toBe("NEW");
  });

  it("archives and unarchives through the same action, opposite flags", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedBoard(deps);

    const archived = await run(
      deps,
      setBoardArchived(true)(
        actionInput(JWT_TEST_CLAIMS, { slug: "kb" }, undefined, { orgSlug: "acme" }),
      ),
    );
    expect(archived._tag).toBe("Success");
    expect(deps.db.boards[0]!["archived_at_ms"]).not.toBeNull();

    const cleared = await run(
      deps,
      setBoardArchived(false)(
        actionInput(JWT_TEST_CLAIMS, { slug: "kb" }, undefined, { orgSlug: "acme" }),
      ),
    );
    expect(cleared._tag).toBe("Success");
    expect(deps.db.boards[0]!["archived_at_ms"]).toBeNull();
    expect(
      deps.audit.events.filter((e) =>
        ["board_archived", "board_unarchived"].includes(e.event_type),
      ),
    ).toHaveLength(2);
  });

  it("deletes the board and its memberships, and emits the tombstone", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedBoard(deps);

    const exit = await run(
      deps,
      deleteBoard(actionInput(JWT_TEST_CLAIMS, { slug: "kb" }, undefined, { orgSlug: "acme" })),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.db.boards).toHaveLength(0);
    expect(deps.db.boardMembers).toHaveLength(0);
    // EFB-32: the 30550 has to be retired, and it is emitted from the
    // pre-delete snapshot — an emit that re-read the row would find it gone.
    expect(deps.emitter.events.some((e) => e.event.kind === "board.deleted")).toBe(true);
  });
});
