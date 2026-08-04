// Board store tests over a capturing ApiClient layer: endpoint dispatch,
// optimistic updates + rollback.

import { describe, expect, it, vi } from "vitest";
import { url } from "@routes-manifest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ApiClient, ApiError } from "../../effects";
import type { Board, Issue } from "../../lib/types";
import type { Column } from "../../lib/columns";
import { createBoardStore, type RunApi } from "./store";

export const FAIL = Symbol("fail");

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * ApiClient stub: canned responses keyed by "METHOD path"; FAIL → 500.
 *
 * EFB-98: a key may also hold a seq([...]) of responses consumed in order.
 * Before the migration, three container moves meant three URLs, so keying on
 * the path alone distinguished them. They are one route now with the
 * destination in the body, so successive calls share a key and the stub has to
 * be able to answer them differently.
 */
const SEQ = Symbol("seq");
const seq = (...responses: unknown[]) => ({ [SEQ]: responses });
const makeTestRun = (routes: Record<string, unknown>) => {
  const calls: Call[] = [];
  const respond = <T>(method: string, path: string, body?: unknown): Effect.Effect<T, ApiError> =>
    Effect.suspend(() => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      let canned = routes[`${method} ${path}`];
      if (canned !== null && typeof canned === "object" && SEQ in canned) {
        const queue = (canned as { [SEQ]: unknown[] })[SEQ];
        canned = queue.length > 1 ? queue.shift() : queue[0];
      }
      if (canned === undefined || canned === FAIL) {
        return Effect.fail(new ApiError({ reason: "http", status: canned === FAIL ? 500 : 404 }));
      }
      // EFB-104: a canned value may be a thunk returning a promise the test
      // resolves by hand. The self-heal races are all about WHEN a response
      // lands relative to a write, and a stub that answers immediately cannot
      // express "this poll was issued before the write and returns after it".
      if (typeof canned === "function") {
        return Effect.tryPromise({
          try: () => (canned as () => Promise<T>)(),
          catch: () => new ApiError({ reason: "http", status: 500 }),
        });
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

const col = (id: string, name: string, order: number, category: Column["category"]): Column => ({
  id,
  name,
  order,
  enabled: true,
  category,
});

const COLUMNS: Column[] = [
  col("c1", "Backlog", 0, "todo"),
  col("c2", "In Progress", 1, "in_progress"),
  col("c3", "Done", 2, "done"),
];

const board: Board = {
  id: "b1",
  pubkey: "test:0",
  slug: "kb",
  title: "Board",
  description: null,
  columns: COLUMNS,
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
  body_format: "markdown",
  type: "task",
  status: "Backlog",
  column_id: "c1",
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

// Phase 22: load() no longer does one flat fetch — it primes one paged
// stream per enabled column plus the two side-lists. The issue lives in c1
// so the other streams answer empty.
const emptyPage = { issues: [], has_more: false, next_after: null };
const page = (issues: unknown[]) => ({ issues, has_more: false, next_after: null });

const LOAD_ROUTES = {
  [`GET ${url("board.get", { slug: "kb" })}`]: { board },
  [`GET ${url("sprint.list", { slug: "kb" })}`]: { sprints: [] },
  [`GET ${url("issue.list", { slug: "kb" })}?container=active&limit=50&column_id=c1`]: page([issue()]),
  [`GET ${url("issue.list", { slug: "kb" })}?container=active&limit=50&column_id=c2`]: emptyPage,
  [`GET ${url("issue.list", { slug: "kb" })}?container=active&limit=50&column_id=c3`]: emptyPage,
  [`GET ${url("issue.list", { slug: "kb" })}?container=backlog&limit=50`]: emptyPage,
  [`GET ${url("issue.list", { slug: "kb" })}?container=icebox&limit=50`]: emptyPage,
};

const loadedStore = async (extraRoutes: Record<string, unknown> = {}) => {
  // `routes` is returned so a test can model the SERVER CHANGING mid-test:
  // after a transition the source column no longer contains the card and
  // the target does, which a static route map cannot express.
  const routes: Record<string, unknown> = { ...LOAD_ROUTES, ...extraRoutes };
  const { calls, run } = makeTestRun(routes);
  const store = createBoardStore("kb", run);
  await store.load();
  calls.length = 0;
  return { store, calls, routes };
};

describe("createBoardStore", () => {
  it("load() fetches the board and its issues", async () => {
    const { run, calls } = makeTestRun(LOAD_ROUTES);
    const store = createBoardStore("kb", run);
    await store.load();
    expect(store.board()?.slug).toBe("kb");
    expect(store.issues()).toHaveLength(1);
    expect(store.loading()).toBe(false);
    // Board + sprints in parallel + members (best-effort, feeds the
    // assignee dropdown), then one primed page per stream.
    expect(calls.map((c) => c.path).sort()).toEqual([
      url("board.get", { slug: "kb" }),
      `${url("issue.create", { slug: "kb" })}?container=active&limit=50&column_id=c1`,
      `${url("issue.create", { slug: "kb" })}?container=active&limit=50&column_id=c2`,
      `${url("issue.create", { slug: "kb" })}?container=active&limit=50&column_id=c3`,
      `${url("issue.create", { slug: "kb" })}?container=backlog&limit=50`,
      `${url("issue.create", { slug: "kb" })}?container=icebox&limit=50`,
      url("sprint.list", { slug: "kb" }),
    ]);
  });

  it("transition posts the target column_id and applies the server issue", async () => {
    const moved = issue({ status: "Done", column_id: "c3", updated_at_ms: 9 });
    const { store, calls, routes } = await loadedStore({
      [`POST ${url("issue.transition", { id: "i1" })}`]: { issue: moved },
    });
    // The card has left c1 and joined c3 as far as the server is concerned.
    routes[`GET ${url("issue.list", { slug: "kb" })}?container=active&limit=50&column_id=c1`] = page([]);
    routes[`GET ${url("issue.list", { slug: "kb" })}?container=active&limit=50&column_id=c3`] = page([moved]);
    await store.transition(store.issues()[0]!, COLUMNS[2]!);
    // The POST, then a re-primed first page for BOTH sides of the move —
    // the source stream lost a row before its cursor and the target gained
    // one, so leaving either stale would skip a card on the next page.
    expect(calls.map((c) => c.path)).toEqual([
      url("issue.transition", { id: "i1" }),
      `${url("issue.create", { slug: "kb" })}?container=active&limit=50&column_id=c1`,
      `${url("issue.create", { slug: "kb" })}?container=active&limit=50&column_id=c3`,
    ]);
    expect(calls[0]).toEqual({
      method: "POST",
      path: url("issue.transition", { id: "i1" }),
      body: { column_id: "c3" },
    });
    expect(store.issues()[0]!.status).toBe("Done");
    expect(store.issues()[0]!.column_id).toBe("c3");
  });

  it("rolls the optimistic update back when the API fails", async () => {
    const { store, calls } = await loadedStore({ [`POST ${url("issue.transition", { id: "i1" })}`]: FAIL });
    await store.transition(store.issues()[0]!, COLUMNS[2]!);
    // Failed POST + the two stream re-primes, which run regardless so the
    // rolled-back view still matches the server.
    expect(calls[0]!.path).toBe(url("issue.transition", { id: "i1" }));
    expect(store.issues()[0]!.status).toBe("Backlog");
    expect(store.issues()[0]!.column_id).toBe("c1");
    expect(store.lastError()).toContain("500");
  });

  it("moveContainer sends the destination in the body and skips no-ops", async () => {
    const { store, calls } = await loadedStore({
      [`POST ${url("issue.container.set", { id: "i1" })}`]: seq(
        { issue: issue({ container: "icebox" }) },
        { issue: issue({ container: "backlog" }) },
        { issue: issue({ container: "active" }) },
      ),
    });
    await store.moveContainer(store.issues()[0]!, "promote_to_active"); // already active → no-op
    expect(calls).toHaveLength(0);
    await store.moveContainer(store.issues()[0]!, "send_to_icebox");
    await store.moveContainer(store.issues()[0]!, "promote_to_backlog");
    await store.moveContainer(store.issues()[0]!, "promote_to_active");
    // Stream re-primes are interleaved; assert the destinations in order.
    // One URL now, so the sequence lives in the bodies rather than the paths.
    const target = url("issue.container.set", { id: "i1" });
    expect(
      calls.filter((c) => c.path === target).map((c) => (c.body as { container: string }).container),
    ).toEqual(["icebox", "backlog", "active"]);
    expect(store.issues()[0]!.container).toBe("active");
  });

  it("createIssue posts the input shape and prepends the result", async () => {
    const { store, calls } = await loadedStore({
      [`POST ${url("issue.create", { slug: "kb" })}`]: { issue: issue({ id: "i2", title: "Fresh" }) },
    });
    await store.createIssue({ title: "Fresh", container: "backlog", estimate: 5 });
    expect(calls).toEqual([
      {
        method: "POST",
        path: url("issue.create", { slug: "kb" }),
        body: { title: "Fresh", container: "backlog", estimate: 5 },
      },
    ]);
    expect(store.issues().map((i) => i.id)).toEqual(["i2", "i1"]);
  });

  it("sprint membership posts add-issue / remove-issue and rolls back on failure", async () => {
    const { store, calls } = await loadedStore({
      [`POST ${url("sprint.issues.attach", { slug: "kb", id: "s1" })}`]: {
        issue: issue({ sprint_id: "s1" }),
      },
      [`DELETE ${url("sprint.issue.detach", { slug: "kb", id: "s1", issue_id: "i1" })}`]: FAIL,
    });
    await store.addIssueToSprint(store.issues()[0]!, "s1");
    expect(calls).toEqual([
      {
        method: "POST",
        path: url("sprint.issues.attach", { slug: "kb", id: "s1" }),
        body: { issue_id: "i1" },
      },
    ]);
    expect(store.issues()[0]!.sprint_id).toBe("s1");
    await store.removeIssueFromSprint(store.issues()[0]!);
    // Rollback: the failed remove leaves the membership in place.
    expect(store.issues()[0]!.sprint_id).toBe("s1");
    expect(store.lastError()).toContain("500");
  });

  it("startSprint posts the kickoff then refetches issues", async () => {
    const started = {
      id: "s1",
      board_id: "b1",
      name: "Sprint 1",
      goal: null,
      status: "active" as const,
      started_at_ms: 9,
      completed_at_ms: null,
      created_at_ms: 1,
    };
    const { store, calls } = await loadedStore({
      [`GET ${url("sprint.list", { slug: "kb" })}`]: { sprints: [{ ...started, status: "planning", started_at_ms: null }] },
      [`POST ${url("sprint.start", { slug: "kb", id: "s1" })}`]: { sprint: started },
    });
    await store.refetchSprints();
    calls.length = 0;
    await store.startSprint("s1");
    expect(calls.map((c) => c.path)).toContain(url("sprint.start", { slug: "kb", id: "s1" }));
    expect(store.sprints()[0]!.status).toBe("active");
  });
});

// ── EFB-104: poll self-heal + shadow set ──────────────────────────────────
//
// Every test here is a TIMELINE, because every bug in this area is one. The
// stub answers a gated route only when the test resolves it by hand, so a
// response can be made to land before, during, or after a local write.
//
// The pair that matters:
//   - "poll heals ..." is the POSITIVE CONTROL. It proves a poll response
//     really does reach and overwrite issues[]. Without it, every assertion
//     below would also pass against a poll that silently did nothing.
//   - the two "cannot clobber" tests are the guard.
// Read them together; either alone proves nothing.
describe("EFB-104 self-heal", () => {
  /** A route whose response the test releases by hand. */
  const gated = <T>() => {
    let release!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
      release = resolve;
    });
    return { thunk: () => promise, release };
  };

  const C1 = `GET ${url("issue.list", { slug: "kb" })}?container=active&limit=50&column_id=c1`;
  const C2 = `GET ${url("issue.list", { slug: "kb" })}?container=active&limit=50&column_id=c2`;
  const C3 = `GET ${url("issue.list", { slug: "kb" })}?container=active&limit=50&column_id=c3`;

  it("poll heals drift the SSE stream never reported (positive control)", async () => {
    const { store, routes } = await loadedStore();
    expect(store.issues()[0]!.column_id).toBe("c1");

    // Someone transitioned the issue through the REST API — the exact EFB-102
    // shape. No BoardEvent reached us; the tab still shows the old column.
    const moved = issue({ status: "Done", column_id: "c3", updated_at_ms: 9 });
    routes[C1] = page([]);
    routes[C3] = page([moved]);

    await store.pollRefresh();

    expect(store.issues()).toHaveLength(1);
    expect(store.issues()[0]!.column_id).toBe("c3");
    expect(store.issues()[0]!.status).toBe("Done");
  });

  it("a poll landing mid-drag cannot pull the card back", async () => {
    const post = gated<{ issue: Issue }>();
    const { store, routes } = await loadedStore({
      [`POST ${url("issue.transition", { id: "i1" })}`]: post.thunk,
    });

    // t0 — user drops the card on Done. Optimistic write lands, shadow set,
    // POST fires. The SERVER still has it in c1 (LOAD_ROUTES is unchanged),
    // which is the whole point: the write has not been processed yet.
    const dropped = store.transition(store.issues()[0]!, COLUMNS[2]!);
    expect(store.issues()[0]!.column_id).toBe("c3");

    // t1..t3 — the poll runs and returns while the POST is still in flight.
    await store.pollRefresh();

    // Without the shadow set this is "c1" and the card visibly snaps back to
    // In Progress under the user's cursor.
    expect(store.issues()[0]!.column_id).toBe("c3");
    expect(store.issues()[0]!.status).toBe("Done");

    // t4 — the API confirms, and the server now agrees the card is in c3
    // (transition re-primes both streams' cursors, so those pages are read).
    const moved = issue({ status: "Done", column_id: "c3", updated_at_ms: 9 });
    routes[C1] = page([]);
    routes[C3] = page([moved]);
    post.release({ issue: moved });
    await dropped;
    expect(store.issues()[0]!.column_id).toBe("c3");
  });

  it("another user's SSE refetch mid-drag cannot clobber the drop either", async () => {
    const post = gated<{ issue: Issue }>();
    const { store } = await loadedStore({
      [`POST ${url("issue.transition", { id: "i1" })}`]: post.thunk,
    });

    const dropped = store.transition(store.issues()[0]!, COLUMNS[2]!);
    expect(store.issues()[0]!.column_id).toBe("c3");

    // BoardPage calls refetchIssues() on any issue.* event from another user.
    // It carries no epoch guard by design — their change must not be dropped —
    // so the shadow merge is the only thing protecting our in-flight cell.
    // This path predates EFB-104 and clobbered the same way a poll would.
    await store.refetchIssues();

    expect(store.issues()[0]!.column_id).toBe("c3");
    expect(store.issues()[0]!.status).toBe("Done");

    post.release({ issue: issue({ status: "Done", column_id: "c3", updated_at_ms: 9 }) });
    await dropped;
  });

  // The epoch guard's job is the half the shadow set CANNOT do: discard a
  // response about issues the write never touched, because that response
  // describes a board state that no longer exists.
  //
  // So the discriminator is a SECOND issue. i2 is never written to, so nothing
  // shadows it — if the response were merely shadow-merged, i2's stale title
  // would land. Only a wholesale discard keeps it out. Asserting on i1 instead
  // would prove nothing: the shadow set alone would satisfy it.
  const withTwoIssues = async (extra: Record<string, unknown> = {}) => {
    const i2 = issue({ id: "i2", short_id: "KB-2", title: "Second issue", status: "In Progress", column_id: "c2" });
    const loaded = await loadedStore({
      [`GET ${url("issue.list", { slug: "kb" })}?container=active&limit=50&column_id=c2`]: page([i2]),
      ...extra,
    });
    expect(loaded.store.issues()).toHaveLength(2);
    return loaded;
  };

  it("epoch guard discards a whole poll response overtaken by a write", async () => {
    const c2 = gated<unknown>();
    const { store, routes } = await withTwoIssues({
      [`POST ${url("issue.transition", { id: "i1" })}`]: {
        issue: issue({ status: "Done", column_id: "c3" }),
      },
    });
    // Gate c2 — the column the mid-flight write does NOT touch, so the write
    // can complete while the poll is still in the air.
    routes[C2] = c2.thunk;

    const polling = store.pollRefresh();

    // A drag lands while the poll is in flight. transition() re-primes c1 and
    // c3 only, so it does not block on the gate.
    routes[C1] = page([]);
    routes[C3] = page([issue({ status: "Done", column_id: "c3" })]);
    await store.transition(store.issues().find((i) => i.id === "i1")!, COLUMNS[2]!);

    c2.release(page([issue({ id: "i2", short_id: "KB-2", title: "STALE TITLE", column_id: "c2" })]));
    await polling;

    const i2After = store.issues().find((i) => i.id === "i2")!;
    expect(i2After.title).toBe("Second issue");
  });

  it("...and lets that same response through when no write overtook it", async () => {
    // Positive twin of the test above, identical but for the mid-flight write.
    // Without this, the assertion above would also pass against a poll that
    // silently dropped every response.
    const c2 = gated<unknown>();
    const { store, routes } = await withTwoIssues();
    routes[C2] = c2.thunk;

    const polling = store.pollRefresh();
    c2.release(page([issue({ id: "i2", short_id: "KB-2", title: "RENAMED ELSEWHERE", column_id: "c2" })]));
    await polling;

    expect(store.issues().find((i) => i.id === "i2")!.title).toBe("RENAMED ELSEWHERE");
  });

  it("the shadow releases on its TTL — a stuck write cannot freeze the board", async () => {
    const post = gated<{ issue: Issue }>();
    const { store, routes } = await loadedStore({
      [`POST ${url("issue.transition", { id: "i1" })}`]: post.thunk,
    });

    const real = Date.now();
    void store.transition(store.issues()[0]!, COLUMNS[2]!);
    expect(store.isFieldShadowed("i1", "column_id")).toBe(true);

    // The request never comes back. 5s later the cell is the server's again,
    // otherwise one hung POST would pin a card in place indefinitely.
    const clock = vi.spyOn(Date, "now").mockReturnValue(real + 6000);
    try {
      expect(store.isFieldShadowed("i1", "column_id")).toBe(false);

      const moved = issue({ status: "Done", column_id: "c3" });
      routes[C1] = page([]);
      routes[C3] = page([moved]);
      await store.pollRefresh();
      expect(store.issues()[0]!.column_id).toBe("c3");
    } finally {
      clock.mockRestore();
    }
  });
});
