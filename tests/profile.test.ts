// Profile route tests: lazy-cache semantics against a profileCache-aware
// Db mock and the FourA test double. Self-contained harness (not the shared
// one) — profileCache SQL only exists on this router, and the FourA call
// log is the assertion surface for "cache hit avoids the substrate".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Effect, Layer } from "effect";
import {
  Db,
  type DbService,
  JwtTest,
  JWT_TEST_CLAIMS,
  JWT_TEST_TOKEN,
  makeAuditLogTest,
  makeBlossomTest,
  makeS3Test,
  makeAudienceTest,
  makeBoardEmitterTest,
  makeFourATest,
  type AppServices,
  makeEmailTest,
} from "../src/effects";
import type { AppHonoEnv } from "../src/http";
import { requireAuth } from "../src/middleware/requireAuth";
import { makeProfileRouter, BULK_MAX, PROFILE_CACHE_TTL_MS } from "../src/routes/profile";

const CALLER = `${JWT_TEST_CLAIMS.provider}:${JWT_TEST_CLAIMS.oauth_id}`;

type Row = Record<string, unknown>;

/** profileCache-only Db mock; unexpected SQL throws (route/SQL drift fails loudly). */
const makeDbMock = () => {
  const profiles: Row[] = [];
  const service: DbService = {
    execute: (sql, params = []) =>
      Effect.sync(() => {
        if (sql.startsWith("INSERT INTO profileCache")) {
          const [pubkey, name, display_name, picture, about, event_id, updated_at_ms, fetched_at_ms] = params;
          const existing = profiles.find((r) => r["pubkey"] === pubkey);
          const next = { pubkey, name, display_name, picture, about, event_id, updated_at_ms, fetched_at_ms };
          if (existing) Object.assign(existing, next);
          else profiles.push(next);
          return;
        }
        throw new Error(`DbMock: unexpected execute: ${sql}`);
      }),
    queryFirst: <R>(sql: string, params: ReadonlyArray<unknown> = []) =>
      Effect.sync(() => {
        if (sql.startsWith("SELECT * FROM profileCache WHERE pubkey = ?")) {
          const r = profiles.find((x) => x["pubkey"] === params[0]);
          return (r ? { ...r } : null) as R | null;
        }
        throw new Error(`DbMock: unexpected queryFirst: ${sql}`);
      }),
    queryAll: () => Effect.sync(() => {
      throw new Error("DbMock: unexpected queryAll");
    }),
  };
  return { profiles, layer: Layer.succeed(Db, service) };
};

const makeHarness = () => {
  const db = makeDbMock();
  const audit = makeAuditLogTest();
  const fourA = makeFourATest();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    makeEmailTest().layer,
    makeBlossomTest().layer,
    makeS3Test().layer,
    makeAudienceTest().layer,
    JwtTest,
    db.layer,
    audit.layer,
    makeBoardEmitterTest().layer,
    fourA.layer,
  );
  const app = new Hono<AppHonoEnv>();
  app.use("/api/v0/*", requireAuth(() => layer));
  app.route("/api/v0", makeProfileRouter(() => layer));
  return { app, db, audit, fourA };
};

const bearer = { Authorization: `Bearer ${JWT_TEST_TOKEN}` };
const jsonReq = (method: string, body?: unknown) => ({
  method,
  headers: { ...bearer, "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const fetchCalls = (h: ReturnType<typeof makeHarness>) =>
  h.fourA.calls.filter((c) => c.method === "fetchProfile");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PUT + GET /api/v0/profile/me round-trip", () => {
  it("publishes kind 0, caches, and serves the update back", async () => {
    const h = makeHarness();
    const put = await h.app.request(
      "/api/v0/profile/me",
      jsonReq("PUT", { display_name: "Evan", name: "evan108108", about: "hi" }),
      {},
    );
    expect(put.status).toBe(200);
    const { profile } = (await put.json()) as { profile: Record<string, unknown> };
    expect(profile["display_name"]).toBe("Evan");
    expect(profile["event_id"]).toBe("evt-1");
    expect(h.fourA.calls.filter((c) => c.method === "publishProfile")).toHaveLength(1);
    // Substrate got exactly the user's fields, nothing server-known.
    expect(JSON.parse(h.fourA.calls[0]!.arg)).toEqual({
      name: "evan108108",
      display_name: "Evan",
      about: "hi",
    });

    const get = await h.app.request("/api/v0/profile/me", { headers: bearer }, {});
    expect(get.status).toBe(200);
    const got = ((await get.json()) as { profile: Record<string, unknown> }).profile;
    expect(got["display_name"]).toBe("Evan");
    expect(got["pubkey"]).toBe(CALLER);
    // Fresh cache row from the PUT — the GET never touched 4a.
    expect(fetchCalls(h)).toHaveLength(0);
  });

  it("rejects over-cap and non-https fields with 400, never publishing", async () => {
    const h = makeHarness();
    const tooLong = await h.app.request(
      "/api/v0/profile/me",
      jsonReq("PUT", { display_name: "x".repeat(129) }),
      {},
    );
    expect(tooLong.status).toBe(400);
    const badPicture = await h.app.request(
      "/api/v0/profile/me",
      jsonReq("PUT", { picture: "http://not-tls.example/p.png" }),
      {},
    );
    expect(badPicture.status).toBe(400);
    expect(h.fourA.calls).toHaveLength(0);
  });
});

describe("GET /api/v0/profile/me seed fallback", () => {
  it("shows the login prefix for a fresh user without caching it", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/v0/profile/me", { headers: bearer }, {});
    expect(res.status).toBe(200);
    const { profile } = (await res.json()) as { profile: Record<string, unknown> };
    expect(profile["display_name"]).toBe("tester"); // login.split("@")[0]
    // The miss was cached (so we don't re-poll 4a) but WITHOUT the seeded
    // display_name — the substrate-truth row stays empty.
    const row = h.db.profiles.find((r) => r["pubkey"] === CALLER);
    expect(row).toBeDefined();
    expect(row!["display_name"]).toBeNull();
  });
});

describe("GET /api/v0/profile/:pubkey cache policy", () => {
  it("fetches on miss, serves from cache within the TTL", async () => {
    const h = makeHarness();
    h.fourA.profiles.set("github:42", {
      event_id: "evt-x",
      fields: { display_name: "Someone" },
      updated_at_ms: 500,
    });

    const first = await h.app.request("/api/v0/profile/github:42", { headers: bearer }, {});
    expect(first.status).toBe(200);
    expect(((await first.json()) as { profile: Row }).profile["display_name"]).toBe("Someone");
    expect(fetchCalls(h)).toHaveLength(1);

    const second = await h.app.request("/api/v0/profile/github:42", { headers: bearer }, {});
    expect(second.status).toBe(200);
    expect(fetchCalls(h)).toHaveLength(1); // cache hit — no second 4a call
  });

  it("refreshes past the TTL and falls back to the stale row when 4a is down", async () => {
    const h = makeHarness();
    h.fourA.profiles.set("github:42", {
      event_id: "evt-x",
      fields: { display_name: "Someone" },
      updated_at_ms: 500,
    });
    await h.app.request("/api/v0/profile/github:42", { headers: bearer }, {});
    expect(fetchCalls(h)).toHaveLength(1);

    vi.setSystemTime(1_000_000 + PROFILE_CACHE_TTL_MS + 1);
    await h.app.request("/api/v0/profile/github:42", { headers: bearer }, {});
    expect(fetchCalls(h)).toHaveLength(2); // stale → refreshed

    vi.setSystemTime(1_000_000 + 2 * (PROFILE_CACHE_TTL_MS + 1));
    h.fourA.failFetches = true;
    const degraded = await h.app.request("/api/v0/profile/github:42", { headers: bearer }, {});
    expect(degraded.status).toBe(200);
    expect(((await degraded.json()) as { profile: Row }).profile["display_name"]).toBe("Someone");
  });

  it("returns 200 with empty fields for a pubkey with no kind 0", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/v0/profile/github:999", { headers: bearer }, {});
    expect(res.status).toBe(200);
    const { profile } = (await res.json()) as { profile: Row };
    expect(profile["pubkey"]).toBe("github:999");
    expect(profile["display_name"]).toBeNull();
    expect(profile["event_id"]).toBeNull();
  });
});

describe("GET /api/v0/profile?pubkeys= bulk", () => {
  it("resolves a deduped list in one response", async () => {
    const h = makeHarness();
    h.fourA.profiles.set("a:1", { event_id: "e1", fields: { name: "ay" }, updated_at_ms: 1 });
    const res = await h.app.request(
      "/api/v0/profile?pubkeys=a:1,b:2,a:1",
      { headers: bearer },
      {},
    );
    expect(res.status).toBe(200);
    const { profiles } = (await res.json()) as { profiles: Row[] };
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p["pubkey"])).toEqual(["a:1", "b:2"]);
    expect(profiles[0]!["name"]).toBe("ay");
  });

  it(`rejects more than ${BULK_MAX} pubkeys`, async () => {
    const h = makeHarness();
    const many = Array.from({ length: BULK_MAX + 1 }, (_, i) => `p:${i}`).join(",");
    const res = await h.app.request(`/api/v0/profile?pubkeys=${many}`, { headers: bearer }, {});
    expect(res.status).toBe(400);
    expect(fetchCalls(h)).toHaveLength(0);
  });
});

describe("GET /api/v0/profile/me OAuth picture seed", () => {
  const pictureBearer = { Authorization: "Bearer evenflow-test-token-with-picture" };

  it("seeds picture from the JWT claim with seeded_from=oauth, without caching it", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/v0/profile/me", { headers: pictureBearer }, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profile: Record<string, unknown>; seeded_from: string | null };
    expect(body.profile["picture"]).toBe("https://avatars.example/me.png");
    expect(body.seeded_from).toBe("oauth");
    // Cached miss row keeps picture null — the seed is response-only.
    const row = h.db.profiles.find((r) => r["pubkey"] === CALLER);
    expect(row).toBeDefined();
    expect(row!["picture"]).toBeNull();
  });

  it("does not seed when the cached profile already has a picture", async () => {
    const h = makeHarness();
    h.fourA.profiles.set(CALLER, {
      event_id: "evt-p",
      fields: { picture: "https://chosen.example/pic.png" },
      updated_at_ms: 999,
    });
    const res = await h.app.request("/api/v0/profile/me", { headers: pictureBearer }, {});
    const body = (await res.json()) as { profile: Record<string, unknown>; seeded_from: string | null };
    expect(body.profile["picture"]).toBe("https://chosen.example/pic.png");
    expect(body.seeded_from).toBeNull();
  });

  it("seeded_from is null for tokens without a picture claim", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/v0/profile/me", { headers: bearer }, {});
    const body = (await res.json()) as { seeded_from: string | null };
    expect(body.seeded_from).toBeNull();
  });
});

describe("POST /api/v0/profile/picture", () => {
  it("uploads JSON base64 bytes through 4a and returns the blob URL", async () => {
    const h = makeHarness();
    const bytes = "hello"; // 5 bytes
    const res = await h.app.request(
      "/api/v0/profile/picture",
      jsonReq("POST", { image_b64: btoa(bytes), content_type: "image/png" }),
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; sha256: string };
    expect(body.url).toBe("https://api.4a4.ai/blossom/test-sha-5");
    expect(h.fourA.calls.filter((c) => c.method === "uploadBlob")).toEqual([
      { method: "uploadBlob", arg: "image/png:5" },
    ]);
    // No kind 0 published — preview-before-publish.
    expect(h.fourA.calls.filter((c) => c.method === "publishProfile")).toHaveLength(0);
  });

  it("uploads a multipart file", async () => {
    const h = makeHarness();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(7)], "me.webp", { type: "image/webp" }));
    const res = await h.app.request(
      "/api/v0/profile/picture",
      { method: "POST", headers: bearer, body: form },
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe("https://api.4a4.ai/blossom/test-sha-7");
  });

  it("rejects disallowed content types with 400", async () => {
    const h = makeHarness();
    const res = await h.app.request(
      "/api/v0/profile/picture",
      jsonReq("POST", { image_b64: btoa("x"), content_type: "image/gif" }),
      {},
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "unsupported-image-type" });
    expect(h.fourA.calls).toHaveLength(0);
  });

  it("rejects oversized images with 400 before touching 4a", async () => {
    const h = makeHarness();
    const big = btoa("a".repeat(256 * 1024 + 1));
    const res = await h.app.request(
      "/api/v0/profile/picture",
      jsonReq("POST", { image_b64: big, content_type: "image/jpeg" }),
      {},
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "image-too-large" });
    expect(h.fourA.calls).toHaveLength(0);
  });

  it("rejects malformed base64 with 400", async () => {
    const h = makeHarness();
    const res = await h.app.request(
      "/api/v0/profile/picture",
      jsonReq("POST", { image_b64: "not!!valid@@b64", content_type: "image/png" }),
      {},
    );
    expect(res.status).toBe(400);
  });
});
