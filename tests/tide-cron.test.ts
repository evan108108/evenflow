// EFB-22 Phase 5: the daily roll-forward cron.
//
// The read path already closes out a day when someone visits. This covers the
// case the cron exists for — nobody visited — plus the two properties that
// make a nightly job safe to leave running: it must be idempotent against the
// read path (no double rows, no double publishes), and one bad subject must
// not strand every other board.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { url } from "../src/routes-manifest";
import { Effect, Layer } from "effect";
import { rollForwardAllTides } from "../src/scheduled";
import { DAY_MS } from "../src/lib/tide/compute";
import {
  bearer,
  createBoard,
  createIssue,
  jsonReq,
  makeHarness,
  type Harness,
} from "./harness";
import type { SprintShape } from "../src/shapes";

const DAY0 = Date.UTC(2026, 6, 20);
const at = (dayOffset: number, hour = 12) => DAY0 + dayOffset * DAY_MS + hour * 3_600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(0, 1));
});
afterEach(() => {
  vi.useRealTimers();
});

const runCron = (h: Harness, nowMs: number) =>
  Effect.runPromise(
    Effect.provide(
      rollForwardAllTides(nowMs),
      // Same services the request path provides: the cron publishes through
      // exactly the emit path a read does, FourA included for public 30560.
      Layer.mergeAll(h.db.layer, h.audience.layer, h.emitter.layer, h.fourA.layer),
    ),
  );

const createSprint = async (h: Harness): Promise<SprintShape> => {
  const res = await h.app.request(
    url("sprint.list", { slug: "kb" }),
    jsonReq("POST", { name: "Sprint 1" }),
    {},
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { sprint: SprintShape }).sprint;
};

const startSprint = async (h: Harness, sprintId: string) => {
  const res = await h.app.request(
    url("sprint.start", { slug: "kb", id: sprintId }),
    jsonReq("POST", {}),
    {},
  );
  expect(res.status).toBe(200);
};

describe("rollForwardAllTides", () => {
  it("closes yesterday for an active sprint nobody visited", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const issue = await createIssue(h, { title: "A" });
    await h.app.request(
      url("sprint.issues.attach", { slug: "kb", id: sprint.id }),
      jsonReq("POST", { issue_id: issue.id }),
      {},
    );
    await h.app.request(url("issue.get", { id: issue.id }), jsonReq("PATCH", { estimate: 5 }), {});
    await startSprint(h, sprint.id);

    // No /tide read at all — the cron is the only thing that runs.
    const result = await runCron(h, at(1, 6));

    expect(result.failed).toBe(0);
    expect(result.closed).toBe(1);
    expect(h.db.tideSnapshots).toHaveLength(1);
    expect(h.db.tideSnapshots[0]).toMatchObject({
      sprint_id: sprint.id,
      day_start_ms: DAY0,
      committed_pts: 5,
      remaining_pts: 5,
    });
  });

  it("is idempotent — a second run, and a read that already closed the day, write nothing new", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    await startSprint(h, sprint.id);

    const first = await runCron(h, at(1, 6));
    expect(first.closed).toBe(1);
    expect(h.db.tideSnapshots).toHaveLength(1);

    const second = await runCron(h, at(1, 6));
    expect(second.closed).toBe(0);
    expect(h.db.tideSnapshots).toHaveLength(1);

    // And a visit later the same day must not duplicate the row either.
    vi.setSystemTime(at(1, 9));
    const read = await h.app.request(
      url("sprint.tide", { slug: "kb", id: sprint.id }),
      { headers: bearer },
      {},
    );
    expect(read.status).toBe(200);
    expect(h.db.tideSnapshots).toHaveLength(1);
  });

  it("rolls a board with no active sprint as kanban, on the same run", async () => {
    const h = makeHarness();
    await createBoard(h);
    await createIssue(h, { title: "Open" });

    const result = await runCron(h, at(1, 6));

    expect(result.closed).toBe(1);
    expect(h.db.tideSnapshots).toHaveLength(1);
    expect(h.db.tideSnapshots[0]!["sprint_id"]).toBeNull();
  });

  it("skips a sprint that did not exist yet on the day being closed", async () => {
    const h = makeHarness();
    await createBoard(h);
    // Board and sprint both born on day 1 — day 0 is not theirs to report.
    vi.setSystemTime(at(1, 2));
    const sprint = await createSprint(h);
    await startSprint(h, sprint.id);

    const result = await runCron(h, at(1, 6));
    expect(result.closed).toBe(0);
    expect(h.db.tideSnapshots).toHaveLength(0);
  });

  it("skips a sprint whose board is gone without stranding the healthy ones", async () => {
    const h = makeHarness();
    await createBoard(h);
    await createIssue(h, { title: "Open" });

    // A sprint row pointing at a board that isn't there. It should be passed
    // over quietly — not counted as closed, not raised as a failure — and the
    // healthy kanban board on the same run should still get its snapshot.
    h.db.sprints.push({
      id: "ghost-sprint",
      board_id: "board-that-vanished",
      name: "Ghost",
      goal: null,
      status: "active",
      planned_days: null,
      started_at_ms: at(0, 2),
      completed_at_ms: null,
      created_at_ms: at(0, 1),
    });

    const result = await runCron(h, at(1, 6));

    // The ghost contributes nothing; the real board still gets its snapshot.
    expect(result.failed).toBe(0);
    expect(result.closed).toBe(1);
    expect(h.db.tideSnapshots).toHaveLength(1);
    expect(h.db.tideSnapshots[0]!["sprint_id"]).toBeNull();
  });
});
