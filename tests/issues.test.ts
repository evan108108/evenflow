import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueShape } from "../src/shapes";
import {
  CALLER,
  bearer,
  createBoard,
  createIssue,
  jsonReq,
  makeHarness,
  seedForeignBoardAndIssue,
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
      assignee_pubkey: "github:7",
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
      const res = await h.app.request("/api/v0/boards/kb/issues", jsonReq("POST", body), {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-body", reason });
    }
  });

  it("404s on an unknown board and on someone else's board", async () => {
    const h = makeHarness();
    seedForeignBoardAndIssue(h);
    for (const slug of ["nope", "theirs"]) {
      const res = await h.app.request(`/api/v0/boards/${slug}/issues`, jsonReq("POST", { title: "x" }), {});
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
    const res = await h.app.request("/api/v0/boards/kb/issues?limit=2", { headers: bearer }, {});
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
    const res = await h.app.request(`/api/v0/boards/kb/issues?after=${ids[1]}`, { headers: bearer }, {});
    const body = (await res.json()) as { issues: IssueShape[]; has_more: boolean };
    expect(body.issues.map((i) => i.title)).toEqual(["a"]);
    expect(body.has_more).toBe(false);
  });

  it("filters by status, container, and label — one at a time", async () => {
    const h = makeHarness();
    await createBoard(h);
    await createIssue(h, { title: "todo-active", status: "Todo", container: "active" });
    vi.setSystemTime(2_000);
    await createIssue(h, { title: "labeled", status: "In Review", labels: ["bug"] });

    const byStatus = (await (
      await h.app.request("/api/v0/boards/kb/issues?status=Todo", { headers: bearer }, {})
    ).json()) as { issues: IssueShape[]; total: number };
    expect(byStatus.issues.map((i) => i.title)).toEqual(["todo-active"]);
    expect(byStatus.total).toBe(1);

    const byContainer = (await (
      await h.app.request("/api/v0/boards/kb/issues?container=active", { headers: bearer }, {})
    ).json()) as { issues: IssueShape[] };
    expect(byContainer.issues.map((i) => i.title)).toEqual(["todo-active"]);

    const byLabel = (await (
      await h.app.request("/api/v0/boards/kb/issues?label=bug", { headers: bearer }, {})
    ).json()) as { issues: IssueShape[] };
    expect(byLabel.issues.map((i) => i.title)).toEqual(["labeled"]);

    const combined = await h.app.request(
      "/api/v0/boards/kb/issues?status=Todo&container=active",
      { headers: bearer },
      {},
    );
    expect(combined.status).toBe(400);
    expect(await combined.json()).toEqual({ error: "invalid-body", reason: "one-filter-at-a-time" });
  });
});

describe("GET /api/v0/issues/:id", () => {
  it("returns the issue; 404s on unknown and foreign issues", async () => {
    const h = makeHarness();
    await createBoard(h);
    seedForeignBoardAndIssue(h);
    const issue = await createIssue(h);
    const ok = await h.app.request(`/api/v0/issues/${issue.id}`, { headers: bearer }, {});
    expect(ok.status).toBe(200);
    for (const id of ["nope", "fi"]) {
      const res = await h.app.request(`/api/v0/issues/${id}`, { headers: bearer }, {});
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
      `/api/v0/issues/${issue.id}`,
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
    await h.app.request(`/api/v0/issues/${issue.id}`, jsonReq("PATCH", { status: "In Progress" }), {});
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
      await h.app.request(`/api/v0/issues/${issue.id}`, jsonReq("PATCH", { status: "Done" }), {})
    ).json()) as { issue: IssueShape };
    expect(done.issue.completed_at_ms).toBe(5_000);
    expect(h.db.statusChanges[1]).toMatchObject({
      to_status: "Done",
      container_at_completion: "active",
    });

    vi.setSystemTime(6_000);
    const reverted = (await (
      await h.app.request(`/api/v0/issues/${issue.id}`, jsonReq("PATCH", { status: "In Review" }), {})
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
      const res = await h.app.request(`/api/v0/issues/${issue.id}`, jsonReq("PATCH", body), {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-body", reason });
    }
  });

  it("404s on a foreign issue", async () => {
    const h = makeHarness();
    seedForeignBoardAndIssue(h);
    const res = await h.app.request("/api/v0/issues/fi", jsonReq("PATCH", { title: "X" }), {});
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
      `/api/v0/issues/${issue.id}/transition`,
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
      `/api/v0/issues/${issue.id}/transition`,
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
      `/api/v0/issues/${issue.id}/transition`,
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
      await h.app.request(`/api/v0/issues/${issue.id}/promote_to_backlog`, jsonReq("POST"), {})
    ).json()) as { issue: IssueShape };
    expect(toBacklog.issue.container).toBe("backlog");

    vi.setSystemTime(3_000);
    const toActive = (await (
      await h.app.request(`/api/v0/issues/${issue.id}/promote_to_active`, jsonReq("POST"), {})
    ).json()) as { issue: IssueShape };
    expect(toActive.issue.container).toBe("active");

    vi.setSystemTime(4_000);
    const toIcebox = (await (
      await h.app.request(`/api/v0/issues/${issue.id}/send_to_icebox`, jsonReq("POST"), {})
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
      `/api/v0/issues/${issue.id}/promote_to_backlog`,
      jsonReq("POST"),
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
    await h.app.request(`/api/v0/issues/${issue.id}/comments`, jsonReq("POST", { body: "hi" }), {});
    expect(h.db.comments).toHaveLength(1);

    const res = await h.app.request(`/api/v0/issues/${issue.id}`, { method: "DELETE", headers: bearer }, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(h.db.issues).toHaveLength(0);
    expect(h.db.comments).toHaveLength(0);
    expect(h.db.statusChanges).toHaveLength(1); // audit survives

    const gone = await h.app.request(`/api/v0/issues/${issue.id}`, { headers: bearer }, {});
    expect(gone.status).toBe(404);
  });
});

describe("auth gating", () => {
  it.each([
    ["POST", "/api/v0/boards/kb/issues"],
    ["PATCH", "/api/v0/issues/x"],
    ["DELETE", "/api/v0/issues/x"],
    ["POST", "/api/v0/issues/x/transition"],
    ["POST", "/api/v0/issues/x/promote_to_backlog"],
    ["POST", "/api/v0/issues/x/promote_to_active"],
    ["POST", "/api/v0/issues/x/send_to_icebox"],
  ])("%s %s rejects unauthenticated mutations with 401", async (method, path) => {
    const h = makeHarness();
    const res = await h.app.request(path, { method }, {});
    expect(res.status).toBe(401);
  });

  // Reads run behind optionalAuth since phase 16: anonymous is allowed
  // through, and an unknown/private resource answers 404 (invisible), not
  // 401 — public boards are the only anonymous-readable surface.
  it.each([
    ["GET", "/api/v0/boards/kb/issues"],
    ["GET", "/api/v0/issues/x"],
  ])("%s %s answers 404 to anonymous callers on private/unknown resources", async (method, path) => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(path, { method }, {});
    expect(res.status).toBe(404);
  });

  it("serves board issues to anonymous callers once the board is public", async () => {
    const h = makeHarness();
    await createBoard(h);
    await createIssue(h);
    const patched = await h.app.request(
      "/api/v0/boards/kb",
      jsonReq("PATCH", { visibility: "public" }),
      {},
    );
    expect(patched.status).toBe(200);
    const res = await h.app.request("/api/v0/boards/kb/issues", {}, {});
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
      const res = await h.app.request(`/api/v0/issues/${ref}`, { headers: bearer }, {});
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
      "/api/v0/issues/BOA-1/transition",
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
    const res = await h.app.request("/api/v0/issues/BOA-99", { headers: bearer }, {});
    expect(res.status).toBe(404);
  });
});
