// Board store tests over a capturing ApiClient layer: endpoint dispatch,
// optimistic updates + rollback, and the velocity bucketing math.

import { describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ApiClient, ApiError } from "../../effects";
import type { Board, Issue } from "../../lib/types";
import { velocityBuckets } from "./BoardPage";
import { createBoardStore, type RunApi } from "./store";

export const FAIL = Symbol("fail");

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** ApiClient stub: canned responses keyed by "METHOD path"; FAIL → 500. */
const makeTestRun = (routes: Record<string, unknown>) => {
  const calls: Call[] = [];
  const respond = <T>(method: string, path: string, body?: unknown): Effect.Effect<T, ApiError> =>
    Effect.suspend(() => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      const canned = routes[`${method} ${path}`];
      if (canned === undefined || canned === FAIL) {
        return Effect.fail(new ApiError({ reason: "http", status: canned === FAIL ? 500 : 404 }));
      }
      return Effect.succeed(canned as T);
    });
  const layer = Layer.succeed(ApiClient, {
    get: (p) => respond("GET", p),
    post: (p, b) => respond("POST", p, b),
    put: (p, b) => respond("PUT", p, b),
    patch: (p, b) => respond("PATCH", p, b),
    delete: (p) => respond("DELETE", p),
  });
  const runtime = ManagedRuntime.make(layer);
  const run: RunApi = (effect) => runtime.runPromise(effect);
  return { calls, run };
};

const board: Board = {
  id: "b1",
  pubkey: "test:0",
  slug: "kb",
  title: "Board",
  description: null,
  columns: ["Backlog", "In Progress", "Done"],
  labels: [],
  member_policy: "invite",
  is_encrypted: false,
  issue_prefix: "KB",
  next_issue_number: 2,
  created_at_ms: 1,
  updated_at_ms: 1,
};

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: "i1",
  short_id: "KB-1",
  board_id: "b1",
  title: "An issue",
  body: null,
  status: "Backlog",
  container: "active",
  assignee_pubkey: null,
  priority: null,
  estimate: 3,
  labels: [],
  github_links: [],
  created_at_ms: 1,
  updated_at_ms: 1,
  completed_at_ms: null,
  ...over,
});

const LOAD_ROUTES = {
  "GET /api/v0/boards/kb": { board },
  "GET /api/v0/boards/kb/issues?limit=100": { issues: [issue()] },
};

const loadedStore = async (extraRoutes: Record<string, unknown> = {}) => {
  const { calls, run } = makeTestRun({ ...LOAD_ROUTES, ...extraRoutes });
  const store = createBoardStore("kb", run);
  await store.load();
  calls.length = 0;
  return { store, calls };
};

describe("createBoardStore", () => {
  it("load() fetches the board and its issues", async () => {
    const { run, calls } = makeTestRun(LOAD_ROUTES);
    const store = createBoardStore("kb", run);
    await store.load();
    expect(store.board()?.slug).toBe("kb");
    expect(store.issues()).toHaveLength(1);
    expect(store.loading()).toBe(false);
    // Promise.all starts both requests; completion order is not guaranteed.
    expect(calls.map((c) => c.path).sort()).toEqual([
      "/api/v0/boards/kb",
      "/api/v0/boards/kb/issues?limit=100",
    ]);
  });

  it("transition posts to /transition and applies the server issue", async () => {
    const { store, calls } = await loadedStore({
      "POST /api/v0/issues/i1/transition": { issue: issue({ status: "Done", updated_at_ms: 9 }) },
    });
    await store.transition(store.issues()[0]!, "Done");
    expect(calls).toEqual([
      { method: "POST", path: "/api/v0/issues/i1/transition", body: { to_status: "Done" } },
    ]);
    expect(store.issues()[0]!.status).toBe("Done");
  });

  it("rolls the optimistic update back when the API fails", async () => {
    const { store, calls } = await loadedStore({ "POST /api/v0/issues/i1/transition": FAIL });
    await store.transition(store.issues()[0]!, "Done");
    expect(calls).toHaveLength(1);
    expect(store.issues()[0]!.status).toBe("Backlog");
    expect(store.lastError()).toContain("500");
  });

  it("moveContainer hits the right verb for each container and skips no-ops", async () => {
    const { store, calls } = await loadedStore({
      "POST /api/v0/issues/i1/send_to_icebox": { issue: issue({ container: "icebox" }) },
      "POST /api/v0/issues/i1/promote_to_backlog": { issue: issue({ container: "backlog" }) },
      "POST /api/v0/issues/i1/promote_to_active": { issue: issue({ container: "active" }) },
    });
    await store.moveContainer(store.issues()[0]!, "promote_to_active"); // already active → no-op
    expect(calls).toHaveLength(0);
    await store.moveContainer(store.issues()[0]!, "send_to_icebox");
    await store.moveContainer(store.issues()[0]!, "promote_to_backlog");
    await store.moveContainer(store.issues()[0]!, "promote_to_active");
    expect(calls.map((c) => c.path)).toEqual([
      "/api/v0/issues/i1/send_to_icebox",
      "/api/v0/issues/i1/promote_to_backlog",
      "/api/v0/issues/i1/promote_to_active",
    ]);
    expect(store.issues()[0]!.container).toBe("active");
  });

  it("createIssue posts the input shape and prepends the result", async () => {
    const { store, calls } = await loadedStore({
      "POST /api/v0/boards/kb/issues": { issue: issue({ id: "i2", title: "Fresh" }) },
    });
    await store.createIssue({ title: "Fresh", container: "backlog", estimate: 5 });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v0/boards/kb/issues",
        body: { title: "Fresh", container: "backlog", estimate: 5 },
      },
    ]);
    expect(store.issues().map((i) => i.id)).toEqual(["i2", "i1"]);
  });
});

describe("velocityBuckets", () => {
  const NOW = 8 * 86_400_000;
  const doneAt = (ms: number, cac: string | null, issue_id = "i1") => ({
    to: "Done",
    container_at_completion: cac,
    occurred_at_ms: ms,
    issue_id,
  });

  it("sums only Done-in-active completions inside the trailing week", () => {
    const feed = [
      doneAt(NOW - 1 * 86_400_000, "active"), // yesterday → bucket 6ish
      doneAt(NOW - 1 * 86_400_000, "icebox"), // wrong container → dropped
      doneAt(NOW - 10 * 86_400_000, "active"), // too old → dropped
      { to: "In Progress", container_at_completion: null, occurred_at_ms: NOW - 1, issue_id: "i1" },
    ];
    const buckets = velocityBuckets(feed, () => 3, NOW);
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(3);
  });
});
