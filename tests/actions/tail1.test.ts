// EFB-98 tail-1: the storage / profile / imports actions, tested DIRECTLY.
//
// Same posture as tests/actions/comments.test.ts and issues.test.ts — every
// test proves a behaviour without naming a URL. Routing is proved once and
// separately by the manifest, check-rest-conventions and tests/router.test.ts.
//
// The two ORDERING tests are the ones that earned their place. Nothing in the
// suite pinned either, and the obvious way to write these migrations — parse
// in the shell, call the action — breaks both.

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  Jwt,
  JwtTest,
  JWT_TEST_CLAIMS,
  makeAuditLogTest,
  makeAudienceTest,
  makeBlossomTest,
  makeBoardEmitterTest,
  makeFourATest,
  makeS3Test,
  type AppServices,
} from "../../src/effects";
import { ValidationError } from "../../src/lib/errors";
import { setStorageConfig } from "../../src/actions/storage";
import { createBulkImport } from "../../src/actions/imports";
import { createProfilePicture, listProfiles } from "../../src/actions/profile";
import { actionInput } from "../../src/actions/types";
import { makeDbMock } from "../dbMock";

const makeDeps = () => {
  const db = makeDbMock();
  const audit = makeAuditLogTest();
  const emitter = makeBoardEmitterTest();
  const audience = makeAudienceTest();
  const fourA = makeFourATest();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtTest as Layer.Layer<Jwt>,
    db.layer,
    audit.layer,
    emitter.layer,
    audience.layer,
    fourA.layer,
    makeBlossomTest().layer,
    makeS3Test().layer,
  ) as unknown as Layer.Layer<AppServices>;
  return { db, audit, emitter, fourA, layer };
};

const run = <A, E>(deps: ReturnType<typeof makeDeps>, program: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(Effect.provide(program as never, deps.layer));

/** A parse that fails if it is ever run — the probe both ordering tests use. */
const parseThatWouldFail = <T>() =>
  Effect.fail(new ValidationError({ reason: "expected-json" })) as unknown as Effect.Effect<
    T,
    ValidationError,
    never
  >;

const causeText = (exit: { _tag: string; cause?: unknown }) =>
  exit._tag === "Failure" ? JSON.stringify(exit.cause) : "";

describe("storage actions", () => {
  // ── rule-10 pin ─────────────────────────────────────────────────────────
  //
  // setStorageConfig authorizes the ORG before it reads the body, and that
  // order is observable. Storage config is owner-only precisely because the
  // encrypt-to-server design keeps credentials away from non-owners — so a
  // non-owner sending junk must keep getting the authorization answer, not a
  // 400 telling them their JSON was the problem.
  //
  // Falsification: yield `input.body` above authorizeOrgAccess in
  // setStorageConfig and this test goes red on its own.
  it("answers the org gate, not the body parse, when both would fail", async () => {
    const deps = makeDeps();
    // No org rows at all, so authorizeOrgAccess cannot succeed.
    const exit = await run(
      deps,
      setStorageConfig(
        actionInput(JWT_TEST_CLAIMS, { org_slug: "nope" }, parseThatWouldFail(), {
          orgSlug: "nope",
        }),
        "00".repeat(32),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(causeText(exit)).not.toContain("expected-json");
  });

  it("takes the server secret as a parameter and tolerates it being unset", async () => {
    // `string | undefined`, handled without `!`. An unconfigured deployment is
    // a real state — the type says so and the action must not throw on it.
    const deps = makeDeps();
    const exit = await run(
      deps,
      setStorageConfig(
        actionInput(JWT_TEST_CLAIMS, { org_slug: "nope" }, parseThatWouldFail(), {
          orgSlug: "nope",
        }),
        undefined,
      ),
    );
    // Still the org answer — the point is that an unset secret is not a crash.
    expect(exit._tag).toBe("Failure");
    expect(causeText(exit)).not.toContain("Defect");
  });
});

describe("import actions", () => {
  // ── rule-10 pin ─────────────────────────────────────────────────────────
  //
  // createBulkImport resolves the board before parsing. A malformed 500-row
  // paste aimed at a board the caller cannot contribute to answers 404/403,
  // not a 400 about the JSON.
  //
  // Falsification: yield `input.body` above resolveBoardScope and this reddens.
  it("answers the board gate, not the body parse, when both would fail", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      createBulkImport(
        actionInput(JWT_TEST_CLAIMS, { slug: "missing" }, parseThatWouldFail()),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(causeText(exit)).not.toContain("expected-json");
    expect(deps.db.issues).toHaveLength(0);
  });
});

describe("profile actions", () => {
  // The policy half of rule 12: the READ lives in the route, but what the
  // bytes are ALLOWED to be is business logic and is asserted here, with no
  // request anywhere in sight.
  it("rejects an image over the size cap", async () => {
    const deps = makeDeps();
    const oversized = new Uint8Array(256 * 1024 + 1);
    const exit = await run(
      deps,
      createProfilePicture(
        actionInput(
          JWT_TEST_CLAIMS,
          {},
          Effect.succeed({ bytes: oversized, imageType: "image/png" }),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(causeText(exit)).toContain("image-too-large");
  });

  it("rejects a content type outside the allow-list", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      createProfilePicture(
        actionInput(
          JWT_TEST_CLAIMS,
          {},
          Effect.succeed({ bytes: new Uint8Array([1, 2, 3]), imageType: "image/gif" }),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(causeText(exit)).toContain("unsupported-image-type");
  });

  // The chip-rendering LENIENCY — an unnormalizable pubkey passes through
  // rather than failing the whole batch — is deliberately NOT re-asserted
  // here. It needs a profileCache-aware Db, and the shared makeDbMock has
  // none: tests/profile.test.ts builds a bespoke double precisely because
  // "profileCache SQL only exists on this router", and that file already pins
  // the behaviour. Cloning the double to say the same thing twice would buy a
  // second place to drift, not a second proof.
  //
  // What IS asserted here is the part that needs no database at all:
  it("rejects an empty pubkeys parameter", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      listProfiles(actionInput(null, {}, undefined, { query: { pubkeys: "  " } })),
    );

    expect(exit._tag).toBe("Failure");
    expect(causeText(exit)).toContain("pubkeys");
  });
});
