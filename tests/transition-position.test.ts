// EFB-78 — an issue arriving in a column or container lands at the TOP.
//
// Before this, a transition wrote the column identity and left `position`
// alone, so an issue arrived carrying whatever order value it held in the
// column it left. The dogfood case: EFB-74 moved to Done at position 64000 and
// landed below several older Done tickets, so the just-shipped ticket was the
// one you had to scroll to find. A Done column is only useful as a "what just
// shipped" feed if the newest arrival is first.
//
// Display order is `position ASC`, NULLs last, so "top" means strictly less
// than every other position in the destination. That is what these assert —
// against the OTHER rows actually present, not against a hardcoded number, so
// the tests stay honest if POSITION_STEP or the seeding changes.

import { describe, expect, it } from "vitest";
import type { IssueShape } from "../src/shapes";
import { createBoard, createIssue, jsonReq, makeHarness, type Harness } from "./harness";

/** Every issue row currently in `columnId`, straight out of the mock db. */
const inColumn = (h: Harness, columnId: string) =>
  h.db.issues.filter((r) => r["column_id"] === columnId);

const inContainer = (h: Harness, container: string) =>
  h.db.issues.filter((r) => r["container"] === container);

const positionsOf = (rows: ReadonlyArray<Record<string, unknown>>, excludeId?: string) =>
  rows
    .filter((r) => r["id"] !== excludeId && typeof r["position"] === "number")
    .map((r) => r["position"] as number);

/** `createBoard` returns void; the columns live on the seeded row as JSON. */
const columnsOf = (h: Harness) =>
  JSON.parse(String(h.db.boards[0]!["columns"])) as Array<{
    id: string;
    name: string;
    category: string;
  }>;

describe("EFB-78 — transitions land at the top of the target column", () => {
  /**
   * A board whose Done column already holds several issues at ascending
   * positions, plus one issue still in Todo to move.
   */
  const setup = async (h: Harness) => {
    await createBoard(h);
    const done = columnsOf(h).find((c) => c.category === "done")!;
    // Three issues already sitting in Done. createIssue appends (max + STEP),
    // so these carry increasing positions, and the mover's own position will be
    // the largest of all — i.e. dead last — before the fix does anything.
    const settled: IssueShape[] = [];
    for (const title of ["Older 1", "Older 2", "Older 3"]) {
      const issue = await createIssue(h, { title });
      const row = h.db.issues.find((r) => r["id"] === issue.id)!;
      row["column_id"] = done.id;
      row["status"] = done.name;
      settled.push(issue);
    }
    const mover = await createIssue(h, { title: "Just finished" });
    return { done, settled, mover };
  };

  const transition = (h: Harness, issueId: string, columnId: string) =>
    h.app.request(`/api/v0/issues/${issueId}/transition`, jsonReq("POST", { column_id: columnId }), {});

  it("puts the arriving issue strictly above every other issue in the column", async () => {
    const h = makeHarness();
    const { done, mover } = await setup(h);

    // Precondition worth asserting: before the move the mover is BELOW every
    // Done issue. Without this the test could pass on a board where it already
    // happened to be on top, proving nothing.
    const beforeRow = h.db.issues.find((r) => r["id"] === mover.id)!;
    const othersBefore = positionsOf(inColumn(h, done.id));
    expect(othersBefore.length).toBeGreaterThan(0);
    expect(beforeRow["position"] as number).toBeGreaterThan(Math.max(...othersBefore));

    const res = await transition(h, mover.id, done.id);
    expect(res.status).toBe(200);
    const { issue: after } = (await res.json()) as { issue: IssueShape };

    const others = positionsOf(inColumn(h, done.id), mover.id);
    expect(others.length).toBe(3);
    expect(after.position).not.toBeNull();
    expect(after.position!).toBeLessThan(Math.min(...others));
  });

  it("reports the new position on the response, not just in the row", async () => {
    // The SPA renders from the response body; a row that moved while the
    // returned issue still carried the old position would put the card back
    // where it was until the next refetch.
    const h = makeHarness();
    const { done, mover } = await setup(h);
    const res = await transition(h, mover.id, done.id);
    const { issue: after } = (await res.json()) as { issue: IssueShape };
    const row = h.db.issues.find((r) => r["id"] === mover.id)!;
    expect(after.position).toBe(row["position"]);
  });

  it("leaves the other issues' relative order alone", async () => {
    // This is the whole reason for min-minus-a-step over a timestamp: a manual
    // reorder inside the column has to survive somebody else arriving on top.
    const h = makeHarness();
    const { done, settled, mover } = await setup(h);
    const before = settled.map((i) => h.db.issues.find((r) => r["id"] === i.id)!["position"]);

    await transition(h, mover.id, done.id);

    const after = settled.map((i) => h.db.issues.find((r) => r["id"] === i.id)!["position"]);
    expect(after).toEqual(before);
  });

  it("stacks: two arrivals in a row put the most recent on top", async () => {
    const h = makeHarness();
    const { done, mover } = await setup(h);
    const second = await createIssue(h, { title: "Finished after" });

    await transition(h, mover.id, done.id);
    await transition(h, second.id, done.id);

    const first = h.db.issues.find((r) => r["id"] === mover.id)!["position"] as number;
    const latest = h.db.issues.find((r) => r["id"] === second.id)!["position"] as number;
    expect(latest).toBeLessThan(first);
  });

  it("handles an empty destination column without producing a null position", async () => {
    const h = makeHarness();
    await createBoard(h);
    const empty = columnsOf(h).find((c) => c.category === "in_progress")!;
    const issue = await createIssue(h, { title: "First one in" });

    const res = await transition(h, issue.id, empty.id);
    expect(res.status).toBe(200);
    const { issue: after } = (await res.json()) as { issue: IssueShape };
    expect(after.position).not.toBeNull();
    expect(typeof after.position).toBe("number");
  });
});

describe("EFB-78 — container moves land at the top too", () => {
  it("puts an issue promoted to a container above the issues already there", async () => {
    const h = makeHarness();
    await createBoard(h);
    // createIssue defaults to the BACKLOG container, so the destination has to
    // be a different one or the move is an idempotent no-op and proves nothing.
    for (const title of ["Active 1", "Active 2", "Active 3"]) {
      const issue = await createIssue(h, { title });
      h.db.issues.find((r) => r["id"] === issue.id)!["container"] = "active";
    }
    const mover = await createIssue(h, { title: "Pulled into active" });

    const res = await h.app.request(
      `/api/v0/issues/${mover.id}/promote_to_active`,
      jsonReq("POST"),
      {},
    );
    expect(res.status).toBe(200);

    const others = positionsOf(inContainer(h, "active"), mover.id);
    expect(others.length).toBe(3);
    const moved = h.db.issues.find((r) => r["id"] === mover.id)!["position"] as number;
    expect(moved).toBeLessThan(Math.min(...others));
  });
});
