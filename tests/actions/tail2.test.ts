// EFB-98 tail-2: behaviours proved by calling the actions DIRECTLY.
//
// No URL appears in this file. The two most important tests here are the ones
// nothing covered before — the ORDER in which two failures race, on the two
// handlers where migrating naively would have swapped them. Both are written
// as differential pairs: the same call, one input changed, opposite answers.
// A single-sided assertion could not tell "the gate fired first" from "the
// gate is the only thing that can fire".

import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  Jwt,
  JwtTest,
  JWT_TEST_CLAIMS,
  makeAuditLogTest,
  makeAudienceTest,
  makeBoardEmitterTest,
  makeEmailTest,
  makeFourATest,
  type AppServices,
} from "../../src/effects";
import { createKey, deleteKey, listKeys } from "../../src/actions/keys";
import {
  getNotificationsConfig,
  setNotificationsConfig,
} from "../../src/actions/notifications";
import { registerSessionKey } from "../../src/actions/session";
import { mintNostrChallenge } from "../../src/actions/signin";
import { boardActivity } from "../../src/actions/feed";
import { actionInput } from "../../src/actions/types";
import { ValidationError } from "../../src/lib/errors";
import { hashToken } from "../../src/effects";
import { makeDbMock } from "../dbMock";
import { CALLER } from "../harness";

const makeDeps = () => {
  const db = makeDbMock();
  const audit = makeAuditLogTest();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtTest as Layer.Layer<Jwt>,
    db.layer,
    audit.layer,
    makeBoardEmitterTest().layer,
    makeAudienceTest().layer,
    makeFourATest().layer,
    makeEmailTest().layer,
  ) as unknown as Layer.Layer<AppServices>;
  return { db, audit, layer };
};

const run = <A, E>(deps: ReturnType<typeof makeDeps>, program: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(Effect.provide(program as never, deps.layer));

/** The tag of the failure an exit carries, or null if it succeeded. */
const failureTag = (exit: Exit.Exit<unknown, unknown>): string | null =>
  exit._tag === "Failure"
    ? ((exit.cause as unknown as { error?: { _tag?: string } }).error?._tag ??
      JSON.stringify(exit.cause).match(/"_tag":"(\w+)"/)?.[1] ??
      "unknown")
    : null;

/** A body that always fails to parse — stands in for malformed JSON. */
const unparseableBody = () =>
  Effect.fail(new ValidationError({ reason: "expected-json" })) as Effect.Effect<
    Record<string, unknown>,
    ValidationError
  >;

describe("key actions — the 403-before-400 order (rule 10)", () => {
  // THE PAIR. Same action, same malformed body, one field different: the
  // bearer. An API-key caller must be told it may not use this endpoint at
  // all; only a JWT caller gets as far as being told its JSON is bad.
  //
  // This is what the deferred `ActionInput<Effect<…>>` buys. Parsing on the
  // way in — the shape every other action in the family uses — makes BOTH of
  // these answer ValidationError, and nothing else in the suite notices.

  it("tells a key-bearing caller it needs a JWT, even when the body is also broken", async () => {
    const deps = makeDeps();

    const exit = await run(
      deps,
      createKey(
        actionInput(JWT_TEST_CLAIMS, {}, unparseableBody(), { grants: null, token: "evk_abc123" }),
      ),
    );

    expect(failureTag(exit)).toBe("ForbiddenError");
    expect(deps.db.apiKeys).toHaveLength(0);
  });

  it("tells a JWT caller its body is broken — the same call, one field changed", async () => {
    const deps = makeDeps();

    const exit = await run(
      deps,
      createKey(
        actionInput(JWT_TEST_CLAIMS, {}, unparseableBody(), { grants: null, token: "header.payload.sig" }),
      ),
    );

    expect(failureTag(exit)).toBe("ValidationError");
    expect(deps.db.apiKeys).toHaveLength(0);
  });

  it("mints a key and returns the plaintext exactly once", async () => {
    const deps = makeDeps();

    const exit = await run(
      deps,
      createKey(
        actionInput(JWT_TEST_CLAIMS, {}, Effect.succeed({ name: "ci" }), { grants: null, token: "jwt.a.b" }),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.db.apiKeys).toHaveLength(1);
    if (exit._tag === "Success") {
      const { plaintext, key } = exit.value as { plaintext: string; key: { name: string } };
      expect(plaintext.startsWith("evk_")).toBe(true);
      expect(key.name).toBe("ci");
      // The stored row must never carry the plaintext.
      expect(JSON.stringify(deps.db.apiKeys[0])).not.toContain(plaintext);
    }
  });

  it("rejects a blank name", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      createKey(
        actionInput(JWT_TEST_CLAIMS, {}, Effect.succeed({ name: "   " }), { grants: null, token: "jwt.a.b" }),
      ),
    );
    expect(failureTag(exit)).toBe("ValidationError");
    expect(deps.db.apiKeys).toHaveLength(0);
  });

  it("revokes idempotently and lists only the caller's own keys", async () => {
    const deps = makeDeps();
    deps.db.apiKeys.push({
      id: "k1", pubkey: CALLER, name: "mine", key_hash: "h", prefix: "evk_aaaaaaaa",
      created_at_ms: 1, last_used_at_ms: null, revoked_at_ms: null,
    });
    deps.db.apiKeys.push({
      id: "k2", pubkey: "github:999", name: "theirs", key_hash: "h2", prefix: "evk_bbbbbbbb",
      created_at_ms: 1, last_used_at_ms: null, revoked_at_ms: null,
    });

    const listed = await run(
      deps,
      listKeys(actionInput(JWT_TEST_CLAIMS, {}, undefined, { grants: null, token: "jwt.a.b" })),
    );
    expect(listed._tag).toBe("Success");
    if (listed._tag === "Success") {
      const { keys } = listed.value as { keys: ReadonlyArray<{ id: string }> };
      expect(keys.map((k) => k.id)).toEqual(["k1"]);
    }

    const first = await run(
      deps,
      deleteKey(actionInput(JWT_TEST_CLAIMS, { id: "k1" }, undefined, { grants: null, token: "jwt.a.b" })),
    );
    const revokedAt = deps.db.apiKeys[0]!["revoked_at_ms"];
    const second = await run(
      deps,
      deleteKey(actionInput(JWT_TEST_CLAIMS, { id: "k1" }, undefined, { grants: null, token: "jwt.a.b" })),
    );

    expect(first._tag).toBe("Success");
    expect(second._tag).toBe("Success");
    // The second revoke must not move the timestamp or write a second audit row.
    expect(deps.db.apiKeys[0]!["revoked_at_ms"]).toBe(revokedAt);
    expect(deps.audit.events.filter((e) => e.event_type === "api_key_revoked")).toHaveLength(1);
  });

  it("refuses to revoke someone else's key", async () => {
    const deps = makeDeps();
    deps.db.apiKeys.push({
      id: "k2", pubkey: "github:999", name: "theirs", key_hash: "h2", prefix: "evk_bbbbbbbb",
      created_at_ms: 1, last_used_at_ms: null, revoked_at_ms: null,
    });

    const exit = await run(
      deps,
      deleteKey(actionInput(JWT_TEST_CLAIMS, { id: "k2" }, undefined, { grants: null, token: "jwt.a.b" })),
    );

    expect(failureTag(exit)).toBe("NotFoundError");
    expect(deps.db.apiKeys[0]!["revoked_at_ms"]).toBeNull();
  });
});

describe("signin challenge — the 500-before-400 order (rule 10)", () => {
  // THE SECOND PAIR, and the one worker-3's scan missed entirely. An
  // unconfigured server must not blame the caller for its own misconfiguration.

  it("blames the server when the signing key is missing, even with a bad pubkey", async () => {
    const exit = await Effect.runPromiseExit(
      mintNostrChallenge(
        actionInput(null, {}, undefined, { query: { pubkey: "not-hex" } }, { grants: null }),
        undefined,
      ),
    );

    expect(failureTag(exit)).toBe("ConfigError");
  });

  it("blames the caller for the same bad pubkey once the key IS configured", async () => {
    const exit = await Effect.runPromiseExit(
      mintNostrChallenge(
        actionInput(null, {}, undefined, { query: { pubkey: "not-hex" } }, { grants: null }),
        "a-signing-key",
      ),
    );

    expect(failureTag(exit)).toBe("ValidationError");
  });

  it("mints a ts.pubkey.hmac challenge for a well-formed pubkey", async () => {
    const pubkey = "a".repeat(64);
    const exit = await Effect.runPromiseExit(
      mintNostrChallenge(actionInput(null, {}, undefined, { query: { pubkey } }, { grants: null }), "k"),
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      const { challenge } = exit.value as { challenge: string };
      const [ts, pk, mac] = challenge.split(".");
      expect(pk).toBe(pubkey);
      expect(Number.isInteger(Number(ts))).toBe(true);
      expect(mac).toHaveLength(32);
    }
  });
});

describe("notifications actions", () => {
  it("reads the schema defaults for a user with no row", async () => {
    const deps = makeDeps();
    const exit = await run(deps, getNotificationsConfig(actionInput(JWT_TEST_CLAIMS, {}, undefined, { grants: null })));

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect((exit.value as { config: { email_digest: string } }).config.email_digest).toBe("off");
    }
  });

  it("upserts a partial patch over the defaults", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      setNotificationsConfig(actionInput(JWT_TEST_CLAIMS, {}, { email_digest: "daily" }, { grants: null })),
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      const { config } = exit.value as { config: Record<string, unknown> };
      expect(config["email_digest"]).toBe("daily");
      // Untouched fields keep their default rather than becoming false/null.
      expect(config["email_on_mention"]).toBe(true);
    }
  });

  it("rejects a digest that is not one of the three", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      setNotificationsConfig(actionInput(JWT_TEST_CLAIMS, {}, { email_digest: "hourly" }, { grants: null })),
    );

    expect(failureTag(exit)).toBe("ValidationError");
  });

  it("rejects a non-boolean on a boolean field", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      setNotificationsConfig(actionInput(JWT_TEST_CLAIMS, {}, { email_on_mention: "yes" }, { grants: null })),
    );

    expect(failureTag(exit)).toBe("ValidationError");
  });
});

describe("session key registration", () => {
  it("refuses to downgrade a nostr registration to an ephemeral one", async () => {
    // The whole point of session_key_source: a nostr session's key IS the
    // member's real key, and an ephemeral re-registration must not replace it
    // or every private-board grant silently drops a trust level.
    const deps = makeDeps();
    // The row is keyed by the HASH of the bearer, so the fixture has to be
    // built with the same function the action uses — a hand-written string
    // here simply never matches, and the test passes for the wrong reason by
    // taking the "no existing row" branch.
    const jwtHash = await Effect.runPromise(hashToken("t"));
    deps.db.sessionKeys.push({
      jwt_hash: jwtHash, member_pubkey: CALLER, session_pubkey: "b".repeat(64),
      created_at_ms: 1, expires_at_ms: 9_999_999_999_999, session_key_source: "nostr",
    });

    const exit = await run(
      deps,
      registerSessionKey(
        actionInput(JWT_TEST_CLAIMS, {}, { session_pubkey: "c".repeat(64) }, { grants: null, token: "t" }),
      ),
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect((exit.value as { source: string }).source).toBe("nostr");
      // The stored key is still the real one.
      expect((exit.value as { session_pubkey: string }).session_pubkey).toBe("b".repeat(64));
    }
  });

  it("rejects a session pubkey that is not 64 hex", async () => {
    const deps = makeDeps();
    const exit = await run(
      deps,
      registerSessionKey(
        actionInput(JWT_TEST_CLAIMS, {}, { session_pubkey: "nope" }, { grants: null, token: "t" }),
      ),
    );

    expect(failureTag(exit)).toBe("ValidationError");
  });
});

describe("feed — authorization decides before the query shape does", () => {
  // A bad ?limit on a board the caller cannot see must answer 404, not 400.
  // Complaining about the limit would confirm the board exists.
  it("404s a bad limit on an invisible board rather than 400ing it", async () => {
    const deps = makeDeps();
    deps.db.boards.push({
      id: "fb", pubkey: "github:999", slug: "theirs", title: "Theirs", description: null,
      columns: JSON.stringify(["Todo"]), labels: "[]", member_policy: "invite",
      is_encrypted: 0, org_id: null, visibility: "private", created_at_ms: 1, updated_at_ms: 1,
    });

    const exit = await run(
      deps,
      boardActivity(
        actionInput(JWT_TEST_CLAIMS, { slug: "theirs" }, undefined, { query: { limit: "0" } }, { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(failureTag(exit)).not.toBe("ValidationError");
  });
});
