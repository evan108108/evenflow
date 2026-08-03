// EFB-98: sprint behaviours asserted DIRECTLY against the actions.
//
// Not one of these tests names a URL. That is the point of the split, and it
// is pointed at this family in particular: the bug the whole ticket exists for
// was a coordinator POSTing `/boards/:slug/sprints/:id/issues` to attach a
// ticket while the server answered only `.../add-issue`. Every sprint test in
// tests/sprints.test.ts went through `h.app.request(url(...))`, so the suite
// asserted the same string the server used and could not have caught a client
// disagreeing with it.
//
// Routing is still proved, just separately and once: the manifest declares the
// URLs, check-rest-conventions enforces their shape, and tests/router.test.ts
// asserts the mount table.

import { Cause, Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ValidationError } from "../../src/lib/errors";

import {
  Jwt,
  JwtTest,
  JWT_TEST_CLAIMS,
  makeAuditLogTest,
  makeAudienceTest,
  makeBoardEmitterTest,
  type AppServices,
} from "../../src/effects";
import {
  attachSprintIssue,
  completeSprint,
  createSprint,
  deleteSprint,
  detachSprintIssue,
  listSprints,
  startSprint,
} from "../../src/actions/sprints";
import { actionInput } from "../../src/actions/types";
import { makeDbMock } from "../dbMock";
import { CALLER } from "../harness";

/** A layer with just the services the sprint actions ask for. */
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

/** Seed a board the caller owns. */
const seedBoard = (deps: ReturnType<typeof makeDeps>) => {
  deps.db.boards.push({
    id: "b1", pubkey: CALLER, slug: "kb", title: "Board", description: null,
    columns: JSON.stringify(["Todo", "Done"]), labels: "[]", member_policy: "invite",
    is_encrypted: 0, org_id: null, visibility: "private", created_at_ms: 1, updated_at_ms: 1,
  });
};

/** One issue on the seeded board, in the backlog by default. */
const seedIssue = (
  deps: ReturnType<typeof makeDeps>,
  id: string,
  over: Record<string, unknown> = {},
) => {
  deps.db.issues.push({
    id, board_id: "b1", title: `Issue ${id}`, body: null, status: "Todo",
    container: "backlog", assignee_pubkey: null, priority: null, estimate: null,
    labels: "[]", github_links: "[]", sprint_id: null,
    created_at_ms: 1, updated_at_ms: 1, completed_at_ms: null, ...over,
  });
};

/** A sprint on the seeded board. */
const seedSprint = (
  deps: ReturnType<typeof makeDeps>,
  id: string,
  over: Record<string, unknown> = {},
) => {
  deps.db.sprints.push({
    id, board_id: "b1", name: `Sprint ${id}`, goal: null, status: "planning",
    planned_days: null, started_at_ms: null, completed_at_ms: null, created_at_ms: 1,
    points_committed_start: null, points_completed: null, points_carried: null,
    adds_mid_sprint: 0, substrate_event_id: null, ...over,
  });
};

/** The board slug is business input to every sprint action — it addresses the board. */
const onBoard = (params: Record<string, string> = {}) => ({ slug: "kb", ...params });

/**
 * A body the action will yield rather than receive already-decoded.
 *
 * Every body-bearing sprint route defers its parse so the gate that used to
 * run before it still does (see DeferredBody in src/actions/sprints.ts). A
 * test supplies the parsed value directly, which is the same shape the route's
 * `parseRouteBody(...)` produces on success.
 */
const parsed = <A>(body: A) => Effect.succeed(body);

/**
 * A body whose parse FAILS — the instrument for proving a deferral.
 *
 * If an action yields the body earlier than it should, this reason is the one
 * that comes back; the ordering tests below assert the gate's reason instead.
 * A failing body is better than a flag here because it pins WHICH answer the
 * caller gets, which is the thing the deferral protects.
 */
const unparseable = () => Effect.fail(new ValidationError({ reason: "bad-body" }));

/** The `reason` off a failed action, or null if it did not fail that way. */
const reasonOf = (exit: Exit.Exit<unknown, unknown>): string | null => {
  if (!Exit.isFailure(exit)) return null;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) return null;
  return (failure.value as { reason?: string }).reason ?? null;
};

describe("sprint actions", () => {
  it("creates a planning sprint on a board the caller can contribute to", async () => {
    const deps = makeDeps();
    seedBoard(deps);

    const exit = await run(
      deps,
      createSprint(actionInput(JWT_TEST_CLAIMS, onBoard(), parsed({ name: "S1" }))),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.db.sprints).toHaveLength(1);
    // Always planning, whatever the caller sent — status is not a writable field.
    expect(deps.db.sprints[0]!["status"]).toBe("planning");
    expect(deps.audit.events.some((e) => e.event_type === "sprint_created")).toBe(true);
  });

  it("promotes backlog members to active on start, and snapshots the committed points", async () => {
    const deps = makeDeps();
    seedBoard(deps);
    seedSprint(deps, "s1");
    seedIssue(deps, "i1", { sprint_id: "s1", estimate: 3 });

    const exit = await run(
      deps,
      startSprint(actionInput(JWT_TEST_CLAIMS, onBoard({ id: "s1" }), undefined)),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.db.issues[0]!["container"]).toBe("active");
    expect(deps.db.sprints[0]!["status"]).toBe("active");
    // The snapshot is what makes the later reads a cheap SELECT rather than a
    // derivation, so it is the thing worth pinning.
    expect(deps.db.sprints[0]!["points_committed_start"]).toBe(3);
  });

  it("refuses to start a sprint that is not in planning", async () => {
    const deps = makeDeps();
    seedBoard(deps);
    seedSprint(deps, "s1", { status: "active", started_at_ms: 5 });

    const exit = await run(
      deps,
      startSprint(actionInput(JWT_TEST_CLAIMS, onBoard({ id: "s1" }), undefined)),
    );

    expect(exit._tag).toBe("Failure");
    expect(deps.db.sprints[0]!["started_at_ms"]).toBe(5);
  });

  it("attaches an issue to a sprint — the behaviour the wrong URL hid", async () => {
    // The membership pair is why EFB-98 exists. Asserted here without naming
    // either the old path or the new one: what is being proved is that the
    // issue joins the sprint and the audit trail records it.
    const deps = makeDeps();
    seedBoard(deps);
    seedSprint(deps, "s1");
    seedIssue(deps, "i1");

    const exit = await run(
      deps,
      attachSprintIssue(
        actionInput(JWT_TEST_CLAIMS, onBoard({ id: "s1" }), parsed({ issue_id: "i1" })),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.db.issues[0]!["sprint_id"]).toBe("s1");
    expect(deps.db.sprintMemberships).toHaveLength(1);
    expect(deps.db.sprintMemberships[0]!["removed_at_ms"]).toBeNull();
  });

  it("auto-promotes a backlog issue attached mid-sprint to the ACTIVE sprint", async () => {
    const deps = makeDeps();
    seedBoard(deps);
    seedSprint(deps, "s1", { status: "active", started_at_ms: 5 });
    seedIssue(deps, "i1");

    const exit = await run(
      deps,
      attachSprintIssue(
        actionInput(JWT_TEST_CLAIMS, onBoard({ id: "s1" }), parsed({ issue_id: "i1" })),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.db.issues[0]!["container"]).toBe("active");
    expect(deps.db.sprints[0]!["adds_mid_sprint"]).toBe(1);
    // The promotion is a container change, so it leaves a statusChangeCache row
    // for the publish path to sign against (EFB-91).
    expect(deps.db.statusChanges).toHaveLength(1);
  });

  it("detaches by stamping the open membership row, reading the issue id off the path", async () => {
    // detach takes its issue id from `params`, attach from the body. The action
    // reads both defensively because it is reached from two route
    // registrations whose params differ.
    const deps = makeDeps();
    seedBoard(deps);
    seedSprint(deps, "s1");
    seedIssue(deps, "i1", { sprint_id: "s1" });
    deps.db.sprintMemberships.push({
      id: "m1", sprint_id: "s1", issue_id: "i1", added_at_ms: 1,
      removed_at_ms: null, was_completed_in_sprint: 0, carried_to_sprint_id: null,
    });

    const exit = await run(
      deps,
      detachSprintIssue(
        actionInput(JWT_TEST_CLAIMS, onBoard({ id: "s1", issue_id: "i1" }), undefined),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.db.issues[0]!["sprint_id"]).toBeNull();
    // Stamped, not deleted — the history survives the detachment.
    expect(deps.db.sprintMemberships).toHaveLength(1);
    expect(deps.db.sprintMemberships[0]!["removed_at_ms"]).not.toBeNull();
  });

  it("refuses to delete a sprint that has already started", async () => {
    const deps = makeDeps();
    seedBoard(deps);
    seedSprint(deps, "s1", { status: "active", started_at_ms: 5 });

    const exit = await run(
      deps,
      deleteSprint(actionInput(JWT_TEST_CLAIMS, onBoard({ id: "s1" }), undefined)),
    );

    expect(exit._tag).toBe("Failure");
    // Deleting it would destroy the audit trail velocity reads from.
    expect(deps.db.sprints).toHaveLength(1);
  });

  // ── the deferred parses (rule 10) ──────────────────────────────────────
  //
  // Every body-bearing route in this family gated before it parsed, so the
  // shell hands the parse over un-run and the action yields it where the parse
  // used to sit. That ordering is invisible from the outside and nothing
  // pinned it before, which is exactly how the equivalent flip went unnoticed
  // in the pattern commit. These two tests make it fail loudly.

  it("answers the 409 on a non-active sprint without parsing the body", async () => {
    const deps = makeDeps();
    seedBoard(deps);
    seedSprint(deps, "s1"); // planning, so complete must conflict

    const exit = await run(
      deps,
      completeSprint(actionInput(JWT_TEST_CLAIMS, onBoard({ id: "s1" }), unparseable())),
    );

    // `sprint-planning`, not `bad-body`: if the parse ran first this would be a
    // 400 about the body instead of the 409 this route has always answered.
    expect(reasonOf(exit)).toBe("sprint-planning");
  });

  it("answers the board gate before parsing, on a board the caller cannot see", async () => {
    const deps = makeDeps();
    deps.db.boards.push({
      id: "b1", pubkey: "someone:else", slug: "kb", title: "Board", description: null,
      columns: JSON.stringify(["Todo", "Done"]), labels: "[]", member_policy: "invite",
      is_encrypted: 0, org_id: null, visibility: "private", created_at_ms: 1, updated_at_ms: 1,
    });

    const exit = await run(
      deps,
      createSprint(actionInput(JWT_TEST_CLAIMS, onBoard(), unparseable())),
    );

    // The gate's reason, so the wire answer stays 404 rather than becoming 400.
    expect(reasonOf(exit)).toBe("board");
  });

  it("lists sprints anonymously on a public board, because listSprints takes a nullable caller", async () => {
    // The auth posture is visible in the signature: listSprints accepts a
    // PublicActionInput, so passing null here is a case it has to handle
    // rather than something that happens to work.
    const deps = makeDeps();
    seedBoard(deps);
    deps.db.boards[0]!["visibility"] = "public";
    seedSprint(deps, "s1");

    const exit = await run(deps, listSprints(actionInput(null, onBoard(), undefined)));

    expect(exit._tag).toBe("Success");
  });
});
