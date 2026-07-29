// Phase 20: sprint lifecycle + membership over the /api/v0 sprint routes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SprintShape } from "../src/shapes";
import { createBoard, createIssue, jsonReq, makeHarness, type Harness } from "./harness";

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
    // The Linear model: unfinished issues stay active, sprint_id intact.
    expect(h.db.issues[0]).toMatchObject({ container: "active", sprint_id: sprint.id });

    const addLate = await h.app.request(
      `/api/v0/boards/kb/sprints/${sprint.id}/add-issue`,
      jsonReq("POST", { issue_id: issue.id }),
      {},
    );
    expect(addLate.status).toBe(409);
  });
});
