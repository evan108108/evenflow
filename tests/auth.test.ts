import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Effect, Layer } from "effect";
import {
  Db,
  type DbService,
  JwtTest,
  JWT_TEST_CLAIMS,
  JWT_TEST_TOKEN,
  KmsClientLive,
  KmsClientTest,
  makeAuditLogTest,
  makeBoardEmitterTest,
  type AppServices,
} from "../src/effects";
import type { AppHonoEnv } from "../src/http";
import { requireAuth } from "../src/middleware/requireAuth";
import { makeAuthRouter } from "../src/routes/auth";

const enc = new TextEncoder();

const sha256Hex = async (s: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

interface DbSpy {
  readonly layer: Layer.Layer<Db>;
  readonly executes: Array<{ sql: string; params: ReadonlyArray<unknown> | undefined }>;
}

const makeDbSpy = (): DbSpy => {
  const executes: DbSpy["executes"] = [];
  const service: DbService = {
    execute: (sql, params) =>
      Effect.sync(() => {
        executes.push({ sql, params });
      }),
    queryFirst: () => Effect.succeed(null),
    queryAll: () => Effect.succeed([]),
  };
  return { executes, layer: Layer.succeed(Db, service) };
};

/** Full AppServices test environment; kms defaults to the deterministic fake. */
const makeHarness = (opts?: { kmsStub?: boolean }) => {
  const db = makeDbSpy();
  const audit = makeAuditLogTest();
  const emitter = makeBoardEmitterTest();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtTest,
    db.layer,
    audit.layer,
    emitter.layer,
    opts?.kmsStub === true ? KmsClientLive : KmsClientTest,
  );
  const app = new Hono<AppHonoEnv>();
  app.route("/auth", makeAuthRouter(() => layer));
  app.use("/api/v0/*", requireAuth(() => layer));
  app.get("/api/v0/me", (c) => c.json(c.get("claims")));
  return { app, db, audit };
};

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

describe("requireAuth", () => {
  it("accepts a valid token and sets claims on context", async () => {
    const { app } = makeHarness();
    const res = await app.request("/api/v0/me", bearer(JWT_TEST_TOKEN), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JWT_TEST_CLAIMS);
  });

  it("rejects a missing Authorization header with 401", async () => {
    const { app } = makeHarness();
    const res = await app.request("/api/v0/me", {}, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", reason: "missing-authorization" });
  });

  it("rejects a malformed token with 401 and the Jwt error reason", async () => {
    const { app } = makeHarness();
    const res = await app.request("/api/v0/me", bearer("garbage"), {});
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("unauthorized");
    expect(body.reason).toBe("bad-signature");
  });
});

describe("GET /auth/whoami", () => {
  it("returns claims + derived pubkey when KMS works", async () => {
    const { app } = makeHarness();
    const res = await app.request("/auth/whoami", bearer(JWT_TEST_TOKEN), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      claims: JWT_TEST_CLAIMS,
      pubkey: `test-pubkey-${JWT_TEST_CLAIMS.provider}-${JWT_TEST_CLAIMS.oauth_id}`,
    });
  });

  it("returns pubkey null + audits when KMS is the not-yet-wired stub", async () => {
    const { app, audit } = makeHarness({ kmsStub: true });
    const res = await app.request("/auth/whoami", bearer(JWT_TEST_TOKEN), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pubkey: string | null };
    expect(body.pubkey).toBeNull();
    expect(audit.events.some((e) => e.event_type === "kms_not_wired")).toBe(true);
  });

  it("is protected", async () => {
    const { app } = makeHarness();
    const res = await app.request("/auth/whoami", {}, {});
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/session", () => {
  const post = (body: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("stores a hashed session row and returns session_hash = sha256(jwt)", async () => {
    const { app, db } = makeHarness();
    const res = await app.request("/auth/session", post({ jwt: JWT_TEST_TOKEN }), {});
    expect(res.status).toBe(200);
    const { session_hash } = (await res.json()) as { session_hash: string };
    expect(session_hash).toBe(await sha256Hex(JWT_TEST_TOKEN));

    expect(db.executes).toHaveLength(1);
    const insert = db.executes[0]!;
    expect(insert.sql).toContain("INSERT OR REPLACE INTO sessionCache");
    expect(insert.params?.[0]).toBe(session_hash);
    // Raw JWT must never reach storage.
    expect(insert.params).not.toContain(JWT_TEST_TOKEN);
    expect(insert.params?.[4]).toBe(JWT_TEST_CLAIMS.exp * 1000);
  });

  it("rejects an invalid jwt with 401", async () => {
    const { app, db } = makeHarness();
    const res = await app.request("/auth/session", post({ jwt: "garbage" }), {});
    expect(res.status).toBe(401);
    expect(db.executes).toHaveLength(0);
  });

  it("rejects a missing jwt field with 400", async () => {
    const { app } = makeHarness();
    const res = await app.request("/auth/session", post({}), {});
    expect(res.status).toBe(400);
  });
});

describe("DELETE /auth/session", () => {
  it("deletes the row for this token's hash", async () => {
    const { app, db } = makeHarness();
    const res = await app.request(
      "/auth/session",
      { method: "DELETE", ...bearer(JWT_TEST_TOKEN) },
      {},
    );
    expect(res.status).toBe(200);
    expect(db.executes).toHaveLength(1);
    const del = db.executes[0]!;
    expect(del.sql).toContain("DELETE FROM sessionCache");
    expect(del.params?.[0]).toBe(await sha256Hex(JWT_TEST_TOKEN));
  });
});

describe("GET /auth/oauth/start", () => {
  it("redirects to google by default with a state param", async () => {
    const { app } = makeHarness();
    const res = await app.request("/auth/oauth/start", {}, {});
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://api.4a4.ai");
    expect(location.pathname).toBe("/auth/google/start");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("honors ?provider=github and passes the caller's state through", async () => {
    const { app } = makeHarness();
    const res = await app.request("/auth/oauth/start?provider=github&state=csrf-123", {}, {});
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.pathname).toBe("/auth/github/start");
    expect(location.searchParams.get("state")).toBe("csrf-123");
  });

  it("rejects unknown providers", async () => {
    const { app } = makeHarness();
    const res = await app.request("/auth/oauth/start?provider=twitter", {}, {});
    expect(res.status).toBe(400);
  });
});
