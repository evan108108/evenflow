import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { url } from "../src/routes-manifest";
import { Effect, Exit } from "effect";
import { decodeBody } from "../src/lib/route-body";
// EFB-98: the schemas live with the logic that consumes them now. The route
// imports them back for parseRouteBody; a test that asserts what the SHAPE
// accepts belongs against the shape's own module.
import { PatchBoardBody, PostBoardBody } from "../src/actions/boards";
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
  h.app.request(url("board.create"), jsonReq("POST", { slug: "kb", title: "Kanban", ...overrides }), {});

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
      // Structured default set since phase 17: uuid ids, contiguous order.
      columns: [
        { name: "Todo", order: 0, enabled: true, category: "todo" },
        { name: "In Progress", order: 1, enabled: true, category: "in_progress" },
        { name: "In Review", order: 2, enabled: true, category: "in_review" },
        { name: "Done", order: 3, enabled: true, category: "done" },
      ],
      labels: [],
      member_policy: "invite",
      is_encrypted: false,
      visibility: "private",
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
    });
    expect(new Set(board.columns.map((c) => c.id)).size).toBe(4);
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
    const res = await h.app.request(url("board.create"), jsonReq("POST", { slug: "kb" }), {});
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

    const res = await h.app.request(url("board.create"), { headers: bearer }, {});
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
    const first = await h.app.request(`${url("board.create")}?limit=2`, { headers: bearer }, {});
    const page1 = (await first.json()) as { boards: BoardShape[]; total: number };
    expect(page1.boards.map((b) => b.slug)).toEqual(["c", "b"]);
    expect(page1.total).toBe(3);

    const cursor = page1.boards[1]!.id;
    const second = await h.app.request(`${url("board.create")}?limit=2&after=${cursor}`, { headers: bearer }, {});
    const page2 = (await second.json()) as { boards: BoardShape[] };
    expect(page2.boards.map((b) => b.slug)).toEqual(["a"]);
  });

  it("rejects an unknown after-cursor with 400", async () => {
    const h = makeHarness();
    const res = await h.app.request(`${url("board.create")}?after=nope`, { headers: bearer }, {});
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v0/boards/:slug", () => {
  it("returns the board with org context and the caller's role", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(url("board.get", { slug: "kb" }), { headers: bearer }, {});
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
    const res = await h.app.request(url("board.get", { slug: "nope" }), { headers: bearer }, {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not-found", reason: "board" });
  });

  it("resolves via the canonical org-scoped path too", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(url("board.get", { slug: "kb" }, "tester"), { headers: bearer }, {});
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
    const res = await h.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", { title: "Renamed" }), {});
    expect(res.status).toBe(200);
    const { board } = (await res.json()) as { board: BoardShape };
    expect(board.title).toBe("Renamed");
    expect(board.updated_at_ms).toBe(5_000);
    expect(board.created_at_ms).toBe(1_000);
    expect(h.db.boards[0]!["updated_at_ms"]).toBe(5_000);
  });

  it("404s on a non-existent board", async () => {
    const h = makeHarness();
    const res = await h.app.request(url("board.get", { slug: "nope" }), jsonReq("PATCH", { title: "X" }), {});
    expect(res.status).toBe(404);
  });

  it("rejects slug changes with 400", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", { slug: "kb2" }), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "slug-immutable" });
  });

  it("rejects an empty patch with 400", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", {}), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "empty-patch" });
  });
});

describe("visibility", () => {
  it("boards start private: anonymous GET 401s; toggling public opens reads", async () => {
    const h = makeHarness();
    await createBoard(h);
    // EFB-76: was 404. A tokenless caller is told to authenticate, not sent
    // looking elsewhere for a board that is right there but private.
    expect((await h.app.request(url("board.get", { slug: "kb" }), {}, {})).status).toBe(401);

    const patched = await h.app.request(
      url("board.get", { slug: "kb" }),
      jsonReq("PATCH", { visibility: "public" }),
      {},
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { board: BoardShape }).board.visibility).toBe("public");

    const anon = await h.app.request(url("board.get", { slug: "kb" }), {}, {});
    expect(anon.status).toBe(200);
    const { role } = (await anon.json()) as { role: string };
    expect(role).toBe("viewer");
  });

  it("rejects unknown visibility values with 400", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(
      url("board.get", { slug: "kb" }),
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
    const res = await h.app.request(url("board.get", { slug: "kb" }), { method: "DELETE", headers: bearer }, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(h.db.boards).toHaveLength(0);
    expect(h.db.boardMembers).toHaveLength(0);
    const gone = await h.app.request(url("board.get", { slug: "kb" }), { headers: bearer }, {});
    expect(gone.status).toBe(404);
  });

  it("404s on an unknown slug", async () => {
    const h = makeHarness();
    const res = await h.app.request(url("board.get", { slug: "nope" }), { method: "DELETE", headers: bearer }, {});
    expect(res.status).toBe(404);
  });
});

describe("auth gating", () => {
  it.each([
    ["POST", url("board.create")],
    ["GET", url("board.create")],
    ["PATCH", url("board.get", { slug: "kb" })],
    ["DELETE", url("board.get", { slug: "kb" })],
  ])("%s %s rejects unauthenticated requests with 401", async (method, path) => {
    const h = makeHarness();
    const res = await h.app.request(path, { method }, {});
    expect(res.status).toBe(401);
  });

  // EFB-76 inverted this case. It used to assert 404-not-401 on the theory
  // that hiding existence mattered more than telling the truth about auth;
  // the fix is that anonymous callers get 401 UNIFORMLY — for a private board
  // and for one that does not exist — which tells the truth AND hides
  // existence, because both answers are identical.
  it("GET /api/v0/boards/kb answers 401 to anonymous callers, existing or not", async () => {
    const h = makeHarness();
    await createBoard(h);
    const existsButPrivate = await h.app.request(url("board.get", { slug: "kb" }), {}, {});
    expect(existsButPrivate.status).toBe(401);
    const doesNotExist = await h.app.request(url("board.get", { slug: "no-such-board" }), {}, {});
    expect(doesNotExist.status).toBe(401);
    // The oracle test: the two answers must be byte-identical, or the status
    // code alone still distinguishes "private" from "nonexistent".
    expect(await existsButPrivate.json()).toEqual(await doesNotExist.json());
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
    const res = await h.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", { issue_prefix: "ZZ" }), {});
    expect(res.status).toBe(200);
    const { board } = (await res.json()) as { board: BoardShape };
    expect(board.issue_prefix).toBe("ZZ");
  });

  it("PATCH prefix 409s once an issue number has been claimed", async () => {
    const h = makeHarness();
    await createBoard(h);
    h.db.boards[0]!["next_issue_number"] = 2; // an issue exists
    const res = await h.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", { issue_prefix: "ZZ" }), {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", reason: "prefix-locked-issues-exist" });
  });

  // ── EFB-86 ──────────────────────────────────────────────────────────────
  //
  // `done_window_days` shared `validateSprintDays` with `default_sprint_days`,
  // and the validator hardcoded the OTHER field's name as its reason. A caller
  // who sent a bad done_window_days was told to go fix a field they had not
  // sent. EFB-61 found it and reproduced it rather than fixing it under cover
  // of that migration; this pins the standalone fix.
  //
  // Route-level, not schema-level, because the field is deliberately Unknown at
  // the schema — the handler validator is the only place the reason is minted.
  //
  // Falsification: revert the reason argument at the callsite (or hardcode any
  // other string in validateSprintDays) and the first assertion goes red.
  it("PATCH answers done_window_days — not default_sprint_days — for a bad done window", async () => {
    const h = makeHarness();
    await createBoard(h);
    for (const bad of [0, 91, 1.5, "not-a-number", null]) {
      const res = await h.app.request(
        url("board.get", { slug: "kb" }),
        jsonReq("PATCH", { done_window_days: bad }),
        {},
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-body", reason: "done_window_days" });
    }
  });

  // The other half of the same fix: the sibling field must keep answering its
  // OWN name. A "fix" that swapped the hardcoded string rather than
  // parameterizing it would pass the test above and fail this one.
  it("PATCH still answers default_sprint_days for a bad sprint length", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(
      url("board.get", { slug: "kb" }),
      jsonReq("PATCH", { default_sprint_days: 91 }),
      {},
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "default_sprint_days" });
  });

  // The reason string is the ONLY thing EFB-86 changed. Where the check runs
  // stays put, and this is why: the prefix conflict is answered before the
  // done-window value is ever looked at, so typing the field at the schema
  // would turn this 409 into a 400 — a status-code change the ticket did not
  // license.
  it("PATCH keeps answering 409 for a locked prefix even alongside a bad done window", async () => {
    const h = makeHarness();
    await createBoard(h);
    h.db.boards[0]!["next_issue_number"] = 2;
    const res = await h.app.request(
      url("board.get", { slug: "kb" }),
      jsonReq("PATCH", { issue_prefix: "ZZ", done_window_days: 999 }),
      {},
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", reason: "prefix-locked-issues-exist" });
  });

  it("PATCH round-trips a valid done_window_days", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(
      url("board.get", { slug: "kb" }),
      jsonReq("PATCH", { done_window_days: 30 }),
      {},
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { board: BoardShape }).board.done_window_days).toBe(30);
  });
});

// ── EFB-61: PostBoardBody / PatchBoardBody schemas ────────────────────────
//
// Predicate-inventory tests. The migration's risk is not that a schema
// rejects too little — it is that a schema silently reproduces a DIFFERENT
// predicate than the hand-rolled check it replaced, and every route test
// above still passes because none of them exercised that exact input.
//
// So each of these pins ONE predicate, and each asserts the WIRE REASON,
// not merely that something failed. A reason string is API surface.
describe("board request schemas (EFB-61)", () => {
  const decode = <A, I>(schema: Parameters<typeof decodeBody<A, I>>[0], input: unknown) =>
    Effect.runSync(Effect.exit(decodeBody(schema, input)));

  const reasonOf = (exit: Exit.Exit<unknown, unknown>): string => {
    if (Exit.isSuccess(exit)) return "<succeeded>";
    const err = (exit.cause as { error?: { reason?: string } }).error;
    return err?.reason ?? "<no reason>";
  };

  const post = (input: unknown) => reasonOf(decode(PostBoardBody, input));
  const patch = (input: unknown) => reasonOf(decode(PatchBoardBody, input));
  const OK = { slug: "kb", title: "Board" };

  describe("PostBoardBody", () => {
    it("accepts the minimum body and every optional field", () => {
      expect(Exit.isSuccess(decode(PostBoardBody, OK))).toBe(true);
      expect(
        Exit.isSuccess(
          decode(PostBoardBody, {
            ...OK,
            description: null,
            columns: ["Todo", "Done"],
            labels: [],
            member_policy: "open",
            visibility: "public",
            issue_prefix: "kb",
          }),
        ),
      ).toBe(true);
    });

    it("enforces SLUG_RE, not merely 'is a string'", () => {
      expect(post({ ...OK, slug: "has space" })).toBe("slug");
      expect(post({ ...OK, slug: "" })).toBe("slug");
      expect(post({ ...OK, slug: "a".repeat(65) })).toBe("slug");
      expect(post({ ...OK, slug: 42 })).toBe("slug");
      expect(post({ title: "Board" })).toBe("slug");
    });

    // The trap from comments.ts, re-armed here: minLength(1) accepts "   ".
    it("rejects a whitespace-only title", () => {
      expect(post({ ...OK, title: "   " })).toBe("title");
      expect(post({ ...OK, title: "" })).toBe("title");
      expect(post({ slug: "kb" })).toBe("title");
    });

    it("keeps description nullable and labels array-shaped", () => {
      expect(Exit.isSuccess(decode(PostBoardBody, { ...OK, description: null }))).toBe(true);
      expect(post({ ...OK, description: 42 })).toBe("description");
      // validateLabels only ever checked Array.isArray — elements are free.
      expect(Exit.isSuccess(decode(PostBoardBody, { ...OK, labels: [{ a: 1 }, "x"] }))).toBe(true);
      expect(post({ ...OK, labels: "nope" })).toBe("labels");
    });

    it("closes the member_policy and visibility vocabularies", () => {
      expect(post({ ...OK, member_policy: "public" })).toBe("member_policy");
      expect(post({ ...OK, visibility: "secret" })).toBe("visibility");
    });

    it("REJECTS an unknown key that used to be silently ignored", () => {
      expect(post({ ...OK, bogus: 1 })).toBe("bogus-unknown");
    });
  });

  describe("PatchBoardBody", () => {
    it("answers <field>-immutable, not <field>-unknown, for real-but-unwritable columns", () => {
      for (const f of ["slug", "pubkey", "id", "org_id", "audience_epoch", "audience_pubkey"]) {
        expect(patch({ [f]: "x" })).toContain(`${f}-immutable`);
      }
    });

    it("answers empty-patch when nothing patchable is present", () => {
      expect(patch({})).toBe("empty-patch");
    });

    // Pre-0015 compatibility: the key is accepted so a stale client is not
    // broken, but it is not patchable, so it alone is still empty-patch.
    it("accepts is_encrypted without letting it count as a patch", () => {
      expect(patch({ is_encrypted: true })).toBe("empty-patch");
      expect(Exit.isSuccess(decode(PatchBoardBody, { is_encrypted: true, title: "T" }))).toBe(true);
    });

    it("bounds default_sprint_days to 1..90", () => {
      expect(patch({ default_sprint_days: 0 })).toBe("default_sprint_days");
      expect(patch({ default_sprint_days: 91 })).toBe("default_sprint_days");
      expect(patch({ default_sprint_days: 1.5 })).toBe("default_sprint_days");
      expect(Exit.isSuccess(decode(PatchBoardBody, { default_sprint_days: 90 }))).toBe(true);
    });

    // done_window_days stays Unknown at the schema — EFB-86 fixed the REASON
    // STRING the handler answers, not where the check lives. It has to stay in
    // the handler because the prefix conflict (409) is checked first; see the
    // note on PatchBoardBody. The reason itself is asserted at the route level,
    // below, since that is the only place the handler validator runs.
    it("passes done_window_days through untyped", () => {
      expect(Exit.isSuccess(decode(PatchBoardBody, { done_window_days: "not-a-number" }))).toBe(
        true,
      );
    });

    it("accepts column_move_map without validating it here", () => {
      expect(
        Exit.isSuccess(decode(PatchBoardBody, { columns: ["A"], column_move_map: { x: "y" } })),
      ).toBe(true);
      expect(patch({ column_move_map: { x: "y" } })).toBe("empty-patch");
    });

    it("REJECTS an unknown key", () => {
      expect(patch({ title: "T", bogus: 1 })).toBe("bogus-unknown");
    });
  });
});
