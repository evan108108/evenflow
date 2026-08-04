// EFB-98 fan-out A: the issue actions, tested DIRECTLY.
//
// Same posture as tests/actions/comments.test.ts — every test here proves a
// behaviour without naming a URL, because that is the point of the split. The
// route strings are proved once and separately by the manifest, its checker and
// tests/router.test.ts; a behaviour test does not re-assert any of them.
//
// The ordering test below is the one that earned its place. Nothing in the
// suite pinned it before, and the migration very nearly flipped it.

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
import { ValidationError } from "../../src/lib/errors";
import {
  createIssue,
  getIssue,
  setIssueContainer,
  transitionIssue,
  updateIssue,
} from "../../src/actions/issues";
import { actionInput } from "../../src/actions/types";
import { makeDbMock } from "../dbMock";
import { CALLER } from "../harness";

/** A layer with just the services the issue actions ask for. */
const makeDeps = () => {
  const db = makeDbMock();
  const audit = makeAuditLogTest();
  const emitter = makeBoardEmitterTest();
  const audience = makeAudienceTest();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtTest as Layer.Layer<Jwt>,
    db.layer,
    audit.layer,
    emitter.layer,
    audience.layer,
  ) as unknown as Layer.Layer<AppServices>;
  return { db, audit, emitter, layer };
};

const run = <A, E>(deps: ReturnType<typeof makeDeps>, program: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(Effect.provide(program as never, deps.layer));

const COLUMNS = JSON.stringify([
  { id: "col-todo", name: "Todo", order: 0, enabled: true, category: "todo" },
  { id: "col-done", name: "Done", order: 1, enabled: true, category: "done" },
]);

/** Seed a board the caller owns. `pubkey` decides whether they can see it. */
const seedBoard = (deps: ReturnType<typeof makeDeps>, pubkey: string = CALLER) => {
  deps.db.boards.push({
    id: "b1", pubkey, slug: "kb", title: "Board", description: null,
    columns: COLUMNS, labels: "[]", member_policy: "invite", is_encrypted: 0,
    issue_prefix: "KB", next_issue_number: 1, org_id: null, visibility: "private",
    created_at_ms: 1, updated_at_ms: 1,
  });
};

const seedIssue = (deps: ReturnType<typeof makeDeps>, over: Record<string, unknown> = {}) => {
  deps.db.issues.push({
    id: "i1", short_id: "KB-1", board_id: "b1", title: "An issue", body: null,
    body_format: "markdown", type: "task", status: "Todo", column_id: "col-todo",
    container: "backlog", assignee_pubkey: null, priority: null, estimate: null,
    labels: "[]", github_links: "[]", position: 1000, sprint_id: null,
    external_state: null, external_state_updated_at_ms: null,
    created_at_ms: 1, updated_at_ms: 1, completed_at_ms: null,
    substrate_event_id: null, duplicate_of_issue_id: null,
    ...over,
  });
};

describe("issue actions", () => {
  it("creates an issue on a board the caller can contribute to", async () => {
    const deps = makeDeps();
    seedBoard(deps);

    const exit = await run(
      deps,
      createIssue(
        actionInput(JWT_TEST_CLAIMS, { slug: "kb" }, Effect.succeed({ title: "first" } as never), { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.db.issues).toHaveLength(1);
    expect(deps.db.issues[0]!["title"]).toBe("first");
    expect(deps.audit.events.some((e) => e.event_type === "issue_created")).toBe(true);
  });

  // ── the rule-10 pin ─────────────────────────────────────────────────────
  //
  // createIssue resolves the board BEFORE it parses the body, and that order is
  // observable: a malformed body aimed at a board the caller cannot see answers
  // 404 `board`, not 400. Parsing in the HTTP shell — the obvious way to write
  // the migration, and what this branch did at first — flips it to 400 and
  // leaks the board's existence to anyone willing to send junk.
  //
  // BOUNDARY_DISCIPLINE.md:244 puts that on the wrong side of the line: a
  // migration may turn a previously-SILENT failure into a 400, but a 404 that
  // is already the loud, correct answer may not change without its own ticket.
  //
  // Falsification: `yield*` the body above resolveBoardScope in createIssue and
  // this test goes red while every other test in the suite stays green — which
  // is exactly why it exists.
  it("answers the board gate, not the body parse, when both would fail", async () => {
    const deps = makeDeps();
    // A board owned by somebody else, so the caller cannot see it.
    seedBoard(deps, "someone:else");

    const exit = await run(
      deps,
      createIssue(
        actionInput(
          JWT_TEST_CLAIMS,
          { slug: "kb" },
          // A parse that would fail if it ever ran.
          Effect.fail(new ValidationError({ reason: "expected-json" })) as never, { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    const failure = exit._tag === "Failure" ? JSON.stringify(exit.cause) : "";
    // The gate's answer, not the parse's.
    expect(failure).not.toContain("expected-json");
    expect(deps.db.issues).toHaveLength(0);
  });

  it("reads an issue anonymously, because getIssue takes a nullable caller", async () => {
    // The auth posture is visible in the signature: getIssue accepts a
    // PublicActionInput, so passing null here is a case it has to handle
    // rather than something that happens to work.
    const deps = makeDeps();
    seedBoard(deps);
    deps.db.boards[0]!["visibility"] = "public";
    seedIssue(deps);

    const exit = await run(deps, getIssue(actionInput(null, { id: "i1" }, undefined, { grants: null, query: {} })));

    expect(exit._tag).toBe("Success");
  });

  it("rejects an unknown ?include rather than silently ignoring it", async () => {
    const deps = makeDeps();
    seedBoard(deps);
    seedIssue(deps);

    const exit = await run(
      deps,
      getIssue(
        actionInput(JWT_TEST_CLAIMS, { id: "i1" }, undefined, { query: { include: "sprints" } }, { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("refuses a duplicate-of pointer that would close a loop", async () => {
    const deps = makeDeps();
    seedBoard(deps);
    seedIssue(deps);
    // i2 already points at i1, so pointing i1 at i2 closes the ring.
    seedIssue(deps, { id: "i2", short_id: "KB-2", duplicate_of_issue_id: "i1" });

    const exit = await run(
      deps,
      updateIssue(
        actionInput(JWT_TEST_CLAIMS, { id: "i1" }, { duplicate_of_issue_id: "i2" } as never, { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(deps.db.issues[0]!["duplicate_of_issue_id"]).toBeNull();
  });

  it("addresses a column by id in preference to the legacy status name", async () => {
    const deps = makeDeps();
    seedBoard(deps);
    seedIssue(deps);

    const exit = await run(
      deps,
      transitionIssue(
        // Both spellings present and disagreeing: column_id has to win.
        actionInput(JWT_TEST_CLAIMS, { id: "i1" }, { column_id: "col-done", to: "Todo" } as never, { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.db.issues[0]!["status"]).toBe("Done");
  });

  it("publishes nothing when a container move is a no-op", async () => {
    // Idempotence is the documented contract, and the emit guard is what makes
    // it observable: re-sending backlog → backlog must not put a second
    // container_changed on the wire for a card that did not move.
    const deps = makeDeps();
    seedBoard(deps);
    seedIssue(deps);
    const before = deps.emitter.events.length;

    const exit = await run(
      deps,
      setIssueContainer(actionInput(JWT_TEST_CLAIMS, { id: "i1" }, { container: "backlog" } as never, { grants: null })),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.emitter.events.length).toBe(before);
  });
});
