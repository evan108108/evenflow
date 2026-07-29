import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALLER,
  bearer,
  jsonReq,
  makeHarness,
  seedForeignBoardAndIssue,
  type Harness,
} from "./harness";
import type { BoardShape } from "../src/shapes";

const createBoard = (h: Harness, overrides?: Record<string, unknown>) =>
  h.app.request("/api/v0/boards", jsonReq("POST", { slug: "kb", title: "Kanban", ...overrides }), {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/v0/boards", () => {
  it("creates a board with defaults in the caller's auto-created personal org", async () => {
    const h = makeHarness();
    const { db } = h;
    const res = await createBoard(h);
    expect(res.status).toBe(201);
    const { board, org } = (await res.json()) as { board: BoardShape; org: { slug: string } };
    expect(board).toMatchObject({
      pubkey: CALLER,
      slug: "kb",
      title: "Kanban",
      description: null,
      columns: ["Todo", "In Progress", "In Review", "Done"],
      labels: [],
      member_policy: "invite",
      is_encrypted: false,
      visibility: "private",
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
    });
    expect(board.id).toBeTruthy();
    // Personal org auto-created (login "tester" → slug "tester") + owner row
    // + creator's explicit board-admin grant.
    expect(org.slug).toBe("tester");
    expect(db.orgs).toHaveLength(1);
    expect(board.org_id).toBe(db.orgs[0]!["id"]);
    expect(db.orgMembers).toMatchObject([{ pubkey: CALLER, role: "owner" }]);
    expect(db.boardMembers).toMatchObject([{ board_id: board.id, pubkey: CALLER, role: "admin" }]);
    expect(db.boards).toHaveLength(1);
    // JSON columns hit storage as strings.
    expect(db.boards[0]!["columns"]).toBe(JSON.stringify(board.columns));
  });

  it("rejects a duplicate slug in the same org with 409", async () => {
    const h = makeHarness();
    expect((await createBoard(h)).status).toBe(201);
    const res = await createBoard(h, { title: "Second" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", reason: "slug-in-use" });
  });

  it("rejects an invalid slug with 400", async () => {
    const h = makeHarness();
    const res = await createBoard(h, { slug: "not a slug!" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "slug" });
  });

  it("rejects a missing title with 400", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/v0/boards", jsonReq("POST", { slug: "kb" }), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "title" });
  });

  it("rejects an unknown member_policy with 400", async () => {
    const h = makeHarness();
    const res = await createBoard(h, { member_policy: "anarchy" });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v0/boards", () => {
  it("lists only boards the caller can see, newest-updated first, with org chips", async () => {
    const h = makeHarness();
    await createBoard(h, { slug: "older" });
    vi.setSystemTime(2_000);
    await createBoard(h, { slug: "newer" });
    // A foreign board must never leak into the caller's list.
    seedForeignBoardAndIssue(h);

    const res = await h.app.request("/api/v0/boards", { headers: bearer }, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      boards: Array<BoardShape & { org_slug: string | null }>;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.boards.map((b) => b.slug)).toEqual(["newer", "older"]);
    expect(body.boards.map((b) => b.org_slug)).toEqual(["tester", "tester"]);
  });

  it("paginates with ?limit= and ?after=", async () => {
    const h = makeHarness();
    for (const [i, slug] of (["a", "b", "c"] as const).entries()) {
      vi.setSystemTime(1_000 * (i + 1));
      await createBoard(h, { slug });
    }
    const first = await h.app.request("/api/v0/boards?limit=2", { headers: bearer }, {});
    const page1 = (await first.json()) as { boards: BoardShape[]; total: number };
    expect(page1.boards.map((b) => b.slug)).toEqual(["c", "b"]);
    expect(page1.total).toBe(3);

    const cursor = page1.boards[1]!.id;
    const second = await h.app.request(`/api/v0/boards?limit=2&after=${cursor}`, { headers: bearer }, {});
    const page2 = (await second.json()) as { boards: BoardShape[] };
    expect(page2.boards.map((b) => b.slug)).toEqual(["a"]);
  });

  it("rejects an unknown after-cursor with 400", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/v0/boards?after=nope", { headers: bearer }, {});
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v0/boards/:slug", () => {
  it("returns the board with org context and the caller's role", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request("/api/v0/boards/kb", { headers: bearer }, {});
    expect(res.status).toBe(200);
    const { board, org, role } = (await res.json()) as {
      board: BoardShape;
      org: { slug: string };
      role: string;
    };
    expect(board.slug).toBe("kb");
    expect(board.title).toBe("Kanban");
    expect(org.slug).toBe("tester");
    expect(role).toBe("owner");
  });

  it("404s on an unknown slug", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/v0/boards/nope", { headers: bearer }, {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not-found", reason: "board" });
  });

  it("resolves via the canonical org-scoped path too", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request("/api/v0/orgs/tester/boards/kb", { headers: bearer }, {});
    expect(res.status).toBe(200);
    const { board } = (await res.json()) as { board: BoardShape };
    expect(board.slug).toBe("kb");
  });
});

describe("PATCH /api/v0/boards/:slug", () => {
  it("updates title and bumps updated_at_ms", async () => {
    const h = makeHarness();
    await createBoard(h);
    vi.setSystemTime(5_000);
    const res = await h.app.request("/api/v0/boards/kb", jsonReq("PATCH", { title: "Renamed" }), {});
    expect(res.status).toBe(200);
    const { board } = (await res.json()) as { board: BoardShape };
    expect(board.title).toBe("Renamed");
    expect(board.updated_at_ms).toBe(5_000);
    expect(board.created_at_ms).toBe(1_000);
    expect(h.db.boards[0]!["updated_at_ms"]).toBe(5_000);
  });

  it("404s on a non-existent board", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/v0/boards/nope", jsonReq("PATCH", { title: "X" }), {});
    expect(res.status).toBe(404);
  });

  it("rejects slug changes with 400", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request("/api/v0/boards/kb", jsonReq("PATCH", { slug: "kb2" }), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "slug-immutable" });
  });

  it("rejects an empty patch with 400", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request("/api/v0/boards/kb", jsonReq("PATCH", {}), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "empty-patch" });
  });
});

describe("visibility", () => {
  it("boards start private: anonymous GET 404s; toggling public opens reads", async () => {
    const h = makeHarness();
    await createBoard(h);
    expect((await h.app.request("/api/v0/boards/kb", {}, {})).status).toBe(404);

    const patched = await h.app.request(
      "/api/v0/boards/kb",
      jsonReq("PATCH", { visibility: "public" }),
      {},
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { board: BoardShape }).board.visibility).toBe("public");

    const anon = await h.app.request("/api/v0/boards/kb", {}, {});
    expect(anon.status).toBe(200);
    const { role } = (await anon.json()) as { role: string };
    expect(role).toBe("viewer");
  });

  it("rejects unknown visibility values with 400", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(
      "/api/v0/boards/kb",
      jsonReq("PATCH", { visibility: "unlisted" }),
      {},
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "visibility" });
  });
});

describe("DELETE /api/v0/boards/:slug", () => {
  it("deletes the board and its member rows; subsequent GET 404s", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request("/api/v0/boards/kb", { method: "DELETE", headers: bearer }, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(h.db.boards).toHaveLength(0);
    expect(h.db.boardMembers).toHaveLength(0);
    const gone = await h.app.request("/api/v0/boards/kb", { headers: bearer }, {});
    expect(gone.status).toBe(404);
  });

  it("404s on an unknown slug", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/v0/boards/nope", { method: "DELETE", headers: bearer }, {});
    expect(res.status).toBe(404);
  });
});

describe("auth gating", () => {
  it.each([
    ["POST", "/api/v0/boards"],
    ["GET", "/api/v0/boards"],
    ["PATCH", "/api/v0/boards/kb"],
    ["DELETE", "/api/v0/boards/kb"],
  ])("%s %s rejects unauthenticated requests with 401", async (method, path) => {
    const h = makeHarness();
    const res = await h.app.request(path, { method }, {});
    expect(res.status).toBe(401);
  });

  it("GET /api/v0/boards/kb answers 404 (not 401) to anonymous callers", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request("/api/v0/boards/kb", {}, {});
    expect(res.status).toBe(404);
  });
});

describe("issue_prefix", () => {
  it("derives a prefix from the title and starts the counter at 1", async () => {
    const h = makeHarness();
    const res = await createBoard(h); // "Kanban" → KAN
    const { board } = (await res.json()) as { board: BoardShape };
    expect(board.issue_prefix).toBe("KAN");
    expect(board.next_issue_number).toBe(1);
  });

  it("accepts an explicit prefix, uppercasing it", async () => {
    const h = makeHarness();
    const res = await createBoard(h, { issue_prefix: "flow" });
    const { board } = (await res.json()) as { board: BoardShape };
    expect(board.issue_prefix).toBe("FLOW");
  });

  it("rejects a malformed prefix with 400", async () => {
    const h = makeHarness();
    for (const bad of ["X", "TOOLONG", "FL-OW", ""]) {
      const res = await createBoard(h, { issue_prefix: bad, slug: `kb-${bad.length}` });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-body", reason: "issue_prefix" });
    }
  });

  it("auto-suffixes a taken prefix and returns the finalized value", async () => {
    const h = makeHarness();
    expect((await createBoard(h, { issue_prefix: "FLOW" })).status).toBe(201);
    const res = await createBoard(h, { slug: "kb2", issue_prefix: "FLOW" });
    expect(res.status).toBe(201);
    const { board } = (await res.json()) as { board: BoardShape };
    expect(board.issue_prefix).toBe("FLOW2");
  });

  it("PATCH may change the prefix while no issue exists", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request("/api/v0/boards/kb", jsonReq("PATCH", { issue_prefix: "ZZ" }), {});
    expect(res.status).toBe(200);
    const { board } = (await res.json()) as { board: BoardShape };
    expect(board.issue_prefix).toBe("ZZ");
  });

  it("PATCH prefix 409s once an issue number has been claimed", async () => {
    const h = makeHarness();
    await createBoard(h);
    h.db.boards[0]!["next_issue_number"] = 2; // an issue exists
    const res = await h.app.request("/api/v0/boards/kb", jsonReq("PATCH", { issue_prefix: "ZZ" }), {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", reason: "prefix-locked-issues-exist" });
  });
});
