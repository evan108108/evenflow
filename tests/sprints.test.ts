// Phase 20: sprint lifecycle + membership over the /api/v0 sprint routes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { url } from "../src/routes-manifest";
import { Effect, Exit } from "effect";
import type { SprintShape } from "../src/shapes";
import { decodeBody } from "../src/lib/route-body";
// EFB-98: the request schemas live with the logic that consumes them. The
// route imports them back for parseRouteBody; a schema test reads them here.
import { CompleteSprintBody, PatchSprintBody, PostSprintBody } from "../src/actions/sprints";
import { KANBAN_PLAINTEXT_PATH } from "../src/lib/kanban/publish";
import {
  bearer,
  createBoard,
  createIssue,
  createPublicBoard,
  jsonReq,
  makeHarness,
  CALLER,
  type Harness,
} from "./harness";

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
    url("sprint.list", { slug: slug }),
    jsonReq("POST", { name: "Sprint 1", ...overrides }),
    {},
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { sprint: SprintShape }).sprint;
};

const addIssue = async (h: Harness, sprintId: string, issueId: string, slug = "kb") => {
  const res = await h.app.request(
    url("sprint.issues.attach", { slug: slug, id: sprintId }),
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
    const bad = await h.app.request(url("sprint.list", { slug: "kb" }), jsonReq("POST", { name: "  " }), {});
    expect(bad.status).toBe(400);
    const anon = await h.app.request(url("sprint.list", { slug: "kb" }), {
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
    const res = await h.app.request(url("sprint.list", { slug: "kb" }), jsonReq("GET"), {});
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
      url("sprint.update", { slug: "kb", id: sprint.id }),
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
      url("sprint.update", { slug: "kb", id: sprint.id }),
      jsonReq("PATCH", {}),
      {},
    );
    expect(empty.status).toBe(400);
    const missing = await h.app.request(
      url("sprint.update", { slug: "kb", id: "nope" }),
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
      url("sprint.issue.detach", { slug: "kb", id: sprint.id, issue_id: issue.id }),
      jsonReq("DELETE"),
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
      url("sprint.issues.attach", { slug: "kb", id: sprint.id }),
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
      url("issue.get", { id: issue.id }),
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
      url("sprint.start", { slug: "kb", id: sprint.id }),
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
      url("sprint.complete", { slug: "kb", id: sprint.id }),
      jsonReq("POST", {}),
      {},
    );
    expect(completeEarly.status).toBe(409);

    await h.app.request(url("sprint.start", { slug: "kb", id: sprint.id }), jsonReq("POST", {}), {});
    const restart = await h.app.request(
      url("sprint.start", { slug: "kb", id: sprint.id }),
      jsonReq("POST", {}),
      {},
    );
    expect(restart.status).toBe(409);

    vi.setSystemTime(9_000);
    const complete = await h.app.request(
      url("sprint.complete", { slug: "kb", id: sprint.id }),
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
      url("sprint.issues.attach", { slug: "kb", id: sprint.id }),
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
        url("sprint.list", { slug: "kb" }),
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
      url("sprint.update", { slug: "kb", id: sprint.id }),
      jsonReq("PATCH", { planned_days: 5 }),
      {},
    );
    expect(patch.status).toBe(200);
    expect(h.db.sprints[0]!["planned_days"]).toBe(5);
    // Clearing back to the board default is also a planning-time edit.
    const clear = await h.app.request(
      url("sprint.update", { slug: "kb", id: sprint.id }),
      jsonReq("PATCH", { planned_days: null }),
      {},
    );
    expect(clear.status).toBe(200);
    expect(h.db.sprints[0]!["planned_days"]).toBeNull();

    await h.app.request(url("sprint.start", { slug: "kb", id: sprint.id }), jsonReq("POST", {}), {});
    const late = await h.app.request(
      url("sprint.update", { slug: "kb", id: sprint.id }),
      jsonReq("PATCH", { planned_days: 21 }),
      {},
    );
    expect(late.status).toBe(409);
    // Name/goal stay editable on an active sprint.
    const rename = await h.app.request(
      url("sprint.update", { slug: "kb", id: sprint.id }),
      jsonReq("PATCH", { name: "Renamed" }),
      {},
    );
    expect(rename.status).toBe(200);
  });

  it("board PATCH round-trips default_sprint_days and validates the range", async () => {
    const h = makeHarness();
    await createBoard(h);
    const ok = await h.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", { default_sprint_days: 7 }), {});
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { board: { default_sprint_days: number } }).board.default_sprint_days).toBe(7);
    expect(h.db.boards[0]!["default_sprint_days"]).toBe(7);
    for (const bad of [0, 91, 2.5, "7"]) {
      const res = await h.app.request(
        url("board.get", { slug: "kb" }),
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
      url("sprint.issue.detach", { slug: "kb", id: sprint.id, issue_id: issue.id }),
      jsonReq("DELETE"),
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
    await h.app.request(url("sprint.start", { slug: "kb", id: sprint.id }), jsonReq("POST", {}), {});
    expect(h.db.sprints[0]!["adds_mid_sprint"] ?? 0).toBe(0);

    const late = await createIssue(h, { title: "late" });
    await addIssue(h, sprint.id, late.id);
    expect(h.db.sprints[0]!["adds_mid_sprint"]).toBe(1);
  });

  // ── EFB-17: container auto-promote on add-issue ────────────────────────
  //
  // The promote itself shipped in 1829699 (2026-07-30). It had NO test: a
  // mutation run that deleted the whole promote block left all 759 tests
  // green, which is why these exist. The behaviour under test is the
  // symmetry with start-sprint — an issue joining an ALREADY-ACTIVE sprint
  // has to land on the Kanban, or it silently joins and stays invisible,
  // which is the bug Evan hit during the 2026-07-30 dogfood.
  //
  // Note `icebox`, not "iced" — CONTAINERS is ["icebox", "backlog", "active"]
  // (src/shapes.ts:298).

  /** Events emitted by one request, isolated from the running total. */
  const emittedBy = async (h: Harness, run: () => unknown) => {
    const before = h.emitter.events.length;
    await run();
    return h.emitter.events.slice(before).map((e) => e.event);
  };

  const startSprint = (h: Harness, sprintId: string) =>
    h.app.request(url("sprint.start", { slug: "kb", id: sprintId }), jsonReq("POST", {}), {});

  it("add-issue to an ACTIVE sprint promotes a backlog issue and emits container_changed", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    await startSprint(h, sprint.id);
    const issue = await createIssue(h, { title: "late arrival" });
    expect(h.db.issues.find((i) => i["id"] === issue.id)?.["container"]).toBe("backlog");

    const events = await emittedBy(h, () => addIssue(h, sprint.id, issue.id));

    expect(h.db.issues.find((i) => i["id"] === issue.id)?.["container"]).toBe("active");
    // The container move is audited like any other, so a tide replay can see it.
    expect(
      h.db.statusChanges.some(
        (s) =>
          s["issue_id"] === issue.id &&
          s["from_container"] === "backlog" &&
          s["to_container"] === "active",
      ),
    ).toBe(true);

    // Pinning the SHAPE, not just the fact of an emit. One event carries the
    // whole issue plus from/to, so no consumer is starved — see below for why
    // the absence of a second event is the load-bearing half.
    expect(events.map((e) => e.kind)).toEqual(["issue.container_changed"]);
    expect(events[0]).toMatchObject({
      kind: "issue.container_changed",
      issue_id: issue.id,
      payload: { from_container: "backlog", to_container: "active" },
    });
    expect((events[0]!.payload as { issue: { container: string } }).issue.container).toBe("active");
  });

  it("add-issue does NOT also emit issue.updated when it promotes", async () => {
    // The deliberate choice, pinned so a refactor can't quietly double the
    // emit: on the promote path `issue.container_changed` REPLACES
    // `issue.updated` rather than following it. Consumers get one event
    // carrying everything. If someone later decides both should fire, this
    // test is where that decision has to be made on purpose.
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    await startSprint(h, sprint.id);
    const issue = await createIssue(h, { title: "late arrival" });

    const events = await emittedBy(h, () => addIssue(h, sprint.id, issue.id));

    expect(events.filter((e) => e.kind === "issue.updated")).toEqual([]);
  });

  it("the single-event choice is specific to promoting add-issue, not systemic", async () => {
    // Guards the inverse misreading — that container_changed generally
    // supplants issue.updated. An ordinary mutation on an already-promoted
    // issue still emits issue.updated.
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    await startSprint(h, sprint.id);
    const issue = await createIssue(h, { title: "late arrival" });
    await addIssue(h, sprint.id, issue.id);

    const events = await emittedBy(h, () =>
      h.app.request(url("issue.get", { id: issue.id }), jsonReq("PATCH", { title: "renamed" }), {}),
    );

    expect(events.map((e) => e.kind)).toContain("issue.updated");
  });

  it("add-issue to an ACTIVE sprint leaves an ICEBOX issue in the icebox", async () => {
    // Icing is an explicit "not now". Scooping an iced issue onto the Kanban
    // because it happened to be added to a sprint would overrule the user.
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    await startSprint(h, sprint.id);
    const issue = await createIssue(h, { title: "not now" });
    const iced = await h.app.request(
      url("issue.container.set", { id: issue.id }),
      jsonReq("POST", { container: "icebox" }),
      {},
    );
    expect(iced.status).toBe(200);
    expect(h.db.issues.find((i) => i["id"] === issue.id)?.["container"]).toBe("icebox");

    const events = await emittedBy(h, () => addIssue(h, sprint.id, issue.id));

    expect(h.db.issues.find((i) => i["id"] === issue.id)?.["container"]).toBe("icebox");
    expect(events.map((e) => e.kind)).toEqual(["issue.updated"]);
  });

  // ── EFB-17: what the parseRouteBody migration added ─────────────────────
  //
  // add-issue / remove-issue were invisible to check:boundary until this
  // ticket widened its registration regex — they register through a template
  // literal inside a factory, which the old pattern could not match. Both
  // read a body, so both were unvalidated and unreported at once.

  it("add-issue rejects an unknown key rather than ignoring it", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const issue = await createIssue(h, { title: "A" });

    const res = await h.app.request(
      url("sprint.issues.attach", { slug: "kb", id: sprint.id }),
      jsonReq("POST", { issue_id: issue.id, issue: "typo" }),
      {},
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("issue-unknown");
  });

  it("add-issue still answers issue_id for a missing or non-string value", async () => {
    // Pre-migration behaviour, preserved exactly. `Schema.String` rather than
    // NonEmptyString is deliberate: an empty id keeps reaching the lookup and
    // answering 404, because changing a status code is its own ticket.
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);

    const missing = await h.app.request(
      url("sprint.issues.attach", { slug: "kb", id: sprint.id }),
      jsonReq("POST", {}),
      {},
    );
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { reason: string }).reason).toBe("issue_id");

    const wrongType = await h.app.request(
      url("sprint.issues.attach", { slug: "kb", id: sprint.id }),
      jsonReq("POST", { issue_id: 7 }),
      {},
    );
    expect(wrongType.status).toBe(400);
    expect(((await wrongType.json()) as { reason: string }).reason).toBe("issue_id");

    const empty = await h.app.request(
      url("sprint.issues.attach", { slug: "kb", id: sprint.id }),
      jsonReq("POST", { issue_id: "" }),
      {},
    );
    expect(empty.status).toBe(404);
  });

  // EFB-98: detach used to be a POST carrying `{issue_id}`, so it shared the
  // unknown-key guarantee asserted for attach above. It is a DELETE on an
  // addressable member now and reads no body at all, which means there is no
  // body to reject a key from — the guarantee did not weaken, it stopped
  // applying. What replaces it is that the target genuinely comes from the
  // PATH: an id that names nothing has to 404 rather than silently detach
  // whatever the sprint happened to hold.
  it("remove-issue takes its target from the path, and 404s an id that names nothing", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const issue = await createIssue(h, { title: "A" });
    await addIssue(h, sprint.id, issue.id);

    const res = await h.app.request(
      url("sprint.issue.detach", { slug: "kb", id: sprint.id, issue_id: "no-such-issue" }),
      jsonReq("DELETE"),
      {},
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as { reason: string }).reason).toBe("issue");
    // The real member is untouched by the failed detach.
    expect(h.db.issues.find((i) => i["id"] === issue.id)?.["sprint_id"]).toBe(sprint.id);
  });

  it("add-issue to a PLANNING sprint leaves the container at backlog", async () => {
    // Only an ACTIVE sprint promotes. A planning sprint is a list, not a
    // commitment — its members belong on the Backlog until it starts.
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const issue = await createIssue(h, { title: "planned" });

    const events = await emittedBy(h, () => addIssue(h, sprint.id, issue.id));

    expect(h.db.sprints[0]!["status"]).toBe("planning");
    expect(h.db.issues.find((i) => i["id"] === issue.id)?.["container"]).toBe("backlog");
    expect(events.map((e) => e.kind)).toEqual(["issue.updated"]);
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
      url("sprint.update", { slug: "kb", id: sprint.id }),
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
    await h.app.request(url("sprint.start", { slug: "kb", id: s1.id }), jsonReq("POST", {}), {});
    // Mark "done" issue as actually done (column category=done) via transition.
    const doneColumn = h.db.boards[0]!["columns"] as unknown as string;
    const cols = JSON.parse(doneColumn) as Array<{ id: string; name: string; category: string }>;
    const doneCol = cols.find((c) => c.category === "done")!;
    await h.app.request(
      url("issue.transition", { id: done.id }),
      jsonReq("POST", { column_id: doneCol.id }),
      {},
    );

    vi.setSystemTime(9_000);
    const complete = await h.app.request(
      url("sprint.complete", { slug: "kb", id: s1.id }),
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
    await h.app.request(url("sprint.start", { slug: "kb", id: s1.id }), jsonReq("POST", {}), {});
    const complete = await h.app.request(
      url("sprint.complete", { slug: "kb", id: s1.id }),
      jsonReq("POST", { carryOver: "drop" }),
      {},
    );
    expect(complete.status).toBe(200);
    expect(h.db.issues[0]!["sprint_id"]).toBeNull();
    // s2 stays empty — drop is explicit.
    expect(h.db.sprintMemberships.some((m) => m["sprint_id"] === s2.id)).toBe(false);
  });

  it("start sweeps non-Done active-container issues into the sprint", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    // Pre-existing active card, not previously assigned to any sprint.
    const orphan = await createIssue(h, { title: "orphan", container: "active", estimate: 4 });
    // Pre-existing active card that's already DONE (column category=done).
    const done = await createIssue(h, { title: "done", container: "active", estimate: 8 });
    const cols = JSON.parse(h.db.boards[0]!["columns"] as unknown as string) as Array<{
      id: string;
      category: string;
    }>;
    const doneCol = cols.find((c) => c.category === "done")!;
    await h.app.request(
      url("issue.transition", { id: done.id }),
      jsonReq("POST", { column_id: doneCol.id }),
      {},
    );
    // Backlog card pre-assigned to the sprint (the normal path).
    const planned = await createIssue(h, { title: "planned", estimate: 3 });
    await addIssue(h, sprint.id, planned.id);

    const res = await h.app.request(
      url("sprint.start", { slug: "kb", id: sprint.id }),
      jsonReq("POST", {}),
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issues_moved: number; issues_swept_in: number };
    expect(body.issues_moved).toBe(1); // planned (backlog→active)
    expect(body.issues_swept_in).toBe(1); // orphan (active, non-done, no sprint)

    expect(h.db.issues.find((r) => r["id"] === orphan.id)!["sprint_id"]).toBe(sprint.id);
    expect(h.db.issues.find((r) => r["id"] === done.id)!["sprint_id"] ?? null).toBeNull();
    // Committed points include all three: planned(3) + orphan(4). Done issue excluded.
    // Actually done is not in the sprint, so its 8 isn't counted. planned=3 + orphan=4 = 7.
    expect(h.db.sprints[0]!["points_committed_start"]).toBe(7);

    // Audit: orphan gets an open membership row.
    expect(
      h.db.sprintMemberships.some(
        (m) => m["sprint_id"] === sprint.id && m["issue_id"] === orphan.id && m["removed_at_ms"] === null,
      ),
    ).toBe(true);
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
      url("sprint.start", { slug: "kb", id: sprint.id }),
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
    await h.app.request(url("sprint.start", { slug: "kb", id: s1.id }), jsonReq("POST", {}), {});
    const cols = JSON.parse(h.db.boards[0]!["columns"] as unknown as string) as Array<{
      id: string;
      category: string;
    }>;
    const doneCol = cols.find((c) => c.category === "done")!;
    await h.app.request(
      url("issue.transition", { id: done.id }),
      jsonReq("POST", { column_id: doneCol.id }),
      {},
    );
    await h.app.request(url("sprint.complete", { slug: "kb", id: s1.id }), jsonReq("POST", {}), {});

    const arch = await h.app.request(
      url("sprint.archivedIssues.list", { slug: "kb", id: s1.id }),
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
    await h.app.request(url("sprint.start", { slug: "kb", id: sprint.id }), jsonReq("POST", {}), {});
    const active = await h.app.request(
      url("sprint.update", { slug: "kb", id: sprint.id }),
      { method: "DELETE", headers: { ...bearer } },
      {},
    );
    expect(active.status).toBe(409);

    await h.app.request(url("sprint.complete", { slug: "kb", id: sprint.id }), jsonReq("POST", {}), {});
    const completed = await h.app.request(
      url("sprint.update", { slug: "kb", id: sprint.id }),
      { method: "DELETE", headers: { ...bearer } },
      {},
    );
    expect(completed.status).toBe(409);
  });
});

// ── EFB-84: PostSprintBody / PatchSprintBody / CompleteSprintBody ──────────
//
// Predicate-inventory tests, same discipline as EFB-61's boards.ts pass. The
// migration's risk is not that a schema rejects too little — it is that a
// schema silently reproduces a DIFFERENT predicate than the hand-rolled check
// it replaced, and every route test above still passes because none of them
// exercised that exact input.
//
// So each of these pins ONE predicate and asserts the WIRE REASON, because the
// reason string is what a client branches on and it is not recoverable from
// "the request 400'd".
describe("sprint request schemas (EFB-84)", () => {
  const decode = <A, I>(schema: Parameters<typeof decodeBody<A, I>>[0], input: unknown) =>
    Effect.runSync(Effect.exit(decodeBody(schema, input)));

  const reasonOf = (exit: Exit.Exit<unknown, unknown>): string => {
    if (Exit.isSuccess(exit)) return "<succeeded>";
    const err = (exit.cause as { error?: { reason?: string } }).error;
    return err?.reason ?? "<no reason>";
  };

  const post = (input: unknown) => reasonOf(decode(PostSprintBody, input));
  const patch = (input: unknown) => reasonOf(decode(PatchSprintBody, input));
  const complete = (input: unknown) => reasonOf(decode(CompleteSprintBody, input));

  describe("PostSprintBody", () => {
    it("accepts the minimum body and every optional field", () => {
      expect(Exit.isSuccess(decode(PostSprintBody, { name: "S1" }))).toBe(true);
      expect(
        Exit.isSuccess(
          decode(PostSprintBody, { name: "S1", goal: "Ship it", planned_days: 14 }),
        ),
      ).toBe(true);
    });

    it("requires a name", () => {
      expect(post({})).toBe("name");
      expect(post({ name: 3 })).toBe("name");
    });

    // The predicate mismatch this discipline exists to catch. `minLength(1)`
    // would accept "   "; the check being replaced was `.trim() !== ""`.
    it("rejects a whitespace-only name — trim, not minLength", () => {
      expect(post({ name: "   " })).toBe("name");
      expect(Exit.isSuccess(decode(PostSprintBody, { name: " S " }))).toBe(true);
    });

    // The second half of the same predicate: the cap measured the UNTRIMMED
    // string, so 2 spaces + 79 characters was 81 and rejected. A schema that
    // trimmed before measuring would start accepting it.
    it("caps the name at 80 characters, measured untrimmed", () => {
      expect(Exit.isSuccess(decode(PostSprintBody, { name: "x".repeat(80) }))).toBe(true);
      expect(post({ name: "x".repeat(81) })).toBe("name");
      expect(post({ name: "  " + "x".repeat(79) })).toBe("name");
    });

    it("allows a null goal and caps it at 200", () => {
      expect(Exit.isSuccess(decode(PostSprintBody, { name: "S", goal: null }))).toBe(true);
      expect(Exit.isSuccess(decode(PostSprintBody, { name: "S", goal: "" }))).toBe(true);
      expect(post({ name: "S", goal: "x".repeat(201) })).toBe("goal");
      expect(post({ name: "S", goal: 3 })).toBe("goal");
    });

    it("allows a null planned_days and bounds it to 1..90", () => {
      expect(Exit.isSuccess(decode(PostSprintBody, { name: "S", planned_days: null }))).toBe(true);
      expect(post({ name: "S", planned_days: 0 })).toBe("planned_days");
      expect(post({ name: "S", planned_days: 91 })).toBe("planned_days");
      expect(post({ name: "S", planned_days: 1.5 })).toBe("planned_days");
    });

    it("REJECTS an unknown key", () => {
      expect(post({ name: "S", bogus: 1 })).toBe("bogus-unknown");
    });
  });

  describe("PatchSprintBody", () => {
    it("requires at least one patchable field", () => {
      expect(patch({})).toBe("empty-patch");
      expect(Exit.isSuccess(decode(PatchSprintBody, { name: "S" }))).toBe(true);
      expect(Exit.isSuccess(decode(PatchSprintBody, { goal: null }))).toBe(true);
    });

    it("shares the name and goal predicates with POST", () => {
      expect(patch({ name: "   " })).toBe("name");
      expect(patch({ name: "x".repeat(81) })).toBe("name");
      expect(patch({ goal: "x".repeat(201) })).toBe("goal");
    });

    // Untyped ON PURPOSE — the handler answers 409 for a started sprint BEFORE
    // it validates the value, and typing the field here would move the 400
    // ahead of that 409. See the note on PatchSprintBody and the route test
    // below that pins the 409.
    it("passes planned_days through untyped", () => {
      expect(Exit.isSuccess(decode(PatchSprintBody, { planned_days: "nonsense" }))).toBe(true);
      expect(Exit.isSuccess(decode(PatchSprintBody, { planned_days: 999 }))).toBe(true);
    });

    // `-immutable` and `-unknown` say different things: the first tells a
    // caller the field is real and they want a different endpoint, the second
    // sends them hunting for a typo. `status` is real, and start/complete are
    // its endpoints.
    it("names real-but-unwritable fields immutable rather than unknown", () => {
      expect(patch({ name: "S", status: "active" })).toBe("status-immutable");
      expect(patch({ name: "S", id: "x" })).toBe("id-immutable");
      expect(patch({ name: "S", board_id: "x" })).toBe("board_id-immutable");
    });

    it("counts neither an immutable nor an unknown field as a patch", () => {
      expect(patch({ status: "active" })).toBe("status-immutable");
    });

    it("REJECTS an unknown key", () => {
      expect(patch({ name: "S", bogus: 1 })).toBe("bogus-unknown");
    });
  });

  // The one deliberate WIRE CHANGE in this migration. The handler used to
  // coerce rather than validate, so a typo'd carryOver silently meant
  // next_planning and a caller watched their issues carry over believing they
  // had dropped. Previously-silent failures becoming 400 is exactly what
  // BOUNDARY_DISCIPLINE.md licenses a migration to do.
  describe("CompleteSprintBody", () => {
    it("accepts an empty body and both carryOver values", () => {
      expect(Exit.isSuccess(decode(CompleteSprintBody, {}))).toBe(true);
      expect(Exit.isSuccess(decode(CompleteSprintBody, { carryOver: "drop" }))).toBe(true);
      expect(Exit.isSuccess(decode(CompleteSprintBody, { carryOver: "next_planning" }))).toBe(true);
    });

    it("REJECTS a carryOver outside the vocabulary — no longer coerced", () => {
      expect(complete({ carryOver: "bogus" })).toBe("carryOver");
      expect(complete({ carryOver: 123 })).toBe("carryOver");
      expect(complete({ carryOver: null })).toBe("carryOver");
    });

    it("REJECTS a non-string nextSprintId — no longer silently ignored", () => {
      expect(complete({ nextSprintId: 42 })).toBe("nextSprintId");
      expect(complete({ nextSprintId: {} })).toBe("nextSprintId");
    });

    // Null stays legal. It is not a typo — it is how a client spells "no
    // specific next sprint, pick one", which is what the handler already does
    // with it. carryOver gets no such allowance: null is not a natural
    // spelling of a member of a two-value enum.
    it("still accepts a null nextSprintId as auto-pick", () => {
      expect(Exit.isSuccess(decode(CompleteSprintBody, { nextSprintId: null }))).toBe(true);
    });

    it("REJECTS an unknown key", () => {
      expect(complete({ bogus: 1 })).toBe("bogus-unknown");
    });
  });

  // The schema tests above run without a Context; these pin that the wire
  // actually answers what the schema decided, end to end.
  describe("on the wire", () => {
    it("POST answers 400 name for a whitespace-only name", async () => {
      const h = makeHarness();
      await createBoard(h);
      const res = await h.app.request(url("sprint.list", { slug: "kb" }), jsonReq("POST", { name: " " }), {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-body", reason: "name" });
    });

    it("POST rejects an unknown key rather than dropping it", async () => {
      const h = makeHarness();
      await createBoard(h);
      const res = await h.app.request(
        url("sprint.list", { slug: "kb" }),
        jsonReq("POST", { name: "S", planed_days: 7 }),
        {},
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-body", reason: "planed_days-unknown" });
    });

    it("PATCH still answers 409 for planned_days on a started sprint, even when invalid", async () => {
      // The ordering this migration had to preserve. A schema-typed
      // planned_days would answer 400 here instead — a status-code change,
      // which needs its own ticket rather than riding along on a migration.
      const h = makeHarness();
      await createBoard(h);
      const sprint = await createSprint(h);
      await h.app.request(url("sprint.start", { slug: "kb", id: sprint.id }), jsonReq("POST", {}), {});
      const res = await h.app.request(
        url("sprint.update", { slug: "kb", id: sprint.id }),
        jsonReq("PATCH", { planned_days: 999 }),
        {},
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "conflict", reason: "sprint-active" });
    });

    it("PATCH still answers 400 planned_days on a PLANNING sprint", async () => {
      const h = makeHarness();
      await createBoard(h);
      const sprint = await createSprint(h);
      const res = await h.app.request(
        url("sprint.update", { slug: "kb", id: sprint.id }),
        jsonReq("PATCH", { planned_days: 999 }),
        {},
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-body", reason: "planned_days" });
    });

    it("complete still accepts NO body at all", async () => {
      // The optional-body catch survives the migration: parseRouteBody raises
      // the same `expected-json` reason the raw reader did, and only that one
      // reason is swallowed.
      const h = makeHarness();
      await createBoard(h);
      const sprint = await createSprint(h);
      await h.app.request(url("sprint.start", { slug: "kb", id: sprint.id }), jsonReq("POST", {}), {});
      const res = await h.app.request(
        url("sprint.complete", { slug: "kb", id: sprint.id }),
        { method: "POST", headers: { ...bearer } },
        {},
      );
      expect(res.status).toBe(200);
    });

    it("complete 400s a typo'd carryOver instead of silently carrying over", async () => {
      const h = makeHarness();
      await createBoard(h);
      const sprint = await createSprint(h);
      const issue = await createIssue(h);
      await addIssue(h, sprint.id, issue.id);
      await h.app.request(url("sprint.start", { slug: "kb", id: sprint.id }), jsonReq("POST", {}), {});

      const res = await h.app.request(
        url("sprint.complete", { slug: "kb", id: sprint.id }),
        jsonReq("POST", { carryOver: "dropp" }),
        {},
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-body", reason: "carryOver" });
      // and the sprint is untouched — the 400 happened at the boundary.
      expect(h.db.sprints.find((s) => s["id"] === sprint.id)!["status"]).toBe("active");
    });
  });
});

// ── EFB-91: sprint-driven moves publish their 30553 ────────────────────────
//
// Both sprint callsites wrote a statusChangeCache row with an id minted inline
// and thrown away — the pre-EFB-33 shape. A 30553 KanbanStatusChange keys on
// that row (the row id IS the event's `d` tag), so an id that never leaves the
// INSERT leaves the publish path with nothing to sign against. The rows were
// there, the substrate audit trail was not.
//
// EFB-33 closed this for UI-driven transitions and EFB-66 for github-driven
// ones. Sprint-driven was the third and last family with the gap.
//
// The ticket also named "sprint complete" as a second callsite. It is not one:
// completing a sprint rewrites `sprint_id` and emits `issue.updated`, which is
// not in templatesFor's 30553 gate and writes no statusChangeCache row. The
// real second callsite is the mid-sprint add-issue promote. The last test here
// pins that reading so a future reader does not go looking for a missing fix.
describe("EFB-91 — 30553 on sprint-driven container moves", () => {
  // This file runs on FAKE timers (see the top-level beforeEach), so the
  // `setTimeout(0)` spelling other publish tests use would never resolve. A
  // microtask flush is all that is needed anyway: emitSecureBoardEvent AWAITS
  // publishPlaintextEvent inline rather than forking it, so the publish has
  // already happened by the time the request promise settles.
  const settle = () => Promise.resolve();

  const plaintextEvents = (h: Harness) =>
    h.audience.calls
      .filter((c) => c.path === KANBAN_PLAINTEXT_PATH)
      .map(
        (p) =>
          (p.body as { event: { id: string; kind: number; tags: string[][]; content: string } })
            .event,
      );

  const contentOf = (ev: { content: string }) => JSON.parse(ev.content) as Record<string, unknown>;

  const changeFor = (h: Harness, rowId: unknown) =>
    plaintextEvents(h).find(
      (e) => e.kind === 30553 && e.tags.find((t) => t[0] === "d")?.[1] === rowId,
    );

  /** statusChangeCache rows written by a backlog → active promote. */
  const promoteRows = (h: Harness) =>
    h.db.statusChanges.filter(
      (r) => r["from_container"] === "backlog" && r["to_container"] === "active",
    );

  it("start with 3 backlog issues publishes 3 30553s and stamps every row", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const sprint = await createSprint(h);
    for (const title of ["A", "B", "C"]) {
      const issue = await createIssue(h, { title });
      await addIssue(h, sprint.id, issue.id);
    }
    await settle();

    await h.app.request(url("sprint.start", { slug: "kb", id: sprint.id }), jsonReq("POST", {}), {});
    await settle();

    const rows = promoteRows(h);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const change = changeFor(h, row["id"]);
      expect(change).toBeDefined();
      // The stamp is the round trip: the publish path wrote the substrate
      // event id back onto the row it signed.
      expect(row["substrate_event_id"]).toBe(change!.id);
      expect(contentOf(change!)).toMatchObject({
        from_container: "backlog",
        to_container: "active",
      });
    }
  });

  // Attribution, not just presence. `null` at the callsite would publish these
  // as `audit.system` — a signed claim that nobody started the sprint.
  it("attributes the start's 30553s to the caller, not the system", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const sprint = await createSprint(h);
    const issue = await createIssue(h, { title: "A" });
    await addIssue(h, sprint.id, issue.id);
    await settle();

    await h.app.request(url("sprint.start", { slug: "kb", id: sprint.id }), jsonReq("POST", {}), {});
    await settle();

    const row = promoteRows(h)[0]!;
    expect(contentOf(changeFor(h, row["id"])!).actor_pubkey).toBe(CALLER);
  });

  it("mid-sprint add-issue promote publishes its 30553 too", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const sprint = await createSprint(h);
    await h.app.request(url("sprint.start", { slug: "kb", id: sprint.id }), jsonReq("POST", {}), {});
    const issue = await createIssue(h, { title: "late arrival" });
    await settle();

    await addIssue(h, sprint.id, issue.id);
    await settle();

    const row = promoteRows(h).find((r) => r["issue_id"] === issue.id)!;
    expect(row).toBeDefined();
    const change = changeFor(h, row["id"]);
    expect(change).toBeDefined();
    expect(row["substrate_event_id"]).toBe(change!.id);
    expect(contentOf(change!).actor_pubkey).toBe(CALLER);
  });

  // The negative half. An add-issue that does NOT promote (planning sprint,
  // or an issue already active) writes no status-change row, so there is
  // nothing to publish — absence here is correct, not a second gap.
  it("publishes no 30553 when the add does not promote", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const sprint = await createSprint(h); // planning, so no promote
    const issue = await createIssue(h, { title: "planned" });
    await settle();
    const before = plaintextEvents(h).filter((e) => e.kind === 30553).length;

    await addIssue(h, sprint.id, issue.id);
    await settle();

    expect(plaintextEvents(h).filter((e) => e.kind === 30553).length).toBe(before);
    expect(promoteRows(h)).toHaveLength(0);
  });

  // Pins the ticket's misreading so nobody re-opens it. Completing a sprint
  // is a membership change, not a status change: no statusChangeCache row is
  // written, and `issue.updated` is not in the 30553 gate.
  it("sprint complete writes no status-change row and publishes no 30553", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const sprint = await createSprint(h);
    const issue = await createIssue(h, { title: "unfinished" });
    await addIssue(h, sprint.id, issue.id);
    await h.app.request(url("sprint.start", { slug: "kb", id: sprint.id }), jsonReq("POST", {}), {});
    await settle();
    const rowsBefore = h.db.statusChanges.length;
    const changesBefore = plaintextEvents(h).filter((e) => e.kind === 30553).length;

    await h.app.request(
      url("sprint.complete", { slug: "kb", id: sprint.id }),
      jsonReq("POST", { carryOver: "drop" }),
      {},
    );
    await settle();

    expect(h.db.statusChanges.length).toBe(rowsBefore);
    expect(plaintextEvents(h).filter((e) => e.kind === 30553).length).toBe(changesBefore);
  });
});
