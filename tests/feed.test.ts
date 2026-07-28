import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALLER,
  bearer,
  createBoard,
  createIssue,
  jsonReq,
  makeHarness,
  seedForeignBoardAndIssue,
  type Harness,
} from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

interface FeedItem {
  id: string;
  issue_id: string;
  issue_title: string | null;
  actor_pubkey: string;
  kind: string;
  from: string | null;
  to: string | null;
  occurred_at_ms: number;
}
type FeedBody = { activity: FeedItem[]; has_more: boolean };

const getActivity = async (h: Harness, qs = "", slug = "kb") => {
  const res = await h.app.request(`/api/v0/boards/${slug}/activity${qs}`, { headers: bearer }, {});
  return { res, body: (await res.json()) as FeedBody };
};

/** Board + one issue that then transitions (t=2000) and moves container (t=3000). */
const seedThreeKinds = async (h: Harness) => {
  await createBoard(h);
  const issue = await createIssue(h); // creation row @1000
  vi.setSystemTime(2_000);
  await h.app.request(
    `/api/v0/issues/${issue.id}/transition`,
    jsonReq("POST", { to_status: "In Progress" }),
    {},
  );
  vi.setSystemTime(3_000);
  await h.app.request(`/api/v0/issues/${issue.id}/send_to_icebox`, jsonReq("POST"), {});
  return issue;
};

describe("GET /api/v0/boards/:slug/activity", () => {
  it("returns items newest-first with kind inference and title enrichment", async () => {
    const h = makeHarness();
    const issue = await seedThreeKinds(h);
    const { res, body } = await getActivity(h);
    expect(res.status).toBe(200);
    expect(body.has_more).toBe(false);
    expect(body.activity).toHaveLength(3);
    expect(body.activity.map((a) => a.kind)).toEqual(["container", "status", "creation"]);
    expect(body.activity.map((a) => a.occurred_at_ms)).toEqual([3_000, 2_000, 1_000]);
    expect(body.activity[0]).toMatchObject({
      issue_id: issue.id,
      issue_title: "An issue",
      actor_pubkey: CALLER,
      from: "backlog",
      to: "icebox",
    });
    expect(body.activity[1]).toMatchObject({ from: "Backlog", to: "In Progress" });
    expect(body.activity[2]).toMatchObject({ from: null, to: "Backlog" });
  });

  it("filters by ?type= and rejects unknown types", async () => {
    const h = makeHarness();
    await seedThreeKinds(h);
    for (const [type, kind] of [
      ["creation", "creation"],
      ["status", "status"],
      ["container", "container"],
    ] as const) {
      const { body } = await getActivity(h, `?type=${type}`);
      expect(body.activity).toHaveLength(1);
      expect(body.activity[0]!.kind).toBe(kind);
    }
    const { res } = await getActivity(h, "?type=bogus");
    expect(res.status).toBe(400);
  });

  it("keyset-paginates via ?after= and flags has_more", async () => {
    const h = makeHarness();
    await seedThreeKinds(h);
    const first = await getActivity(h, "?limit=1");
    expect(first.body.activity).toHaveLength(1);
    expect(first.body.has_more).toBe(true);
    const second = await getActivity(h, `?limit=2&after=${first.body.activity[0]!.id}`);
    expect(second.body.activity.map((a) => a.occurred_at_ms)).toEqual([2_000, 1_000]);
    expect(second.body.has_more).toBe(false);
  });

  it("rejects an unknown ?after= anchor and a bad limit", async () => {
    const h = makeHarness();
    await seedThreeKinds(h);
    expect((await getActivity(h, "?after=nope")).res.status).toBe(400);
    expect((await getActivity(h, "?limit=0")).res.status).toBe(400);
  });

  it("returns issue_title null once the issue is deleted (audit rows outlive it)", async () => {
    const h = makeHarness();
    const issue = await seedThreeKinds(h);
    const del = await h.app.request(`/api/v0/issues/${issue.id}`, jsonReq("DELETE"), {});
    expect(del.status).toBe(200);
    const { body } = await getActivity(h);
    expect(body.activity).toHaveLength(3);
    expect(body.activity.every((a) => a.issue_title === null)).toBe(true);
  });

  it("404s a board the caller does not own and 401s without auth", async () => {
    const h = makeHarness();
    seedForeignBoardAndIssue(h);
    expect((await getActivity(h, "", "theirs")).res.status).toBe(404);
    const res = await h.app.request("/api/v0/boards/kb/activity", {}, {});
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v0/boards/:slug/stream", () => {
  const fakeBoardNs = (subscribed: string[]) =>
    ({
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        fetch: async (url: string) => {
          subscribed.push(`${String(id)} ${url}`);
          return new Response("do-stream", { status: 200 });
        },
      }),
    }) as unknown as DurableObjectNamespace;

  it("proxies the board DO's subscribe stream with SSE headers", async () => {
    const h = makeHarness();
    await createBoard(h);
    const subscribed: string[] = [];
    const res = await h.app.request(
      "/api/v0/boards/kb/stream",
      { headers: bearer },
      { BOARD: fakeBoardNs(subscribed) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(await res.text()).toBe("do-stream");
    expect(subscribed).toHaveLength(1);
    expect(subscribed[0]).toContain("/subscribe");
    expect(subscribed[0]).toContain(h.db.boards[0]!["id"] as string); // idFromName(board_id)
  });

  it("401s without auth, 404s an unowned board, 500s without the binding", async () => {
    const h = makeHarness();
    await createBoard(h);
    seedForeignBoardAndIssue(h);
    expect((await h.app.request("/api/v0/boards/kb/stream", {}, {})).status).toBe(401);
    const foreign = await h.app.request(
      "/api/v0/boards/theirs/stream",
      { headers: bearer },
      { BOARD: fakeBoardNs([]) },
    );
    expect(foreign.status).toBe(404);
    const unbound = await h.app.request("/api/v0/boards/kb/stream", { headers: bearer }, {});
    expect(unbound.status).toBe(500);
  });
});

describe("BoardEmitter wire-up (mutations fan out through the emitter)", () => {
  it("captures issue lifecycle events with the board id", async () => {
    const h = makeHarness();
    const issue = await seedThreeKinds(h);
    await h.app.request(`/api/v0/issues/${issue.id}`, jsonReq("PATCH", { title: "Renamed" }), {});
    await h.app.request(`/api/v0/issues/${issue.id}`, jsonReq("DELETE"), {});
    const boardId = h.db.boards[0]!["id"];
    expect(h.emitter.events.map((e) => e.event.kind)).toEqual([
      "issue.created",
      "issue.transitioned",
      "issue.container_changed",
      "issue.updated",
      "issue.deleted",
    ]);
    expect(h.emitter.events.every((e) => e.board_id === boardId)).toBe(true);
    expect(h.emitter.events.every((e) => e.event.board_id === boardId)).toBe(true);
    expect(h.emitter.events.every((e) => e.event.issue_id === issue.id)).toBe(true);
  });

  it("does not emit for a no-op transition or container move", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h); // status Backlog, container backlog
    h.emitter.events.length = 0;
    await h.app.request(
      `/api/v0/issues/${issue.id}/transition`,
      jsonReq("POST", { to_status: "Backlog" }),
      {},
    );
    await h.app.request(`/api/v0/issues/${issue.id}/promote_to_backlog`, jsonReq("POST"), {});
    expect(h.emitter.events).toHaveLength(0);
  });

  it("captures comment.created and comment.deleted with issue + comment ids", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    h.emitter.events.length = 0;
    const created = await h.app.request(
      `/api/v0/issues/${issue.id}/comments`,
      jsonReq("POST", { body: "hello" }),
      {},
    );
    expect(created.status).toBe(201);
    const commentId = ((await created.json()) as { comment: { id: string } }).comment.id;
    await h.app.request(`/api/v0/comments/${commentId}`, jsonReq("DELETE"), {});
    expect(h.emitter.events.map((e) => e.event.kind)).toEqual([
      "comment.created",
      "comment.deleted",
    ]);
    expect(
      h.emitter.events.every(
        (e) => e.event.issue_id === issue.id && e.event.comment_id === commentId,
      ),
    ).toBe(true);
  });
});
