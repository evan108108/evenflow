import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Effect, Layer } from "effect";
import {
  Db,
  type DbService,
  JwtTest,
  JWT_TEST_CLAIMS,
  JWT_TEST_TOKEN,
  makeAuditLogTest,
  makeBoardEmitterTest,
  makeFourATest,
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

/** Full AppServices test environment; 4a defaults to the deterministic fake. */
const makeHarness = (opts?: { fourAFails?: boolean }) => {
  const db = makeDbSpy();
  const audit = makeAuditLogTest();
  const emitter = makeBoardEmitterTest();
  const fourA = makeFourATest();
  fourA.failWhoami = opts?.fourAFails === true;
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtTest,
    db.layer,
    audit.layer,
    emitter.layer,
    fourA.layer,
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
  it("returns claims + gateway-derived pubkey and upgrades the session row", async () => {
    const { app, db } = makeHarness();
    const res = await app.request("/auth/whoami", bearer(JWT_TEST_TOKEN), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      claims: JWT_TEST_CLAIMS,
      pubkey: `hex-${JWT_TEST_TOKEN.slice(0, 8)}`,
    });
    // The resolved pubkey lands back on sessionCache for this token's hash.
    expect(db.executes).toHaveLength(1);
    expect(db.executes[0]!.sql).toContain("UPDATE sessionCache SET pubkey = ?");
    expect(db.executes[0]!.params?.[0]).toBe(`hex-${JWT_TEST_TOKEN.slice(0, 8)}`);
  });

  it("returns pubkey null + audits when the gateway is unreachable", async () => {
    const { app, audit, db } = makeHarness({ fourAFails: true });
    const res = await app.request("/auth/whoami", bearer(JWT_TEST_TOKEN), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pubkey: string | null };
    expect(body.pubkey).toBeNull();
    expect(audit.events.some((e) => e.event_type === "pubkey_resolve_failed")).toBe(true);
    // No session-row write when resolution failed.
    expect(db.executes).toHaveLength(0);
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

const b64urlOf = async (s: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const cookieValue = (setCookies: string[], name: string): string | undefined =>
  setCookies
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.slice(name.length + 1);

// Node's lib.dom typings predate Headers.getSetCookie; the runtime has it.
const setCookiesOf = (res: Response): string[] =>
  (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie();

describe("GET /auth/oauth/start", () => {
  it("redirects to google by default with full AS-flow params + PKCE", async () => {
    const { app } = makeHarness();
    const res = await app.request("/auth/oauth/start", {}, {});
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://api.4a4.ai");
    expect(location.pathname).toBe("/auth/google/start");
    expect(location.searchParams.get("client_id")).toMatch(/^dcr1_/);
    expect(location.searchParams.get("redirect_uri")).toBe("https://evenflow.work/auth/callback");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    // The pkce_verifier cookie must hash (S256) to the challenge in the URL.
    const setCookies = setCookiesOf(res);
    const verifier = cookieValue(setCookies, "pkce_verifier");
    expect(verifier).toBeTruthy();
    expect(location.searchParams.get("code_challenge")).toBe(await b64urlOf(verifier!));
    expect(cookieValue(setCookies, "oauth_state")).toBe(location.searchParams.get("state"));
    for (const cookie of setCookies) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Max-Age=600");
    }
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

describe("GET /auth/callback", () => {
  const env = { OAUTH_CLIENT_SECRET_4A: "test-client-secret" };
  const cookies = (verifier: string, state: string) => ({
    headers: { Cookie: `pkce_verifier=${verifier}; oauth_state=${state}` },
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges the code and redirects to /signin with the JWT in the fragment", async () => {
    const { app } = makeHarness();
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "jwt.from.4a", token_type: "Bearer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await app.request(
      "/auth/callback?code=abc&state=st-1",
      cookies("the-verifier", "st-1"),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/signin#jwt=jwt.from.4a");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.4a4.ai/auth/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("abc");
    expect(body.get("redirect_uri")).toBe("https://evenflow.work/auth/callback");
    expect(body.get("client_id")).toMatch(/^dcr1_/);
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("code_verifier")).toBe("the-verifier");

    // One-shot cookies are expired on the way out.
    for (const name of ["pkce_verifier", "oauth_state"]) {
      const cleared = setCookiesOf(res).find((c) => c.startsWith(`${name}=`));
      expect(cleared).toContain("Max-Age=0");
    }
  });

  it("rejects a missing code with 400", async () => {
    const { app } = makeHarness();
    const res = await app.request("/auth/callback?state=st-1", cookies("v", "st-1"), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-callback", reason: "missing-code" });
  });

  it("rejects a state mismatch with 400", async () => {
    const { app } = makeHarness();
    const res = await app.request("/auth/callback?code=abc&state=evil", cookies("v", "st-1"), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-callback", reason: "state-mismatch" });
  });

  it("rejects a missing pkce_verifier cookie with 400", async () => {
    const { app } = makeHarness();
    const res = await app.request(
      "/auth/callback?code=abc&state=st-1",
      { headers: { Cookie: "oauth_state=st-1" } },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-callback", reason: "missing-pkce-verifier" });
  });

  it("surfaces a failed token exchange as 502", async () => {
    const { app } = makeHarness();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid_grant", { status: 400 })));
    const res = await app.request(
      "/auth/callback?code=expired&state=st-1",
      cookies("v", "st-1"),
      env,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; status: number };
    expect(body.error).toBe("token-exchange-failed");
    expect(body.status).toBe(400);
  });
});
