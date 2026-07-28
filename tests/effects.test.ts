import { describe, expect, it } from "vitest";
import { Effect, Exit, Layer } from "effect";
import {
  AppEnv,
  AuditLog,
  Db,
  DbTest,
  Jwt,
  JwtLive,
  JwtTest,
  JWT_TEST_CLAIMS,
  JWT_TEST_TOKEN,
  KmsClient,
  KmsClientLive,
  makeAuditLogTest,
} from "../src/effects";

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

/** Mint an HS256 JWT the same way 4a's AS does, for exercising JwtLive. */
const mintTestJwt = async (
  claims: Record<string, unknown>,
  secret: string,
): Promise<string> => {
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
};

describe("Db.Test", () => {
  it("returns nothing on empty", async () => {
    const program = Effect.gen(function* () {
      const db = yield* Db;
      yield* db.execute("INSERT INTO boards (slug) VALUES (?)", ["kb"]);
      const first = yield* db.queryFirst("SELECT * FROM boards");
      const all = yield* db.queryAll("SELECT * FROM boards");
      return { first, all };
    }).pipe(Effect.provide(DbTest));

    const { first, all } = await Effect.runPromise(program);
    expect(first).toBeNull();
    expect(all).toEqual([]);
  });
});

describe("Jwt.Test", () => {
  it("verifies the canned token", async () => {
    const claims = await Effect.runPromise(
      Effect.gen(function* () {
        const jwt = yield* Jwt;
        return yield* jwt.verify(JWT_TEST_TOKEN);
      }).pipe(Effect.provide(JwtTest)),
    );
    expect(claims).toEqual(JWT_TEST_CLAIMS);
  });

  it("rejects any other token", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const jwt = yield* Jwt;
        return yield* jwt.verify("garbage");
      }).pipe(Effect.provide(JwtTest)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("Jwt.Live", () => {
  const secret = "test-signing-key";
  const liveLayer = (key?: string) =>
    Layer.provide(
      JwtLive,
      Layer.succeed(AppEnv, key === undefined ? {} : { JWT_SIGNING_KEY: key }),
    );
  const verify = (token: string, key?: string) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const jwt = yield* Jwt;
        return yield* jwt.verify(token);
      }).pipe(Effect.provide(liveLayer(key))),
    );

  const validClaims = {
    provider: "github",
    oauth_id: "12345",
    login: "tester",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it("verifies a token minted with the shared secret", async () => {
    const token = await mintTestJwt(validClaims, secret);
    const exit = await verify(token, secret);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.login).toBe("tester");
      expect(exit.value.provider).toBe("github");
    }
  });

  it("rejects a token signed with a different key", async () => {
    const token = await mintTestJwt(validClaims, "some-other-key");
    const exit = await verify(token, secret);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("rejects an expired token", async () => {
    const token = await mintTestJwt(
      { ...validClaims, exp: Math.floor(Date.now() / 1000) - 10 },
      secret,
    );
    const exit = await verify(token, secret);
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("fails without a signing key configured", async () => {
    const token = await mintTestJwt(validClaims, secret);
    const exit = await verify(token);
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("AuditLog.Test", () => {
  it("records events into the in-memory array", async () => {
    const audit = makeAuditLogTest();
    await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* AuditLog;
        yield* log.record({ event_type: "healthz_check" });
        yield* log.record({ event_type: "issue_created", board: "kb", actor: "tester" });
      }).pipe(Effect.provide(audit.layer)),
    );
    expect(audit.events).toHaveLength(2);
    expect(audit.events[0]?.event_type).toBe("healthz_check");
    expect(audit.events[1]?.board).toBe("kb");
  });
});

describe("KmsClient.Live (stub)", () => {
  it("fails with not-yet-wired", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const kms = yield* KmsClient;
        return yield* kms.derivePubkey("github", "12345");
      }).pipe(Effect.provide(KmsClientLive)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
