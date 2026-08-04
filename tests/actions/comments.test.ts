// EFB-98: the worked example of testing an action DIRECTLY.
//
// Every test in this file proves a behaviour without naming a URL. That is the
// point of the split. The old shape of these tests went through
// `h.app.request("/api/v0/issues/…/comments", …)`, which meant the assertion
// depended on the same string the client depended on — so a client and a
// server could disagree about a path while the suite stayed green. That is
// exactly how the sprint-attach bug survived.
//
// Routing is still proved, just separately and once: the manifest declares the
// URLs, check-rest-conventions enforces their shape, and tests/router.test.ts
// asserts the mount table. A behaviour test does not need to re-assert any of
// it.

import { Cause, Effect, Exit, Layer, Option } from "effect";
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
import {
  PostCommentBody,
  ValidationError,
  createComment,
  deleteComment,
  listComments,
} from "../../src/actions/comments";
import { actionInput } from "../../src/actions/types";
import { makeDbMock } from "../dbMock";
import { CALLER } from "../harness";

/** A layer with just the services the comment actions ask for. */
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

/**
 * createComment takes its body UNPARSED — a lazy Effect the action yields after
 * the issue lookup (rule 10) — so a test hands it the same shape the route
 * does: an Effect, not a value.
 */
const bodyOf = (value: typeof PostCommentBody.Type) => Effect.succeed(value);

/**
 * A body whose parse FAILS. Lazy, so it only fails if something yields it —
 * which is the whole point: if the parse still ran first, this reason would be
 * the one that surfaced.
 */
const unparseableBody = Effect.fail(new ValidationError({ reason: "nope-unknown" }));

/** The `reason` a failed action carried, whatever tagged class it used. */
const failureReasonOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const f = Cause.failureOption(exit.cause);
  return Option.isSome(f) ? (f.value as { reason?: string }).reason : undefined;
};

/** Seed a board the caller owns, plus one issue on it. */
const seedBoardAndIssue = (deps: ReturnType<typeof makeDeps>) => {
  deps.db.boards.push({
    id: "b1", pubkey: CALLER, slug: "kb", title: "Board", description: null,
    columns: JSON.stringify(["Todo", "Done"]), labels: "[]", member_policy: "invite",
    is_encrypted: 0, org_id: null, visibility: "private", created_at_ms: 1, updated_at_ms: 1,
  });
  deps.db.issues.push({
    id: "i1", board_id: "b1", title: "An issue", body: null, status: "Todo",
    container: "backlog", assignee_pubkey: null, priority: null, estimate: null,
    labels: "[]", github_links: "[]", created_at_ms: 1, updated_at_ms: 1, completed_at_ms: null,
  });
};

describe("comment actions", () => {
  it("creates a comment on an issue the caller can contribute to", async () => {
    const deps = makeDeps();
    seedBoardAndIssue(deps);

    const exit = await run(
      deps,
      createComment(
        actionInput(JWT_TEST_CLAIMS, { id: "i1" }, bodyOf({ body: "first" }), { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.db.comments).toHaveLength(1);
    expect(deps.db.comments[0]!["body"]).toBe("first");
    expect(deps.audit.events.some((e) => e.event_type === "comment_created")).toBe(true);
  });

  it("404s an issue that does not exist, without touching the database", async () => {
    const deps = makeDeps();
    seedBoardAndIssue(deps);

    const exit = await run(
      deps,
      createComment(actionInput(JWT_TEST_CLAIMS, { id: "nope" }, bodyOf({ body: "x" }), { grants: null })),
    );

    expect(exit._tag).toBe("Failure");
    expect(deps.db.comments).toHaveLength(0);
  });

  it("answers the missing issue, not the malformed body, when both are wrong", async () => {
    // RULE 10 / BOUNDARY_DISCIPLINE.md:244. The pre-split handler looked the
    // issue up BEFORE parsing, so a bad body aimed at an issue you cannot see
    // is a 404 about the issue — it does not leak that the body was also
    // wrong, and more importantly it does not silently become a 400 because a
    // refactor moved the parse earlier.
    //
    // Nothing pinned this before; the flip was introduced by the action split
    // and caught only because worker B hit the same shape in another family.
    const deps = makeDeps();
    seedBoardAndIssue(deps);

    const exit = await run(
      deps,
      createComment(
        actionInput(
          JWT_TEST_CLAIMS,
          { id: "no-such-issue" },
          unparseableBody, { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    const reason = failureReasonOf(exit);
    expect(reason).toBe("issue");
    expect(reason).not.toBe("nope-unknown");
  });

  it("refuses to delete someone else's comment", async () => {
    const deps = makeDeps();
    seedBoardAndIssue(deps);
    deps.db.comments.push({
      id: "c1", issue_id: "i1", author_pubkey: "someone:else", body: "theirs",
      body_format: "markdown", in_reply_to: null, created_at_ms: 1, substrate_event_id: null,
    });

    const exit = await run(deps, deleteComment(actionInput(JWT_TEST_CLAIMS, { id: "c1" }, undefined, { grants: null })));

    expect(exit._tag).toBe("Failure");
    // Still there — a refused delete must not have removed the row on its way
    // to discovering the author mismatch.
    expect(deps.db.comments).toHaveLength(1);
  });

  it("reads a thread anonymously, because listComments takes a nullable caller", async () => {
    // The auth posture is visible in the signature: listComments accepts a
    // PublicActionInput, so passing null here is a case it has to handle
    // rather than something that happens to work.
    const deps = makeDeps();
    seedBoardAndIssue(deps);
    deps.db.boards[0]!["visibility"] = "public";

    const exit = await run(
      deps,
      listComments(actionInput(null, { id: "i1" }, undefined, { grants: null, query: {} })),
    );

    expect(exit._tag).toBe("Success");
  });
});
