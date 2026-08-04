// EFB-98 rule 10 — the gate/parse ORDER, pinned.
//
// This is the regression class worker-5 found in three unrelated families with
// no test covering it, and the reason it hid is worth stating: the migrated
// code reads as parse-first no matter what the original did, so a reviewer
// comparing the new file against itself sees nothing wrong. The flip is only
// visible against the PRE-SPLIT handler, or from a test like this one.
//
// What the split can silently change: a handler that proved board access
// BEFORE reading the body answers 401/403/404 to a caller who cannot see the
// board, whatever they sent. Parse first and the same request answers 400
// instead. Both look reasonable in isolation; only one is what shipped.
//
// So each test below hands the action a body reader that is GUARANTEED to
// fail, aims it at a board that does not exist, and asserts the caller still
// gets the ACCESS answer. If the deferral is removed — `yield* input.body`
// hoisted above the gate, or the route awaiting the parse before it calls the
// action — the failure tag flips to ValidationError and these go red. I
// verified that by doing it, not by assuming it; see the file's own note in
// src/actions/*.ts on why the reader is passed unevaluated.
//
// No URL is named anywhere in this file. That is the point of the split: the
// ordering is a property of the action, and proving it does not require
// agreeing with the client about a path.

import { Effect, Exit, Cause, Layer, Option } from "effect";
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
import { actionInput } from "../../src/actions/types";
import { createWebhook, updateWebhook } from "../../src/actions/webhooks";
import { setGithubConfig, setGithubRules, testGithubConnection } from "../../src/actions/github";
import { createAttachment, updateAttachment } from "../../src/actions/attachments";
import { makeDbMock } from "../dbMock";

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

/** The `_tag` of the failure an action actually raised. */
const failureTag = (exit: Exit.Exit<unknown, unknown>): string => {
  if (!Exit.isFailure(exit)) return "Success";
  const f = Cause.failureOption(exit.cause);
  return Option.isSome(f) ? String((f.value as { _tag?: string })._tag ?? "unknown") : "defect";
};

/**
 * A reader that always fails. Standing in for a malformed body: if the action
 * ever yields it, the test sees ValidationError and knows the parse ran.
 */
const poisonBody = () =>
  Effect.fail(new ValidationError({ reason: "parse-ran-too-early" })) as Effect.Effect<
    never,
    ValidationError,
    never
  >;

/** A board slug nothing seeds, so the scope lookup must refuse. */
const NO_SUCH_BOARD = { slug: "no-such-board" };

describe("EFB-98 rule 10 — the access gate runs before the body is read", () => {
  it("webhook.create refuses an unreachable board without reading the body", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      createWebhook(
        actionInput(JWT_TEST_CLAIMS, NO_SUCH_BOARD, poisonBody(), { grants: null, orgSlug: null }),
        "master-secret",
      ),
    );
    expect(failureTag(exit)).toBe("BoardOwnershipError");
  });

  it("webhook.update refuses an unreachable board without reading the body", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      updateWebhook(
        actionInput(JWT_TEST_CLAIMS, { ...NO_SUCH_BOARD, id: "sub-1" }, poisonBody(), {
          grants: null,
          orgSlug: null,
        }),
      ),
    );
    expect(failureTag(exit)).toBe("BoardOwnershipError");
  });

  it("github.config.set refuses an unreachable board without reading the body", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      setGithubConfig(actionInput(JWT_TEST_CLAIMS, NO_SUCH_BOARD, poisonBody(), { grants: null, orgSlug: null })),
    );
    expect(failureTag(exit)).toBe("BoardOwnershipError");
  });

  it("github.rules.set refuses an unreachable board without reading the body", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      setGithubRules(actionInput(JWT_TEST_CLAIMS, NO_SUCH_BOARD, poisonBody(), { grants: null, orgSlug: null })),
    );
    expect(failureTag(exit)).toBe("BoardOwnershipError");
  });

  it("github.connection.test refuses an unreachable board without reading the body", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      testGithubConnection(
        actionInput(JWT_TEST_CLAIMS, NO_SUCH_BOARD, poisonBody(), { grants: null, orgSlug: null }),
      ),
    );
    expect(failureTag(exit)).toBe("BoardOwnershipError");
  });

  it("attachment.create refuses an unreachable issue without reading the upload", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      createAttachment(
        actionInput(JWT_TEST_CLAIMS, { ...NO_SUCH_BOARD, issue_ref: "nope" }, poisonBody(), {
          grants: null,
          orgSlug: null,
        }),
        "storage-secret",
      ),
    );
    expect(failureTag(exit)).toBe("BoardOwnershipError");
  });
});

describe("EFB-98 rule 10 — preserve means preserve, not always defer", () => {
  // The cover PATCH is the counter-example, and it is why "always defer" would
  // have been the wrong rule. Its pre-split handler read and validated the body
  // ABOVE the attachment lookup, so a malformed `is_cover` has always answered
  // 400 even for an id that does not exist. Deferring here would have flipped a
  // real, observable order in the opposite direction from every case above.
  it("attachment.update validates the body BEFORE looking the attachment up", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      updateAttachment(
        actionInput(JWT_TEST_CLAIMS, { id: "ghost" }, { is_cover: "yes" }, { grants: null, orgSlug: null }),
      ),
    );
    // Not NotFoundError: the body is judged first, exactly as it always was.
    expect(failureTag(exit)).toBe("ValidationError");
  });

  it("attachment.update still 404s an unknown id once the body is well-formed", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      updateAttachment(
        actionInput(JWT_TEST_CLAIMS, { id: "ghost" }, { is_cover: true }, { grants: null, orgSlug: null }),
      ),
    );
    // The other half of the same order — proving the first assertion is about
    // SEQUENCE and not merely that a bad body fails somewhere.
    expect(failureTag(exit)).toBe("NotFoundError");
  });
});
