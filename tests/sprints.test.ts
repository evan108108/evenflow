// Phase 20: sprint lifecycle + membership over the /api/v0 sprint routes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SprintShape } from "../src/shapes";
import { bearer, createBoard, createIssue, jsonReq, makeHarness, type Harness } from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const createSprint = async (
  h: Harness,
  overrides?: Record<string, unknown>,
  slug = "kb",
): Promise<SprintShape> => {
  const res = await h.app.request(
    `/api/v0/boards/${slug}/sprints`,
    jsonReq("POST", { name: "Sprint 1", ...overrides }),
    {},
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { sprint: SprintShape }).sprint;
};

const addIssue = async (h: Harness, sprintId: string, issueId: string, slug = "kb") => {
  const res = await h.app.request(
    `/api/v0/boards/${slug}/sprints/${sprintId}/add-issue`,
    jsonReq("POST", { issue_id: issueId }),
    {},
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<{ issue: { sprint_id: string | null } }>;
};

describe("POST /api/v0/boards/:slug/sprints", () => {
  it("creates a planning sprint", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h, { goal: "Ship the thing" });
    expect(sprint).toMatchObject({
      name: "Sprint 1",
      goal: "Ship the thing",
      status: "planning",
      started_at_ms: null,
      completed_at_ms: null,
      created_at_ms: 1_000,
    });
    expect(h.db.sprints).toHaveLength(1);
  });

  it("rejects an empty name and anonymous callers", async () => {
    const h = makeHarness();
    await createBoard(h);
    const bad = await h.app.request("/api/v0/boards/kb/sprints", jsonReq("POST", { name: "  " }), {});
    expect(bad.status).toBe(400);
    const anon = await h.app.request("/api/v0/boards/kb/sprints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Sprint 1" }),
    }, {});
    expect(anon.status).toBe(401);
  });
});

describe("GET /api/v0/boards/:slug/sprints", () => {
  it("lists sprints oldest-first", async () => {
    const h = makeHarness();
    await createBoard(h);
    await createSprint(h);
    vi.setSystemTime(2_000);
    await createSprint(h, { name: "Sprint 2" });
    const res = await h.app.request("/api/v0/boards/kb/sprints", jsonReq("GET"), {});
    expect(res.status).toBe(200);
    const { sprints } = (await res.json()) as { sprints: SprintShape[] };
    expect(sprints.map((s) => s.name)).toEqual(["Sprint 1", "Sprint 2"]);
  });
});

describe("PATCH /api/v0/boards/:slug/sprints/:id", () => {
  it("renames and sets the goal", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const res = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}`,
      jsonReq("PATCH", { name: "Sprint One", goal: "Focus" }),
      {},
    );
    expect(res.status).toBe(200);
    expect(h.db.sprints[0]).toMatchObject({ name: "Sprint One", goal: "Focus" });
  });

  it("rejects an empty patch and 404s a foreign sprint id", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const empty = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}`,
      jsonReq("PATCH", {}),
      {},
    );
    expect(empty.status).toBe(400);
    const missing = await h.app.request(
      "/api/v0/boards/kb/sprints/nope",
      jsonReq("PATCH", { name: "X" }),
      {},
    );
    expect(missing.status).toBe(404);
  });
});

describe("sprint membership", () => {
  it("add-issue sets sprint_id, remove-issue clears it", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const issue = await createIssue(h);
    const { issue: added } = await addIssue(h, sprint.id, issue.id);
    expect(added.sprint_id).toBe(sprint.id);
    const res = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}/remove-issue`,
      jsonReq("POST", { issue_id: issue.id }),
      {},
    );
    expect(res.status).toBe(200);
    expect(h.db.issues[0]!["sprint_id"]).toBeNull();
  });

  it("404s an issue from another board", async () => {
    const h = makeHarness();
    await createBoard(h);
    await createBoard(h, "other");
    const sprint = await createSprint(h);
    const foreign = await createIssue(h, {}, "other");
    const res = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}/add-issue`,
      jsonReq("POST", { issue_id: foreign.id }),
      {},
    );
    expect(res.status).toBe(404);
  });

  it("issue PATCH rejects sprint_id as immutable", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const res = await h.app.request(
      `/api/v0/issues/${issue.id}`,
      jsonReq("PATCH", { sprint_id: "anything" }),
      {},
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "sprint_id-immutable" });
  });
});

describe("sprint lifecycle", () => {
  it("start moves the sprint's backlog issues to active and stamps the sprint", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const a = await createIssue(h, { title: "A" });
    const b = await createIssue(h, { title: "B" });
    const alreadyActive = await createIssue(h, { title: "C", container: "active" });
    await addIssue(h, sprint.id, a.id);
    await addIssue(h, sprint.id, b.id);
    await addIssue(h, sprint.id, alreadyActive.id);

    vi.setSystemTime(5_000);
    const res = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}/start`,
      jsonReq("POST", {}),
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sprint: SprintShape; issues_moved: number };
    expect(body.sprint).toMatchObject({ status: "active", started_at_ms: 5_000 });
    expect(body.issues_moved).toBe(2); // C was already active
    for (const id of [a.id, b.id, alreadyActive.id]) {
      expect(h.db.issues.find((r) => r["id"] === id)!["container"]).toBe("active");
    }
    // One creation row per issue + one container-move row per moved issue.
    const moves = h.db.statusChanges.filter((r) => r["to_container"] === "active" && r["from_container"] === "backlog");
    expect(moves).toHaveLength(2);
  });

  it("start is planning-only; complete is active-only and leaves issues active", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const issue = await createIssue(h);
    await addIssue(h, sprint.id, issue.id);

    const completeEarly = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}/complete`,
      jsonReq("POST", {}),
      {},
    );
    expect(completeEarly.status).toBe(409);

    await h.app.request(`/api/v0/boards/kb/sprints/${sprint.id}/start`, jsonReq("POST", {}), {});
    const restart = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}/start`,
      jsonReq("POST", {}),
      {},
    );
    expect(restart.status).toBe(409);

    vi.setSystemTime(9_000);
    const complete = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}/complete`,
      jsonReq("POST", {}),
      {},
    );
    expect(complete.status).toBe(200);
    expect(h.db.sprints[0]).toMatchObject({ status: "completed", completed_at_ms: 9_000 });
    // Phase 21b: non-Done members without a next planning sprint DROP —
    // container stays where it was, but sprint_id clears. (Container
    // survives because the point of completion is bookkeeping, not moving
    // work off the Kanban.)
    expect(h.db.issues[0]).toMatchObject({ container: "active", sprint_id: null });

    const addLate = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}/add-issue`,
      jsonReq("POST", { issue_id: issue.id }),
      {},
    );
    expect(addLate.status).toBe(409);
  });
});

describe("sprint length (migration 0011)", () => {
  it("create defaults planned_days to null, stores an explicit override", async () => {
    const h = makeHarness();
    await createBoard(h);
    const plain = await createSprint(h);
    expect(plain.planned_days).toBeNull();
    const custom = await createSprint(h, { name: "Sprint 2", planned_days: 7 });
    expect(custom.planned_days).toBe(7);
    expect(h.db.sprints[1]!["planned_days"]).toBe(7);
  });

  it("rejects out-of-range or non-integer planned_days", async () => {
    const h = makeHarness();
    await createBoard(h);
    for (const bad of [0, 91, 1.5, "7"]) {
      const res = await h.app.request(
        "/api/v0/boards/kb/sprints",
        jsonReq("POST", { name: "S", planned_days: bad }),
        {},
      );
      expect(res.status).toBe(400);
    }
  });

  it("planned_days is editable while planning, 409 once started", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const patch = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}`,
      jsonReq("PATCH", { planned_days: 5 }),
      {},
    );
    expect(patch.status).toBe(200);
    expect(h.db.sprints[0]!["planned_days"]).toBe(5);
    // Clearing back to the board default is also a planning-time edit.
    const clear = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}`,
      jsonReq("PATCH", { planned_days: null }),
      {},
    );
    expect(clear.status).toBe(200);
    expect(h.db.sprints[0]!["planned_days"]).toBeNull();

    await h.app.request(`/api/v0/boards/kb/sprints/${sprint.id}/start`, jsonReq("POST", {}), {});
    const late = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}`,
      jsonReq("PATCH", { planned_days: 21 }),
      {},
    );
    expect(late.status).toBe(409);
    // Name/goal stay editable on an active sprint.
    const rename = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}`,
      jsonReq("PATCH", { name: "Renamed" }),
      {},
    );
    expect(rename.status).toBe(200);
  });

  it("board PATCH round-trips default_sprint_days and validates the range", async () => {
    const h = makeHarness();
    await createBoard(h);
    const ok = await h.app.request("/api/v0/boards/kb", jsonReq("PATCH", { default_sprint_days: 7 }), {});
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { board: { default_sprint_days: number } }).board.default_sprint_days).toBe(7);
    expect(h.db.boards[0]!["default_sprint_days"]).toBe(7);
    for (const bad of [0, 91, 2.5, "7"]) {
      const res = await h.app.request(
        "/api/v0/boards/kb",
        jsonReq("PATCH", { default_sprint_days: bad }),
        {},
      );
      expect(res.status).toBe(400);
    }
  });
});

describe("phase 21a — sprint membership audit + delete", () => {
  it("add-issue inserts an open sprintMembership row; remove-issue stamps removed_at_ms", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const issue = await createIssue(h);

    vi.setSystemTime(2_000);
    await addIssue(h, sprint.id, issue.id);
    expect(h.db.sprintMemberships).toHaveLength(1);
    expect(h.db.sprintMemberships[0]).toMatchObject({
      sprint_id: sprint.id,
      issue_id: issue.id,
      added_at_ms: 2_000,
      removed_at_ms: null,
    });

    vi.setSystemTime(3_000);
    const res = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}/remove-issue`,
      jsonReq("POST", { issue_id: issue.id }),
      {},
    );
    expect(res.status).toBe(200);
    expect(h.db.sprintMemberships[0]!["removed_at_ms"]).toBe(3_000);
  });

  it("add-issue on an ACTIVE sprint increments adds_mid_sprint", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const seed = await createIssue(h, { title: "seed" });
    await addIssue(h, sprint.id, seed.id);
    await h.app.request(`/api/v0/boards/kb/sprints/${sprint.id}/start`, jsonReq("POST", {}), {});
    expect(h.db.sprints[0]!["adds_mid_sprint"] ?? 0).toBe(0);

    const late = await createIssue(h, { title: "late" });
    await addIssue(h, sprint.id, late.id);
    expect(h.db.sprints[0]!["adds_mid_sprint"]).toBe(1);
  });

  it("DELETE /sprints/:id (planning) clears members and drops the sprint", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const a = await createIssue(h, { title: "A" });
    const b = await createIssue(h, { title: "B" });
    await addIssue(h, sprint.id, a.id);
    await addIssue(h, sprint.id, b.id);

    const res = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}`,
      { method: "DELETE", headers: { ...bearer } },
      {},
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: true, member_count: 2 });
    expect(h.db.sprints).toHaveLength(0);
    expect(h.db.sprintMemberships).toHaveLength(0);
    expect(h.db.issues.find((r) => r["id"] === a.id)!["sprint_id"]).toBeNull();
    expect(h.db.issues.find((r) => r["id"] === b.id)!["sprint_id"]).toBeNull();
  });

  it("complete: Done members stay in sprint with was_completed_in_sprint=1; non-Done carry to auto-picked next planning sprint", async () => {
    const h = makeHarness();
    await createBoard(h);
    const s1 = await createSprint(h);
    const s2 = await createSprint(h, { name: "Sprint 2" });
    const done = await createIssue(h, { title: "shipped", estimate: 3 });
    const undone = await createIssue(h, { title: "wip", estimate: 5 });
    await addIssue(h, s1.id, done.id);
    await addIssue(h, s1.id, undone.id);
    await h.app.request(`/api/v0/boards/kb/sprints/${s1.id}/start`, jsonReq("POST", {}), {});
    // Mark "done" issue as actually done (column category=done) via transition.
    const doneColumn = h.db.boards[0]!["columns"] as unknown as string;
    const cols = JSON.parse(doneColumn) as Array<{ id: string; name: string; category: string }>;
    const doneCol = cols.find((c) => c.category === "done")!;
    await h.app.request(
      `/api/v0/issues/${done.id}/transition`,
      jsonReq("POST", { column_id: doneCol.id }),
      {},
    );

    vi.setSystemTime(9_000);
    const complete = await h.app.request(
      `/api/v0/boards/kb/sprints/${s1.id}/complete`,
      jsonReq("POST", {}),
      {},
    );
    expect(complete.status).toBe(200);
    const body = (await complete.json()) as {
      sprint: { points_completed: number; points_carried: number };
      carried_to_sprint_id: string | null;
    };
    expect(body.sprint.points_completed).toBe(3);
    expect(body.sprint.points_carried).toBe(5);
    expect(body.carried_to_sprint_id).toBe(s2.id);

    // Done issue: still in sprint 1, membership marked completed.
    expect(h.db.issues.find((r) => r["id"] === done.id)!["sprint_id"]).toBe(s1.id);
    const doneMembership = h.db.sprintMemberships.find(
      (m) => m["sprint_id"] === s1.id && m["issue_id"] === done.id,
    );
    expect(doneMembership).toMatchObject({
      was_completed_in_sprint: 1,
      removed_at_ms: 9_000,
      carried_to_sprint_id: null,
    });

    // Undone issue: sprint_id now s2, old membership closed with
    // carried_to_sprint_id, fresh open membership on s2.
    expect(h.db.issues.find((r) => r["id"] === undone.id)!["sprint_id"]).toBe(s2.id);
    const oldUndoneM = h.db.sprintMemberships.find(
      (m) => m["sprint_id"] === s1.id && m["issue_id"] === undone.id,
    )!;
    expect(oldUndoneM).toMatchObject({
      was_completed_in_sprint: 0,
      removed_at_ms: 9_000,
      carried_to_sprint_id: s2.id,
    });
    const newUndoneM = h.db.sprintMemberships.find(
      (m) => m["sprint_id"] === s2.id && m["issue_id"] === undone.id && m["removed_at_ms"] === null,
    );
    expect(newUndoneM).toBeDefined();
  });

  it("complete: carryOver='drop' clears sprint_id on non-Done members", async () => {
    const h = makeHarness();
    await createBoard(h);
    const s1 = await createSprint(h);
    const s2 = await createSprint(h, { name: "Sprint 2" });
    const issue = await createIssue(h, { estimate: 2 });
    await addIssue(h, s1.id, issue.id);
    await h.app.request(`/api/v0/boards/kb/sprints/${s1.id}/start`, jsonReq("POST", {}), {});
    const complete = await h.app.request(
      `/api/v0/boards/kb/sprints/${s1.id}/complete`,
      jsonReq("POST", { carryOver: "drop" }),
      {},
    );
    expect(complete.status).toBe(200);
    expect(h.db.issues[0]!["sprint_id"]).toBeNull();
    // s2 stays empty — drop is explicit.
    expect(h.db.sprintMemberships.some((m) => m["sprint_id"] === s2.id)).toBe(false);
  });

  it("start snapshots points_committed_start", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const a = await createIssue(h, { estimate: 3 });
    const b = await createIssue(h, { estimate: 5 });
    const c = await createIssue(h, { estimate: null });
    await addIssue(h, sprint.id, a.id);
    await addIssue(h, sprint.id, b.id);
    await addIssue(h, sprint.id, c.id);
    const start = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}/start`,
      jsonReq("POST", {}),
      {},
    );
    expect(start.status).toBe(200);
    expect(h.db.sprints[0]!["points_committed_start"]).toBe(8);
  });

  it("GET /sprints/:id/archive groups memberships by outcome", async () => {
    const h = makeHarness();
    await createBoard(h);
    const s1 = await createSprint(h);
    const s2 = await createSprint(h, { name: "Sprint 2" });
    const done = await createIssue(h, { title: "shipped", estimate: 2 });
    const carried = await createIssue(h, { title: "wip", estimate: 3 });
    await addIssue(h, s1.id, done.id);
    await addIssue(h, s1.id, carried.id);
    await h.app.request(`/api/v0/boards/kb/sprints/${s1.id}/start`, jsonReq("POST", {}), {});
    const cols = JSON.parse(h.db.boards[0]!["columns"] as unknown as string) as Array<{
      id: string;
      category: string;
    }>;
    const doneCol = cols.find((c) => c.category === "done")!;
    await h.app.request(
      `/api/v0/issues/${done.id}/transition`,
      jsonReq("POST", { column_id: doneCol.id }),
      {},
    );
    await h.app.request(`/api/v0/boards/kb/sprints/${s1.id}/complete`, jsonReq("POST", {}), {});

    const arch = await h.app.request(
      `/api/v0/boards/kb/sprints/${s1.id}/archive`,
      { headers: { ...bearer } },
      {},
    );
    expect(arch.status).toBe(200);
    const body = (await arch.json()) as {
      completed_in_sprint: Array<{ issue_id: string }>;
      carried_over: Array<{ issue_id: string; carried_to_sprint_id: string }>;
      dropped: unknown[];
      open: unknown[];
    };
    expect(body.completed_in_sprint.map((m) => m.issue_id)).toEqual([done.id]);
    expect(body.carried_over).toHaveLength(1);
    expect(body.carried_over[0]).toMatchObject({
      issue_id: carried.id,
      carried_to_sprint_id: s2.id,
    });
    expect(body.dropped).toHaveLength(0);
    expect(body.open).toHaveLength(0);
  });

  it("DELETE /sprints/:id refuses non-planning sprints with 409", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    await h.app.request(`/api/v0/boards/kb/sprints/${sprint.id}/start`, jsonReq("POST", {}), {});
    const active = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}`,
      { method: "DELETE", headers: { ...bearer } },
      {},
    );
    expect(active.status).toBe(409);

    await h.app.request(`/api/v0/boards/kb/sprints/${sprint.id}/complete`, jsonReq("POST", {}), {});
    const completed = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}`,
      { method: "DELETE", headers: { ...bearer } },
      {},
    );
    expect(completed.status).toBe(409);
  });
});
