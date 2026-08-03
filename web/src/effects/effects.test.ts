// Browser-side Effect service tests: AuthManager against jsdom
// localStorage, ApiClient against a stubbed fetch, and the SSE frame
// parser against realistic BoardDO output.

import { afterEach, describe, expect, it, vi } from "vitest";
import { url } from "@routes-manifest";
import { Effect, Layer } from "effect";
import {
  ApiClient,
  ApiClientLive,
  ApiConfigLive,
  AuthManager,
  AuthManagerLive,
  makeAuthManagerTest,
  parseSseBuffer,
  type ApiError,
} from "./index";

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const runWith = <A, E>(layer: Layer.Layer<never, never, never> | Layer.Layer<any>, program: Effect.Effect<A, E, any>) =>
  Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, E>);

describe("AuthManager", () => {
  it("persists, reads, and clears the JWT via localStorage", async () => {
    const program = Effect.gen(function* () {
      const auth = yield* AuthManager;
      expect(yield* auth.get()).toBeNull();
      yield* auth.set("jwt-abc");
      const stored = yield* auth.get();
      yield* auth.clear();
      const cleared = yield* auth.get();
      return { stored, cleared };
    });
    const out = await runWith(AuthManagerLive, program);
    expect(out).toEqual({ stored: "jwt-abc", cleared: null });
    expect(window.localStorage.getItem("evenflow.jwt")).toBeNull();
  });
});

describe("ApiClient", () => {
  const clientLayer = (jwt: string | null) => {
    const auth = makeAuthManagerTest(jwt);
    return Layer.provide(ApiClientLive, Layer.mergeAll(ApiConfigLive, auth.layer));
  };

  it("GETs the right URL with a Bearer header and parses the JSON", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ boards: [], total: 0 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runWith(
      clientLayer("tok-123"),
      Effect.gen(function* () {
        const client = yield* ApiClient;
        return yield* client.get<{ boards: unknown[]; total: number }>(url("board.create"));
      }),
    );

    expect(result).toEqual({ boards: [], total: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(url("board.create"));
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-123");
  });

  it("omits Authorization when signed out and fails typed on HTTP errors", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const client = yield* ApiClient;
          return yield* client.get(url("board.create"));
        }),
        clientLayer(null),
      ) as Effect.Effect<unknown, ApiError>,
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toMatchObject({ _tag: "ApiError", reason: "http", status: 401 });
    }
  });

  it("EFB-10: 401 with a bad-token reason clears AuthManager and reloads", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "unauthorized", reason: "expired" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // Trap window.location.href assignment so the test doesn't actually
    // navigate. jsdom's window.location is writable via defineProperty.
    const originalHref = window.location.href;
    let navigated: string | null = null;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new Proxy(window.location, {
        set(_target, prop, value) {
          if (prop === "href") {
            navigated = value as string;
            return true;
          }
          return true;
        },
      }),
    });

    const auth = makeAuthManagerTest("tok-abc");
    await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const client = yield* ApiClient;
          return yield* client.get(url("session.bootstrap"));
        }),
        Layer.provide(ApiClientLive, Layer.mergeAll(ApiConfigLive, auth.layer)),
      ),
    );
    // Restore before assertions in case they throw.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: originalHref },
    });

    expect(navigated).toBe("/");
    const stillHeld = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(AuthManager, (a) => a.get()),
        auth.layer,
      ),
    );
    expect(stillHeld).toBeNull();
  });

  it("EFB-10: 401 without a Bearer does NOT clear or reload", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "unauthorized", reason: "expired" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let navigated: string | null = null;
    const originalHref = window.location.href;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new Proxy(window.location, {
        set(_target, prop, value) {
          if (prop === "href") navigated = value as string;
          return true;
        },
      }),
    });

    await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const client = yield* ApiClient;
          return yield* client.get(url("board.create"));
        }),
        clientLayer(null),
      ),
    );
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: originalHref },
    });
    expect(navigated).toBeNull();
  });

  it("POST sends a JSON body", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ board: { slug: "kb" } }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await runWith(
      clientLayer("tok-123"),
      Effect.gen(function* () {
        const client = yield* ApiClient;
        return yield* client.post(url("board.create"), { slug: "kb", title: "Board" });
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ slug: "kb", title: "Board" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});

describe("parseSseBuffer", () => {
  it("extracts events, drops heartbeats, and keeps the partial tail", () => {
    const frame = (kind: string) =>
      `event: ${kind}\ndata: ${JSON.stringify({ kind, board_id: "b1", at_ms: 1, payload: {} })}\n\n`;
    const buffer = `: connected\n\n${frame("issue.created")}: heartbeat\n\n${frame("issue.updated")}event: issue.deleted\ndata: {"kind":"issue.del`;
    const [events, rest] = parseSseBuffer(buffer);
    expect(events.map((e) => e.kind)).toEqual(["issue.created", "issue.updated"]);
    expect(rest.startsWith("event: issue.deleted")).toBe(true);
  });
});
