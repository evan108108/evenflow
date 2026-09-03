import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { url } from "../src/routes-manifest";
import type { IssueShape } from "../src/shapes";
import {
  CALLER,
  bearer,
  bearerFor,
  createBoard,
  createIssue,
  jsonReq,
  makeHarness,
  seedBoardMember,
  seedForeignBoardAndIssue,
  seedOrgMember,
  tokenFor,
} from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/v0/boards/:slug/issues", () => {
  it("creates an issue with defaults and writes the creation audit row", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    expect(issue).toMatchObject({
      title: "An issue",
      body: null,
      status: "Todo", // first column of the default board
      container: "backlog",
      assignee_pubkey: null,
      priority: null,
      estimate: null,
      labels: [],
      github_links: [],
      created_at_ms: 1_000,
      updated_at_ms: 1_000,
      completed_at_ms: null,
    });
    expect(h.db.issues).toHaveLength(1);
    expect(h.db.statusChanges).toHaveLength(1);
    expect(h.db.statusChanges[0]).toMatchObject({
      issue_id: issue.id,
      actor_pubkey: CALLER,
      from_status: null,
      to_status: "Todo",
      from_container: null,
      to_container: "backlog",
      container_at_completion: null,
      occurred_at_ms: 1_000,
    });
  });

  it("accepts explicit fields", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h, {
      status: "In Progress",
      container: "active",
      priority: 2,
      estimate: 5,
      labels: ["bug"],
      // Was "github:7" — a pubkey belonging to nobody on this board. It only
      // worked because assignee_pubkey took any non-empty string (EFB-38);
      // the test never asserted on it, so the hole went unnoticed. CALLER is
      // on the roster via the create-time grant.
      assignee_pubkey: CALLER,
    });
    expect(issue.status).toBe("In Progress");
    expect(issue.container).toBe("active");
    expect(issue.estimate).toBe(5);
    expect(issue.labels).toEqual(["bug"]);
  });

  it("400s on missing title, bad container, and status not on the board", async () => {
    const h = makeHarness();
    await createBoard(h);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ title: "" }, "title"],
      [{ title: "x", container: "swamp" }, "container"],
      [{ title: "x", status: "Nope" }, "status-not-a-column"],
      [{ title: "x", estimate: 1.5 }, "estimate"],
    ];
    for (const [body, reason] of cases) {
      const res = await h.app.request(url("issue.create", { slug: "kb" }), jsonReq("POST", body), {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-body", reason });
    }
  });

  it("404s on an unknown board and on someone else's board", async () => {
    const h = makeHarness();
    seedForeignBoardAndIssue(h);
    for (const slug of ["nope", "theirs"]) {
      const res = await h.app.request(url("issue.create", { slug: slug }), jsonReq("POST", { title: "x" }), {});
      expect(res.status).toBe(404);
    }
  });
});

describe("GET /api/v0/boards/:slug/issues", () => {
  it("lists newest-updated first with total and has_more", async () => {
    const h = makeHarness();
    await createBoard(h);
    for (const [i, title] of (["a", "b", "c"] as const).entries()) {
      vi.setSystemTime(1_000 * (i + 1));
      await createIssue(h, { title });
    }
    const res = await h.app.request(`${url("issue.create", { slug: "kb" })}?limit=2`, { headers: bearer }, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issues: IssueShape[]; total: number; has_more: boolean };
    expect(body.issues.map((i) => i.title)).toEqual(["c", "b"]);
    expect(body.total).toBe(3);
    expect(body.has_more).toBe(true);
  });

  it("paginates with ?after=", async () => {
    const h = makeHarness();
    await createBoard(h);
    const ids: string[] = [];
    for (const [i, title] of (["a", "b", "c"] as const).entries()) {
      vi.setSystemTime(1_000 * (i + 1));
      ids.push((await createIssue(h, { title })).id);
    }
    const res = await h.app.request(`${url("issue.create", { slug: "kb" })}?after=${ids[1]}`, { headers: bearer }, {});
    const body = (await res.json()) as { issues: IssueShape[]; has_more: boolean };
    expect(body.issues.map((i) => i.title)).toEqual(["a"]);
    expect(body.has_more).toBe(false);
  });

  it("filters by status, container, and label — and composes them (phase 22)", async () => {
    const h = makeHarness();
    await createBoard(h);
    await createIssue(h, { title: "todo-active", status: "Todo", container: "active" });
    vi.setSystemTime(2_000);
    await createIssue(h, { title: "labeled", status: "In Review", labels: ["bug"] });

    const byStatus = (await (
      await h.app.request(`${url("issue.create", { slug: "kb" })}?status=Todo`, { headers: bearer }, {})
    ).json()) as { issues: IssueShape[]; total: number };
    expect(byStatus.issues.map((i) => i.title)).toEqual(["todo-active"]);
    expect(byStatus.total).toBe(1);

    const byContainer = (await (
      await h.app.request(`${url("issue.create", { slug: "kb" })}?container=active`, { headers: bearer }, {})
    ).json()) as { issues: IssueShape[] };
    expect(byContainer.issues.map((i) => i.title)).toEqual(["todo-active"]);

    const byLabel = (await (
      await h.app.request(`${url("issue.create", { slug: "kb" })}?label=bug`, { headers: bearer }, {})
    ).json()) as { issues: IssueShape[] };
    expect(byLabel.issues.map((i) => i.title)).toEqual(["labeled"]);

    // Phase 22: filters COMPOSE. The old one-filter-at-a-time guard made
    // paged kanban columns impossible — a column stream is inherently
    // container=active AND column_id=X.
    const combined = await h.app.request(
      `${url("issue.create", { slug: "kb" })}?status=Todo&container=active`,
      { headers: bearer },
      {},
    );
    expect(combined.status).toBe(200);
    const both = (await combined.json()) as { issues: IssueShape[] };
    expect(both.issues.map((i) => i.title)).toEqual(["todo-active"]);

    // ...and compose conjunctively, not as a union: a status that does not
    // co-occur with the container yields nothing.
    const disjoint = await h.app.request(
      `${url("issue.create", { slug: "kb" })}?status=In%20Review&container=active`,
      { headers: bearer },
      {},
    );
    expect(((await disjoint.json()) as { issues: IssueShape[] }).issues).toEqual([]);
  });
});

describe("GET /api/v0/issues/:id", () => {
  it("returns the issue; 404s on unknown and foreign issues", async () => {
    const h = makeHarness();
    await createBoard(h);
    seedForeignBoardAndIssue(h);
    const issue = await createIssue(h);
    const ok = await h.app.request(url("issue.get", { id: issue.id }), { headers: bearer }, {});
    expect(ok.status).toBe(200);
    for (const id of ["nope", "fi"]) {
      const res = await h.app.request(url("issue.get", { id: id }), { headers: bearer }, {});
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not-found", reason: "issue" });
    }
  });
});

describe("PATCH /api/v0/issues/:id", () => {
  it("updates fields and bumps updated_at_ms without an audit row when status unchanged", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    vi.setSystemTime(5_000);
    const res = await h.app.request(
      url("issue.get", { id: issue.id }),
      jsonReq("PATCH", { title: "Renamed", estimate: 3 }),
      {},
    );
    expect(res.status).toBe(200);
    const { issue: updated } = (await res.json()) as { issue: IssueShape };
    expect(updated.title).toBe("Renamed");
    expect(updated.estimate).toBe(3);
    expect(updated.updated_at_ms).toBe(5_000);
    expect(h.db.statusChanges).toHaveLength(1); // creation row only
  });

  it("writes a statusChange row when status changes", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    vi.setSystemTime(5_000);
    await h.app.request(url("issue.get", { id: issue.id }), jsonReq("PATCH", { status: "In Progress" }), {});
    expect(h.db.statusChanges).toHaveLength(2);
    expect(h.db.statusChanges[1]).toMatchObject({
      from_status: "Todo",
      to_status: "In Progress",
      from_container: null,
      to_container: null,
      occurred_at_ms: 5_000,
    });
  });

  it("sets completed_at_ms on Done and clears it when leaving Done", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h, { container: "active" });
    vi.setSystemTime(5_000);
    const done = (await (
      await h.app.request(url("issue.get", { id: issue.id }), jsonReq("PATCH", { status: "Done" }), {})
    ).json()) as { issue: IssueShape };
    expect(done.issue.completed_at_ms).toBe(5_000);
    expect(h.db.statusChanges[1]).toMatchObject({
      to_status: "Done",
      container_at_completion: "active",
    });

    vi.setSystemTime(6_000);
    const reverted = (await (
      await h.app.request(url("issue.get", { id: issue.id }), jsonReq("PATCH", { status: "In Review" }), {})
    ).json()) as { issue: IssueShape };
    expect(reverted.issue.completed_at_ms).toBeNull();
  });

  it("rejects container and github_links patches and empty patches", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ container: "active" }, "container-immutable"],
      [{ github_links: [] }, "github_links-immutable"],
      [{}, "empty-patch"],
    ];
    for (const [body, reason] of cases) {
      const res = await h.app.request(url("issue.get", { id: issue.id }), jsonReq("PATCH", body), {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-body", reason });
    }
  });

  it("404s on a foreign issue", async () => {
    const h = makeHarness();
    seedForeignBoardAndIssue(h);
    const res = await h.app.request(url("issue.get", { id: "fi" }), jsonReq("PATCH", { title: "X" }), {});
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v0/issues/:id/transition", () => {
  it("changes status, maintains completed_at_ms, and writes the audit row", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h, { container: "active" });
    vi.setSystemTime(5_000);
    const res = await h.app.request(
      url("issue.transition", { id: issue.id }),
      jsonReq("POST", { to_status: "Done" }),
      {},
    );
    expect(res.status).toBe(200);
    const { issue: done } = (await res.json()) as { issue: IssueShape };
    expect(done.status).toBe("Done");
    expect(done.completed_at_ms).toBe(5_000);
    expect(h.db.statusChanges[1]).toMatchObject({
      from_status: "Todo",
      to_status: "Done",
      container_at_completion: "active",
    });
  });

  it("no-ops on a same-status transition (no audit row, no bump)", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    vi.setSystemTime(5_000);
    const res = await h.app.request(
      url("issue.transition", { id: issue.id }),
      jsonReq("POST", { to_status: issue.status }),
      {},
    );
    expect(res.status).toBe(200);
    const { issue: same } = (await res.json()) as { issue: IssueShape };
    expect(same.updated_at_ms).toBe(1_000);
    expect(h.db.statusChanges).toHaveLength(1);
  });

  it("400s on a status not on the board", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const res = await h.app.request(
      url("issue.transition", { id: issue.id }),
      jsonReq("POST", { to_status: "Nope" }),
      {},
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "status-not-a-column" });
  });
});

describe("container moves", () => {
  it("walks icebox → backlog → active with audit rows", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h, { container: "icebox" });

    vi.setSystemTime(2_000);
    const toBacklog = (await (
      await h.app.request(url("issue.container.set", { id: issue.id }), jsonReq("POST", { container: "backlog" }), {})
    ).json()) as { issue: IssueShape };
    expect(toBacklog.issue.container).toBe("backlog");

    vi.setSystemTime(3_000);
    const toActive = (await (
      await h.app.request(url("issue.container.set", { id: issue.id }), jsonReq("POST", { container: "active" }), {})
    ).json()) as { issue: IssueShape };
    expect(toActive.issue.container).toBe("active");

    vi.setSystemTime(4_000);
    const toIcebox = (await (
      await h.app.request(url("issue.container.set", { id: issue.id }), jsonReq("POST", { container: "icebox" }), {})
    ).json()) as { issue: IssueShape };
    expect(toIcebox.issue.container).toBe("icebox");

    // creation + three moves
    expect(h.db.statusChanges).toHaveLength(4);
    expect(h.db.statusChanges[1]).toMatchObject({
      from_container: "icebox",
      to_container: "backlog",
      from_status: null,
      to_status: null,
    });
    expect(h.db.statusChanges[3]).toMatchObject({ from_container: "active", to_container: "icebox" });
  });

  it("is idempotent — repeating a move writes no audit row and keeps updated_at_ms", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h); // container backlog
    vi.setSystemTime(9_000);
    const res = await h.app.request(
      url("issue.container.set", { id: issue.id }), jsonReq("POST", { container: "backlog" }),
      {},
    );
    expect(res.status).toBe(200);
    const { issue: same } = (await res.json()) as { issue: IssueShape };
    expect(same.container).toBe("backlog");
    expect(same.updated_at_ms).toBe(1_000);
    expect(h.db.statusChanges).toHaveLength(1);
  });
});

describe("DELETE /api/v0/issues/:id", () => {
  it("deletes the issue, cascades comments in code, keeps the audit trail", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    await h.app.request(url("comment.create", { id: issue.id }), jsonReq("POST", { body: "hi" }), {});
    expect(h.db.comments).toHaveLength(1);

    const res = await h.app.request(url("issue.get", { id: issue.id }), { method: "DELETE", headers: bearer }, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(h.db.issues).toHaveLength(0);
    expect(h.db.comments).toHaveLength(0);
    expect(h.db.statusChanges).toHaveLength(1); // audit survives

    const gone = await h.app.request(url("issue.get", { id: issue.id }), { headers: bearer }, {});
    expect(gone.status).toBe(404);
  });
});

describe("auth gating", () => {
  it.each([
    ["POST", url("issue.create", { slug: "kb" })],
    ["PATCH", url("issue.get", { id: "x" })],
    ["DELETE", url("issue.get", { id: "x" })],
    ["POST", url("issue.transition", { id: "x" })],
    // EFB-98: the three promote_to_*/send_to_icebox routes are one route now,
    // with the destination in the body.
    ["POST", url("issue.container.set", { id: "x" })],
  ])("%s %s rejects unauthenticated mutations with 401", async (method, path) => {
    const h = makeHarness();
    const res = await h.app.request(path, { method }, {});
    expect(res.status).toBe(401);
  });

  // Reads run behind optionalAuth since phase 16: anonymous is allowed
  // through, and public boards are the only anonymous-readable surface.
  // EFB-76: an unknown/private resource answers 401, not 404 — the 404 was
  // the bug (it told tokenless callers "look elsewhere" when the real answer
  // was "send auth"), and the 401 is uniform across private and nonexistent
  // so it leaks no more than the 404 did.
  it.each([
    ["GET", url("issue.create", { slug: "kb" })],
    ["GET", url("issue.get", { id: "x" })],
  ])("%s %s answers 401 to anonymous callers on private/unknown resources", async (method, path) => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(path, { method }, {});
    expect(res.status).toBe(401);
  });

  // The oracle guard for GET /issues/:id, the endpoint EFB-76 was filed
  // against: a real-but-private issue and a fabricated id must be
  // indistinguishable to an anonymous caller. Short ids are per-board
  // sequential, so any difference here maps a private board's ticket volume.
  it("GET /api/v0/issues/:id is indistinguishable private-vs-nonexistent when anonymous", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);

    const realButPrivate = await h.app.request(url("issue.get", { id: issue.short_id }), {}, {});
    const fabricated = await h.app.request(url("issue.get", { id: "KAN-99999" }), {}, {});

    expect(realButPrivate.status).toBe(401);
    expect(fabricated.status).toBe(401);
    expect(await realButPrivate.json()).toEqual(await fabricated.json());
  });

  // The other half of the matrix, unchanged by EFB-76 and load-bearing: an
  // AUTHENTICATED caller with no access still gets 404, not 403. A 403 here
  // would rebuild the same oracle one auth level up — anyone can sign up.
  it("keeps 404 (not 403) for an authenticated caller who cannot see the issue", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);

    const outsider = await h.app.request(
      url("issue.get", { id: issue.short_id }),
      { headers: bearerFor(tokenFor("outsider")) },
      {},
    );
    expect(outsider.status).toBe(404);
  });

  it("serves board issues to anonymous callers once the board is public", async () => {
    const h = makeHarness();
    await createBoard(h);
    await createIssue(h);
    const patched = await h.app.request(
      url("board.get", { slug: "kb" }),
      jsonReq("PATCH", { visibility: "public" }),
      {},
    );
    expect(patched.status).toBe(200);
    const res = await h.app.request(url("issue.create", { slug: "kb" }), {}, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issues: unknown[] };
    expect(body.issues).toHaveLength(1);
  });
});

describe("short ids", () => {
  it("assigns sequential short_ids from the board prefix and bumps the counter", async () => {
    const h = makeHarness();
    await createBoard(h); // title "Board" → derived prefix BOA
    const first = await createIssue(h, { title: "one" });
    const second = await createIssue(h, { title: "two" });
    expect(first.short_id).toBe("BOA-1");
    expect(second.short_id).toBe("BOA-2");
    expect(h.db.boards[0]!["next_issue_number"]).toBe(3);
  });

  it("five concurrent creates yield distinct, gapless numbers", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issues = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createIssue(h, { title: `c${i}` })),
    );
    const shortIds = issues.map((i) => i.short_id).sort();
    expect(shortIds).toEqual(["BOA-1", "BOA-2", "BOA-3", "BOA-4", "BOA-5"]);
    expect(h.db.boards[0]!["next_issue_number"]).toBe(6);
  });

  it("resolves the same issue by short_id, lowercase short_id, and UUID", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    for (const ref of ["BOA-1", "boa-1", issue.id]) {
      const res = await h.app.request(url("issue.get", { id: ref }), { headers: bearer }, {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as { issue: IssueShape };
      expect(body.issue.id).toBe(issue.id);
      expect(body.issue.short_id).toBe("BOA-1");
    }
  });

  it("accepts short_ids on mutation endpoints (transition + comments)", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const res = await h.app.request(
      url("issue.transition", { id: "BOA-1" }),
      jsonReq("POST", { to_status: "Done" }),
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issue: IssueShape };
    expect(body.issue.id).toBe(issue.id);
    expect(body.issue.status).toBe("Done");
  });

  it("404s an unknown short id", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(url("issue.get", { id: "BOA-99" }), { headers: bearer }, {});
    expect(res.status).toBe(404);
  });
});

// ── phase 18d: fractional positions + PATCH /issues/:id/reorder ───────────

const reorder = (
  h: ReturnType<typeof makeHarness>,
  issueId: string,
  body: Record<string, unknown>,
) => h.app.request(url("issue.position.set", { id: issueId }), jsonReq("PUT", body), {});

describe("PATCH /api/v0/issues/:id/reorder", () => {
  it("creates assign appended positions (max + 1000)", async () => {
    const h = makeHarness();
    await createBoard(h);
    const a = await createIssue(h);
    const b = await createIssue(h, { title: "B" });
    const c = await createIssue(h, { title: "C" });
    expect([a.position, b.position, c.position]).toEqual([1000, 2000, 3000]);
  });

  it("computes the neighbor midpoint, or steps past a single edge neighbor", async () => {
    const h = makeHarness();
    await createBoard(h);
    const a = await createIssue(h); // 1000
    const b = await createIssue(h, { title: "B" }); // 2000
    const c = await createIssue(h, { title: "C" }); // 3000

    // c between a and b → 1500
    const mid = await reorder(h, c.id, { before_issue_id: a.id, after_issue_id: b.id });
    expect(mid.status).toBe(200);
    expect(((await mid.json()) as { issue: IssueShape }).issue.position).toBe(1500);

    // b to the very top → a.position - 1000
    const top = await reorder(h, b.id, { after_issue_id: a.id });
    expect(((await top.json()) as { issue: IssueShape }).issue.position).toBe(0);

    // a to the very bottom → c's CURRENT position (1500 after the move
    // above) + 1000
    const bottom = await reorder(h, a.id, { before_issue_id: c.id });
    expect(((await bottom.json()) as { issue: IssueShape }).issue.position).toBe(2500);
  });

  it("rebalances the whole column when legacy NULL positions are involved", async () => {
    const h = makeHarness();
    await createBoard(h);
    const a = await createIssue(h);
    const boardId = a.board_id;
    // Two legacy rows, no position — display order is updated_at_ms DESC.
    h.db.issues.push(
      {
        id: "legacy-new", short_id: null, board_id: boardId, title: "L1", body: null,
        status: "Todo", column_id: null, container: "backlog", assignee_pubkey: null,
        priority: null, estimate: null, labels: "[]", github_links: "[]",
        created_at_ms: 2, updated_at_ms: 900, completed_at_ms: null,
      },
      {
        id: "legacy-old", short_id: null, board_id: boardId, title: "L2", body: null,
        status: "Todo", column_id: null, container: "backlog", assignee_pubkey: null,
        priority: null, estimate: null, labels: "[]", github_links: "[]",
        created_at_ms: 1, updated_at_ms: 800, completed_at_ms: null,
      },
    );

    // Move `a` between the two legacy rows: a NULL neighbor forces the
    // rebalance path — every column-mate comes out positioned in display
    // order (a: 1000 · legacy-new first, then a, then legacy-old).
    const res = await reorder(h, a.id, { before_issue_id: "legacy-new", after_issue_id: "legacy-old" });
    expect(res.status).toBe(200);
    const posOf = (id: string) => h.db.issues.find((r) => r["id"] === id)?.["position"];
    expect(posOf("legacy-new")).toBe(1000);
    expect(posOf(a.id)).toBe(2000);
    expect(posOf("legacy-old")).toBe(3000);
  });

  it("validates neighbors: none given, self, unknown, or cross-column all 400", async () => {
    const h = makeHarness();
    await createBoard(h);
    const a = await createIssue(h);
    const b = await createIssue(h, { title: "B", status: "Done" });

    expect((await reorder(h, a.id, {})).status).toBe(400);
    expect((await reorder(h, a.id, { before_issue_id: a.id })).status).toBe(400);
    expect((await reorder(h, a.id, { before_issue_id: "nope" })).status).toBe(400);
    // b sits in a different column (Done) — not a valid neighbor.
    expect((await reorder(h, a.id, { before_issue_id: b.id })).status).toBe(400);
  });

  it("position is immutable through plain PATCH", async () => {
    const h = makeHarness();
    await createBoard(h);
    const a = await createIssue(h);
    const res = await h.app.request(
      url("issue.get", { id: a.id }),
      jsonReq("PATCH", { position: 42 }),
      {},
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "position-immutable" });
  });

  it("requires auth", async () => {
    const h = makeHarness();
    const res = await h.app.request(
      url("issue.position.set", { id: "x" }),
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" },
      {},
    );
    expect(res.status).toBe(401);
  });
});

// ── EFB-38: assignee_pubkey validation + normalization ────────────────────
//
// Written BEFORE the fix and confirmed red, per the ticket. Two things were
// wrong: `validateAssignee` accepted any non-empty string, so (a) raw hex and
// its `nostr:`-prefixed form were stored as two distinct identities for the
// same key, and (b) an authenticated caller could assign an issue to somebody
// who is not on the board at all, silently.
//
// "Member" here means a row in boardMemberCache — deliberately the same
// source the members endpoint and the UI dropdown read, so the API cannot
// accept an assignee the picker can't show. Notably NOT effectiveBoardRole,
// which floors any pubkey at "viewer" on a public board and would make the
// check a no-op there.
describe("EFB-38 assignee_pubkey validation", () => {
  const HEX = "049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2";
  const CANON = `nostr:${HEX}`;
  const STRANGER = "nostr:1111111111111111111111111111111111111111111111111111111111111111";

  /** Board whose roster holds the caller plus one nostr-shaped member. */
  const boardWithNostrMember = async (h: ReturnType<typeof makeHarness>) => {
    await createBoard(h);
    const boardId = h.db.boards[0]!["id"] as string;
    seedBoardMember(h, boardId, CANON, "contributor");
    return boardId;
  };

  const patchAssignee = (h: ReturnType<typeof makeHarness>, id: string, v: unknown) =>
    h.app.request(url("issue.get", { id: id }), jsonReq("PATCH", { assignee_pubkey: v }), {});

  const storedAssignee = (h: ReturnType<typeof makeHarness>, id: string) =>
    h.db.issues.find((r) => r["id"] === id)?.["assignee_pubkey"] ?? null;

  // 1 — the reported bug: raw hex and nostr:hex are the same key, and the
  // stored form must be the canonical one.
  it("PATCH normalizes raw 64-char hex to nostr: form", async () => {
    const h = makeHarness();
    await boardWithNostrMember(h);
    const issue = await createIssue(h);

    const res = await patchAssignee(h, issue.id, HEX);
    expect(res.status).toBe(200);
    expect(storedAssignee(h, issue.id)).toBe(CANON);
    expect(((await res.json()) as { issue: IssueShape }).issue.assignee_pubkey).toBe(CANON);
  });

  // 2 — the other half: a well-formed identity that is not on this board.
  it("PATCH 400s assigning to a non-member", async () => {
    const h = makeHarness();
    await boardWithNostrMember(h);
    const issue = await createIssue(h);

    const res = await patchAssignee(h, issue.id, STRANGER);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "not-a-member" });
    expect(storedAssignee(h, issue.id)).toBeNull();
  });

  it("PATCH null unassigns", async () => {
    const h = makeHarness();
    await boardWithNostrMember(h);
    const issue = await createIssue(h, { assignee_pubkey: CANON });
    expect(storedAssignee(h, issue.id)).toBe(CANON);

    const res = await patchAssignee(h, issue.id, null);
    expect(res.status).toBe(200);
    expect(storedAssignee(h, issue.id)).toBeNull();
  });

  it("PATCH accepts an already-canonical member pubkey unchanged", async () => {
    const h = makeHarness();
    await boardWithNostrMember(h);
    const issue = await createIssue(h);

    const res = await patchAssignee(h, issue.id, CANON);
    expect(res.status).toBe(200);
    expect(storedAssignee(h, issue.id)).toBe(CANON);
  });

  // Assignee resolution matches the members-list roster (org-teams decision
  // doc): an org member has a projected contributor role on every board in
  // the org, so they must be assignable without an explicit boardMemberCache
  // grant. Before the fix the picker showed them (post the listBoardMembers
  // union) but assertRosterMember rejected them with `not-a-member`.
  it("PATCH accepts an org member as assignee without an explicit board grant", async () => {
    const h = makeHarness();
    await createBoard(h);
    const orgId = h.db.orgs[0]!["id"] as string;
    // Deliberately NOT calling seedBoardMember for CANON — only org
    // membership. The check under test is that org projection is enough.
    seedOrgMember(h, orgId, CANON, "member");
    const issue = await createIssue(h);

    const res = await patchAssignee(h, issue.id, CANON);
    expect(res.status).toBe(200);
    expect(storedAssignee(h, issue.id)).toBe(CANON);
  });

  // 5 — the create path shares validateAssignee, so it shares every case.
  describe("POST create applies the same rules", () => {
    const postIssue = (h: ReturnType<typeof makeHarness>, v: unknown) =>
      h.app.request(
        url("issue.create", { slug: "kb" }),
        jsonReq("POST", { title: "assigned at birth", assignee_pubkey: v }),
        {},
      );

    it("normalizes raw hex on create", async () => {
      const h = makeHarness();
      await boardWithNostrMember(h);
      const res = await postIssue(h, HEX);
      expect(res.status).toBe(201);
      expect(((await res.json()) as { issue: IssueShape }).issue.assignee_pubkey).toBe(CANON);
    });

    it("400s on a non-member at create", async () => {
      const h = makeHarness();
      await boardWithNostrMember(h);
      const res = await postIssue(h, STRANGER);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ reason: "not-a-member" });
    });

    it("accepts null and an already-canonical member at create", async () => {
      const h = makeHarness();
      await boardWithNostrMember(h);
      expect((await postIssue(h, null)).status).toBe(201);
      expect((await postIssue(h, CANON)).status).toBe(201);
    });
  });

  // 6 — rows written before the fix keep parsing and rendering. Migration
  // 0023 normalizes them in D1; this proves the read path never depended on
  // the shape in the first place.
  it("still reads a pre-fix row whose assignee is raw hex", async () => {
    const h = makeHarness();
    await boardWithNostrMember(h);
    const issue = await createIssue(h);
    // Simulate a row written by the old, unvalidated code path.
    const row = h.db.issues.find((r) => r["id"] === issue.id)!;
    row["assignee_pubkey"] = HEX;

    const res = await h.app.request(url("issue.get", { id: issue.id }), { headers: bearer }, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { issue: IssueShape }).issue.assignee_pubkey).toBe(HEX);
  });

  // Shape rules from the ticket's canonicalizeIdentityRef spec.
  describe("canonicalization edge cases", () => {
    it("uppercases hex normalize to lowercase nostr: form", async () => {
      const h = makeHarness();
      await boardWithNostrMember(h);
      const issue = await createIssue(h);

      const res = await patchAssignee(h, issue.id, HEX.toUpperCase());
      expect(res.status).toBe(200);
      expect(storedAssignee(h, issue.id)).toBe(CANON);
    });

    // EFB-41. This block previously asserted "400s on npub1, not supported
    // yet" — and it kept passing after npub support landed, because the
    // sample it used contains an illegal bech32 letter ("i") and so never
    // reached the decoder at all. It was certifying the reject for the wrong
    // reason. Replaced with the three cases that actually pin the behaviour.
    const NPUB_MEMBER = "npub1qjdk9rzwrr2kycnlmyjda2xadl5c6nwnp98askjnmpxq75sek0pqr3fl3a"; // = HEX
    const NPUB_STRANGER = "npub1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygse4sl3h";

    it("assigns via npub, storing the same canonical ref as the hex spelling", async () => {
      const h = makeHarness();
      await boardWithNostrMember(h);
      const issue = await createIssue(h);

      const res = await patchAssignee(h, issue.id, NPUB_MEMBER);
      expect(res.status).toBe(200);
      expect(storedAssignee(h, issue.id)).toBe(CANON);
    });

    // The roster check governs, not the spelling: decoding an npub must not
    // become a way to assign work to somebody who is not on the board.
    it("400s not-a-member on a valid npub outside the roster", async () => {
      const h = makeHarness();
      await boardWithNostrMember(h);
      const issue = await createIssue(h);

      const res = await patchAssignee(h, issue.id, NPUB_STRANGER);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ reason: "not-a-member" });
      expect(storedAssignee(h, issue.id)).toBeNull();
    });

    // Malformed bech32 and non-npub TLVs both 400. The nsec case is the
    // security one: a pasted PRIVATE key must not decode to its public half
    // and quietly succeed. Note the note1 sample carries the same 32 bytes
    // as NPUB_MEMBER, so it would resolve to a real member if the decoder
    // were not gated on type.
    it.each([
      ["illegal bech32 letter", "npub1qy352eufi7lxs4h8lpelw9r4vtvrhtnfvxhc4xzn3nlrxq0zj9nqmcqvr7"],
      ["bad checksum", "npub1qy352euf7lxs4h8lpelw9r4vtvrhtnfvxhc4xzn3nlrxq0zj9nqmcqvr7"],
      ["nsec (private key)", "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5"],
      ["note1 of a real member's bytes", "note1qjdk9rzwrr2kycnlmyjda2xadl5c6nwnp98askjnmpxq75sek0pqjm2zg4"],
    ])("400s on %s", async (_label, v) => {
      const h = makeHarness();
      await boardWithNostrMember(h);
      const issue = await createIssue(h);

      const res = await patchAssignee(h, issue.id, v);
      expect(res.status).toBe(400);
      expect(storedAssignee(h, issue.id)).toBeNull();
    });

    it.each(["", "   ", "not a pubkey", "nostr:", ":abc", "deadbeef"])(
      "400s on unrecognized shape %j",
      async (v) => {
        const h = makeHarness();
        await boardWithNostrMember(h);
        const issue = await createIssue(h);

        const res = await patchAssignee(h, issue.id, v);
        expect(res.status).toBe(400);
        expect(storedAssignee(h, issue.id)).toBeNull();
      },
    );
  });
});

// ── EFB-85: the four issues.ts routes migrated to parseRouteBody ──────────
//
// Follow-up to EFB-61 (comments + boards). Each test below pins ONE predicate
// and asserts the WIRE REASON, not merely that something failed — a migration
// is allowed to turn a silent success into a 400, and is not allowed to change
// an error string that callers already branch on.
//
// The quirk tests are the load-bearing half. Every one of them reproduces
// behavior that existed before the migration and that the obvious schema
// spelling would have broken; each was verified to FAIL when its predicate is
// weakened to the obvious form.

/** POST the create route and surface { status, reason }. */
const postIssue = async (h: ReturnType<typeof makeHarness>, body: Record<string, unknown>) => {
  const res = await h.app.request(url("issue.create", { slug: "kb" }), jsonReq("POST", body), {});
  const json = (await res.json()) as { reason?: string; issue?: IssueShape };
  return { status: res.status, reason: json.reason, issue: json.issue };
};

const postTransition = async (
  h: ReturnType<typeof makeHarness>,
  id: string,
  body: Record<string, unknown>,
) => {
  const res = await h.app.request(url("issue.transition", { id: id }), jsonReq("POST", body), {});
  const json = (await res.json()) as { reason?: string; issue?: IssueShape };
  return { status: res.status, reason: json.reason, issue: json.issue };
};

const reorderBody = async (
  h: ReturnType<typeof makeHarness>,
  id: string,
  body: Record<string, unknown>,
) => {
  const res = await h.app.request(url("issue.position.set", { id: id }), jsonReq("PUT", body), {});
  const json = (await res.json()) as { reason?: string };
  return { status: res.status, reason: json.reason };
};

describe("EFB-85 — POST /boards/:slug/issues under parseRouteBody", () => {
  // The create-route twin of EFB-53. Pre-migration this returned 201 with the
  // key dropped: a caller who meant `assignee_pubkey` got a success and an
  // unassigned issue, with nothing anywhere naming the mistake.
  it("400s naming an unknown key that used to be silently dropped", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { status, reason } = await postIssue(h, { title: "T", assignee: "github:1" });
    expect(status).toBe(400);
    expect(reason).toBe("assignee-unknown");
    expect(h.db.issues).toHaveLength(0);
  });

  // sprint_id and column_id are REAL fields reachable through other endpoints,
  // so they answer `-immutable` ("wrong endpoint") rather than `-unknown` ("no
  // such field"). The distinction is the whole reason ImmutableField exists.
  it.each([
    ["sprint_id", "sprint_id-immutable"],
    ["column_id", "column_id-immutable"],
  ])("tells a caller %s is a real field on the wrong endpoint", async (key, expected) => {
    const h = makeHarness();
    await createBoard(h);
    const { status, reason } = await postIssue(h, { title: "T", [key]: "x" });
    expect(status).toBe(400);
    expect(reason).toBe(expected);
  });

  // Server-assigned fields get the OTHER answer, and deliberately so: no honest
  // client sends them to any endpoint, so "does not exist" is the true reply.
  it.each(["id", "short_id", "position", "github_links", "completed_at_ms"])(
    "answers %s-unknown for a server-assigned field",
    async (key) => {
      const h = makeHarness();
      await createBoard(h);
      const { status, reason } = await postIssue(h, { title: "T", [key]: "x" });
      expect(status).toBe(400);
      expect(reason).toBe(`${key}-unknown`);
    },
  );

  // THE EFB-61 TRAP, reproduced. `Schema.minLength(1)` ACCEPTS "   ", so the
  // obvious primitive would have silently loosened a contract the hand-rolled
  // `v.trim() !== ""` enforced. Weaken the filter to NonEmptyString and this
  // test goes red — which is the only reason to trust it.
  it("still rejects a whitespace-only title (minLength(1) would accept it)", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { status, reason } = await postIssue(h, { title: "   " });
    expect(status).toBe(400);
    expect(reason).toBe("title");
    expect(h.db.issues).toHaveLength(0);
  });

  it("400s naming `title` when it is missing entirely", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { status, reason } = await postIssue(h, {});
    expect(status).toBe(400);
    expect(reason).toBe("title");
  });

  // The reason strings the hand-rolled validators answered, one per field,
  // unchanged by the migration.
  it.each([
    [{ title: "T", priority: "high" }, "priority"],
    [{ title: "T", estimate: 1.5 }, "estimate"],
    [{ title: "T", labels: [1] }, "labels"],
    [{ title: "T", labels: "bug" }, "labels"],
    [{ title: "T", type: "epic" }, "type"],
    [{ title: "T", body_format: "rtf" }, "body_format"],
    [{ title: "T", container: "someday" }, "container"],
    [{ title: "T", body: 3 }, "body"],
  ])("keeps the wire reason for %j", async (body, expected) => {
    const h = makeHarness();
    await createBoard(h);
    const { status, reason } = await postIssue(h, body);
    expect(status).toBe(400);
    expect(reason).toBe(expected);
  });

  // status stays Schema.Unknown so that a non-string and an unknown name give
  // ONE answer, as they always have. Typing it String would split this into
  // `status` for 3 and `status-not-a-column` for "Nope" — two reasons for one
  // broken field, and a changed string for a case already covered above.
  it.each([3, "Nope", null])("answers status-not-a-column for %j", async (v) => {
    const h = makeHarness();
    await createBoard(h);
    const { status, reason } = await postIssue(h, { title: "T", status: v });
    expect(status).toBe(400);
    expect(reason).toBe("status-not-a-column");
  });

  // EFB-38's split survives the migration: shape is the schema's answer,
  // roster membership is the handler's, and they answer different strings.
  it("separates a malformed assignee from a non-member one", async () => {
    const h = makeHarness();
    await createBoard(h);
    const bad = await postIssue(h, { title: "T", assignee_pubkey: "not a pubkey" });
    expect(bad.status).toBe(400);
    expect(bad.reason).toBe("assignee_pubkey");

    const stranger = await postIssue(h, {
      title: "T",
      assignee_pubkey: "049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2",
    });
    expect(stranger.status).toBe(400);
    expect(stranger.reason).toBe("not-a-member");
  });

  // Invariant 4 on the create path: the row stores the ONE canonical spelling,
  // whichever the caller sent. Two spellings of one key must not become two
  // assignees (EFB-38/42/51).
  it("stores the canonical identity form for a raw-hex assignee", async () => {
    const h = makeHarness();
    await createBoard(h);
    const boardId = h.db.boards[0]!["id"] as string;
    const hex = "049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2";
    seedBoardMember(h, boardId, `nostr:${hex}`, "contributor");
    const { status, issue } = await postIssue(h, { title: "T", assignee_pubkey: hex });
    expect(status).toBe(201);
    expect(issue!.assignee_pubkey).toBe(`nostr:${hex}`);
  });

  // The happy path is unchanged — the point of a migration.
  it("still creates with every accepted field and applies the same defaults", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { status, issue } = await postIssue(h, {
      title: "T",
      body: null,
      body_format: "plain",
      type: "bug",
      status: "In Progress",
      container: "active",
      priority: 2,
      estimate: 5,
      labels: ["a", "b"],
    });
    expect(status).toBe(201);
    expect(issue).toMatchObject({
      title: "T",
      body: null,
      body_format: "plain",
      type: "bug",
      status: "In Progress",
      container: "active",
      priority: 2,
      estimate: 5,
      labels: ["a", "b"],
      sprint_id: null,
    });
  });
});

describe("EFB-85 — POST /issues/:id/transition under parseRouteBody", () => {
  it("400s naming an unknown key", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const { status, reason } = await postTransition(h, issue.id, { to_colum: "Done" });
    expect(status).toBe(400);
    expect(reason).toBe("to_colum-unknown");
  });

  // QUIRK. The branch is `column_id !== undefined`, not a truthiness test, so
  // an explicit null ADDRESSES a column and fails as one — it does not fall
  // back to the `to` name-match. Making column_id nullable in the schema would
  // silently change which error a caller sees.
  it.each([null, 3])("treats column_id: %j as addressing a column, not a fallback", async (v) => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const { status, reason } = await postTransition(h, issue.id, { column_id: v, to: "Done" });
    expect(status).toBe(400);
    expect(reason).toBe("column_id");
  });

  it("400s naming column_id for a well-formed id that is not on this board", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const { status, reason } = await postTransition(h, issue.id, { column_id: "nope" });
    expect(status).toBe(400);
    expect(reason).toBe("column_id");
  });

  // QUIRK. `body.to ?? body.to_status` is NULLISH coalescing, so an explicit
  // `to: null` falls THROUGH to to_status rather than short-circuiting. This
  // test is the difference between `??` and `||`/`!== undefined`.
  it("falls through from a null `to` to `to_status`", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const { status, issue: moved } = await postTransition(h, issue.id, {
      to: null,
      to_status: "Done",
    });
    expect(status).toBe(200);
    expect(moved!.status).toBe("Done");
  });

  // Sending none of the three still reaches validateStatus(undefined). A
  // required-field rule in the schema would have changed this string.
  it("answers status-not-a-column for a body naming no destination", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const { status, reason } = await postTransition(h, issue.id, {});
    expect(status).toBe(400);
    expect(reason).toBe("status-not-a-column");
  });

  it("still transitions by column_id and by legacy name", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const board = h.db.boards[0]!;
    const columns = JSON.parse(board["columns"] as string) as Array<{ id: string; name: string }>;
    const done = columns.find((col) => col.name === "Done")!;

    const byId = await postTransition(h, issue.id, { column_id: done.id });
    expect(byId.status).toBe(200);
    expect(byId.issue!.status).toBe("Done");

    const second = await createIssue(h, { title: "Second" });
    const byName = await postTransition(h, second.id, { to: "Done" });
    expect(byName.status).toBe(200);
    expect(byName.issue!.status).toBe("Done");
  });
});

describe("EFB-85 — POST /issues/:id/move-to-board under parseRouteBody", () => {
  // Two problems in one body, and PARSE_OPTIONS carries `errors: "all"`, so
  // the caller learns about both in one round trip rather than fixing the typo
  // and then discovering the required field is missing. `target_board` is the
  // near-miss a client actually makes; naming BOTH is what makes the answer
  // self-diagnosing.
  it("reports the unknown key and the missing required field together", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const res = await h.app.request(
      url("issue.board.set", { id: issue.id }), jsonReq("PUT", { target_board: "x" }),
      {},
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe(
      "target_board-unknown,target_board_id",
    );
  });

  it.each([undefined, "", null, 3])("400s naming target_board_id for %j", async (v) => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const res = await h.app.request(
      url("issue.board.set", { id: issue.id }), jsonReq("PUT", v === undefined ? {} : { target_board_id: v }),
      {},
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("target_board_id");
  });

  // QUIRK, and the reason target_board_id is NonEmptyString rather than the
  // trim filter used on `title`: the old guard was `=== ""`, so "   " was
  // accepted and fell through to a board lookup that 404s. Tightening it to a
  // 400 would be a different answer to the same request.
  it("still lets a whitespace-only target reach the lookup and 404", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const res = await h.app.request(
      url("issue.board.set", { id: issue.id }), jsonReq("PUT", { target_board_id: "   " }),
      {},
    );
    expect(res.status).toBe(404);
  });

  // QUIRK. The body is parsed BEFORE the issue is fetched, so a malformed body
  // aimed at an issue that does not exist answers 400 about the body, not 404
  // about the issue. Parsing after the fetch would silently swap these.
  it("answers 400 for a bad body even when the issue does not exist", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(
      url("issue.board.set", { id: "does-not-exist" }), jsonReq("PUT", { target_board_id: "" }),
      {},
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("target_board_id");
  });
});

describe("EFB-85 — PATCH /issues/:id/reorder under parseRouteBody", () => {
  it("400s naming an unknown key", async () => {
    const h = makeHarness();
    await createBoard(h);
    const a = await createIssue(h);
    const { status, reason } = await reorderBody(h, a.id, { before_issue: "x" });
    expect(status).toBe(400);
    expect(reason).toBe("before_issue-unknown");
  });

  it.each(["before_issue_id", "after_issue_id"])("400s naming %s for a non-string", async (key) => {
    const h = makeHarness();
    await createBoard(h);
    const a = await createIssue(h);
    const { status, reason } = await reorderBody(h, a.id, { [key]: 3 });
    expect(status).toBe(400);
    expect(reason).toBe(key);
  });

  // QUIRK. An explicit null means "no neighbour on this side" — the same
  // statement as omitting the key — so a body of two nulls is the both-missing
  // case and answers `neighbors`. `requireAnyOf` would have answered
  // `empty-patch` here, because both keys ARE present.
  it("treats two explicit nulls as no neighbours at all", async () => {
    const h = makeHarness();
    await createBoard(h);
    const a = await createIssue(h);
    const { status, reason } = await reorderBody(h, a.id, {
      before_issue_id: null,
      after_issue_id: null,
    });
    expect(status).toBe(400);
    expect(reason).toBe("neighbors");
  });

  // QUIRK, and the reason these are plain `Schema.String`: "" is a well-formed
  // id that fails the LOOKUP, so it answers `neighbors`. Under NonEmptyString
  // it would answer `before_issue_id` — a changed error string, which is the
  // one thing a migration may not do quietly.
  it("still routes an empty-string neighbour to the lookup, not the schema", async () => {
    const h = makeHarness();
    await createBoard(h);
    const a = await createIssue(h);
    const { status, reason } = await reorderBody(h, a.id, { before_issue_id: "" });
    expect(status).toBe(400);
    expect(reason).toBe("neighbors");
  });

  it("still reorders against a real neighbour", async () => {
    const h = makeHarness();
    await createBoard(h);
    const a = await createIssue(h);
    const b = await createIssue(h, { title: "B" });
    const { status } = await reorderBody(h, b.id, { after_issue_id: a.id });
    expect(status).toBe(200);
  });
});
