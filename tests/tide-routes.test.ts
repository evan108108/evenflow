// EFB-22: the two tide endpoints, end-to-end over the route stack.
//
// compute.ts is covered by fixtures in tide-compute.test.ts; this file is
// about the wiring — auth posture, the days parameter, the sprint/kanban
// split, and the lazy roll-forward that closes out yesterday on the first
// read of a new day.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { Db, DbError, type DbService } from "../src/effects";
import type { IssueShape, SprintShape } from "../src/shapes";
import {
  bearer,
  createBoard,
  createIssue,
  createPublicBoard,
  jsonReq,
  makeHarness,
  type Harness,
} from "./harness";
import { DAY_MS, type TideDay, type TideDirection } from "../src/lib/tide/compute";
import { rollForwardClosedDay } from "../src/lib/tide/snapshot";

// Anchor the fake clock to a UTC midnight so "today" and "yesterday" are
// unambiguous — a fixture near a boundary would be read-order dependent.
const DAY0 = Date.UTC(2026, 6, 20);
const at = (dayOffset: number, hour = 12) => DAY0 + dayOffset * DAY_MS + hour * 3_600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(0, 1));
});
afterEach(() => {
  vi.useRealTimers();
});

interface TideBody {
  days: TideDay[];
  today: TideDay | null;
  direction: TideDirection;
}

const createSprint = async (h: Harness): Promise<SprintShape> => {
  const res = await h.app.request(
    "/api/v0/boards/kb/sprints",
    jsonReq("POST", { name: "Sprint 1" }),
    {},
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { sprint: SprintShape }).sprint;
};

const addIssue = async (h: Harness, sprintId: string, issueId: string) => {
  const res = await h.app.request(
    `/api/v0/boards/kb/sprints/${sprintId}/add-issue`,
    jsonReq("POST", { issue_id: issueId }),
    {},
  );
  expect(res.status).toBe(200);
};

const patchIssue = async (h: Harness, issueId: string, body: Record<string, unknown>) => {
  const res = await h.app.request(`/api/v0/issues/${issueId}`, jsonReq("PATCH", body), {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { issue: IssueShape }).issue;
};

const getTide = async (h: Harness, path: string, expectStatus = 200) => {
  const res = await h.app.request(path, { headers: bearer }, {});
  expect(res.status).toBe(expectStatus);
  return (await res.json()) as TideBody;
};

describe("GET /api/v0/boards/:slug/sprints/:id/tide", () => {
  it("burns down as sprint issues reach Done", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const a = await createIssue(h, { title: "A" });
    const b = await createIssue(h, { title: "B" });
    await addIssue(h, sprint.id, a.id);
    await addIssue(h, sprint.id, b.id);
    await patchIssue(h, a.id, { estimate: 5 });
    await patchIssue(h, b.id, { estimate: 3 });

    vi.setSystemTime(at(1));
    await patchIssue(h, a.id, { status: "Done" });

    vi.setSystemTime(at(2));
    const body = await getTide(h, "/api/v0/boards/kb/sprints/" + sprint.id + "/tide?days=3");

    expect(body.days).toHaveLength(3);
    expect(body.days.map((d) => d.remaining_pts)).toEqual([8, 3, 3]);
    expect(body.days.map((d) => d.done_pts)).toEqual([0, 5, 5]);
    expect(body.today).toEqual(body.days[2]);
    expect(body.direction).toBe("out");
  });

  it("does not let a re-estimate rewrite yesterday", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const a = await createIssue(h, { title: "A" });
    await addIssue(h, sprint.id, a.id);
    await patchIssue(h, a.id, { estimate: 3 });

    vi.setSystemTime(at(1));
    await patchIssue(h, a.id, { estimate: 8 });
    expect(h.db.estimateHistory).toHaveLength(2); // null→3, then 3→8

    const body = await getTide(h, `/api/v0/boards/kb/sprints/${sprint.id}/tide?days=2`);
    expect(body.days.map((d) => d.remaining_pts)).toEqual([3, 8]);
  });

  it("reports zeroes for a brand-new sprint instead of failing", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const body = await getTide(h, `/api/v0/boards/kb/sprints/${sprint.id}/tide`);

    expect(body.days).toHaveLength(7);
    expect(body.direction).toBe("flat");
    expect(body.today).toMatchObject({ committed_pts: 0, done_pts: 0, remaining_pts: 0 });
  });

  it("validates days and 404s an unknown sprint", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    for (const bad of ["0", "91", "abc", "2.5"]) {
      const res = await h.app.request(
        `/api/v0/boards/kb/sprints/${sprint.id}/tide?days=${bad}`,
        { headers: bearer },
        {},
      );
      expect(res.status, `days=${bad}`).toBe(400);
    }
    const missing = await h.app.request(
      "/api/v0/boards/kb/sprints/nope/tide",
      { headers: bearer },
      {},
    );
    expect(missing.status).toBe(404);
  });

  it("reads at viewer: anonymous works on a public board, 404s on a private one", async () => {
    const h = makeHarness();
    await createBoard(h); // boards are created private by default
    const sprint = await createSprint(h);
    const path = `/api/v0/boards/kb/sprints/${sprint.id}/tide`;

    const hidden = await h.app.request(path, {}, {});
    expect(hidden.status).toBe(404);

    const opened = await h.app.request(
      "/api/v0/boards/kb",
      jsonReq("PATCH", { visibility: "public" }),
      {},
    );
    expect(opened.status).toBe(200);
    const visible = await h.app.request(path, {}, {});
    expect(visible.status).toBe(200);
  });
});

describe("GET /api/v0/boards/:slug/tide — kanban-only", () => {
  it("counts open issues and ages Done ones out of the window", async () => {
    const h = makeHarness();
    await createBoard(h);
    const narrowed = await h.app.request(
      "/api/v0/boards/kb",
      jsonReq("PATCH", { done_window_days: 2 }),
      {},
    );
    expect(narrowed.status).toBe(200);
    const a = await createIssue(h, { title: "A" });
    const b = await createIssue(h, { title: "B" });
    await patchIssue(h, a.id, { estimate: 5 });
    await patchIssue(h, b.id, { estimate: 3 });
    await patchIssue(h, a.id, { status: "Done" });

    vi.setSystemTime(at(3));
    const body = await getTide(h, "/api/v0/boards/kb/tide?days=4");

    // A was Done on day 0 with a 2-day window: counted days 0-1, gone after.
    expect(body.days.map((d) => d.committed_pts)).toEqual([8, 8, 3, 3]);
    expect(body.days.map((d) => d.done_pts)).toEqual([5, 5, 0, 0]);
    expect(body.days[2]?.drops_today).toBe(5);
  });
});

describe("tide roll-forward", () => {
  it("closes out yesterday on the first read of a new day, once", async () => {
    const h = makeHarness();
    // Explicitly public — the substrate_event_id assertion below only holds
    // for a board that may publish, and createBoard makes a PRIVATE one.
    await createPublicBoard(h);
    const sprint = await createSprint(h);
    const a = await createIssue(h, { title: "A" });
    await addIssue(h, sprint.id, a.id);
    await patchIssue(h, a.id, { estimate: 5 });

    // Same day as the writes: nothing has finished yet, so nothing is closed.
    await getTide(h, `/api/v0/boards/kb/sprints/${sprint.id}/tide`);
    expect(h.db.tideSnapshots).toHaveLength(0);

    vi.setSystemTime(at(1));
    await getTide(h, `/api/v0/boards/kb/sprints/${sprint.id}/tide`);
    expect(h.db.tideSnapshots).toHaveLength(1);
    expect(h.db.tideSnapshots[0]).toMatchObject({
      sprint_id: sprint.id,
      board_id: expect.any(String),
      day_start_ms: DAY0,
      committed_pts: 5,
      remaining_pts: 5,
      // Public board: the 30560 is signed and posted, so the row is stamped
      // with that event's id. tide-publish.test.ts covers the publish itself.
      substrate_event_id: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    // A second read the same day must not write a duplicate.
    await getTide(h, `/api/v0/boards/kb/sprints/${sprint.id}/tide`);
    expect(h.db.tideSnapshots).toHaveLength(1);
  });

  // Deterministic version of the race below: the existence check finds
  // nothing, then the INSERT loses to a writer that got there first. Driven
  // by a stub Db because real concurrency here is scheduler-dependent and
  // would make the assertion vacuous on a fast run.
  it("degrades to 'nothing to do' when the insert loses the unique index", async () => {
    const reading = {
      day: "2026-07-20",
      day_start_ms: DAY0,
      committed_pts: 5,
      done_pts: 0,
      remaining_pts: 5,
      adds_today: 5,
      drops_today: 0,
    };
    let inserts = 0;
    const raced = Layer.succeed(Db, {
      // No row exists as far as the check can see …
      queryFirst: () => Effect.succeed(null),
      queryAll: () => Effect.succeed([]),
      // … but the write loses to whoever got there first.
      execute: () => {
        inserts += 1;
        return Effect.fail(
          new DbError({
            reason: "query-failed",
            cause: new Error("UNIQUE constraint failed: sprintTideSnapshot.sprint_id"),
          }),
        );
      },
    } as unknown as DbService);

    const result = await Effect.runPromise(
      Effect.provide(
        rollForwardClosedDay({ board_id: "b1", sprint_id: "s1" }, [reading], at(1, 6), DAY0),
        raced,
      ),
    );

    expect(inserts).toBe(1); // it really did attempt the write
    expect(result).toBeNull(); // and reported nothing to do rather than throwing
  });

  it("serves both of two near-simultaneous reads without duplicating the row", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const a = await createIssue(h, { title: "A" });
    await addIssue(h, sprint.id, a.id);

    vi.setSystemTime(at(1));
    // Both requests see no row, both try to insert. The partial unique index
    // rejects the loser — which must not become a 500 on a GET.
    const path = `/api/v0/boards/kb/sprints/${sprint.id}/tide`;
    const [first, second] = await Promise.all([
      h.app.request(path, { headers: bearer }, {}),
      h.app.request(path, { headers: bearer }, {}),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(h.db.tideSnapshots).toHaveLength(1);
    // Both callers still get the same, correct reading.
    const bodies = (await Promise.all([first.json(), second.json()])) as TideBody[];
    expect(bodies[0]?.today).toEqual(bodies[1]?.today);
  });

  it("keeps sprint and kanban snapshots on separate rows for the same day", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    vi.setSystemTime(at(1));
    await getTide(h, `/api/v0/boards/kb/sprints/${sprint.id}/tide`);
    await getTide(h, "/api/v0/boards/kb/tide");

    expect(h.db.tideSnapshots).toHaveLength(2);
    expect(new Set(h.db.tideSnapshots.map((s) => s["sprint_id"]))).toEqual(
      new Set([null, sprint.id]),
    );
  });
});
