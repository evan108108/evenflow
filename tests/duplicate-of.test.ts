// EFB-30 — POST /issues/:id/duplicate-of, and what marking a duplicate does
// to the rest of the system.
//
// The endpoint itself is small; almost everything worth testing here is a
// consequence of it. Marking a duplicate transitions a column, appends an
// audit row, changes which board event fires, removes the issue from every
// day of a tide replay, and adds a tag to the substrate event. Each of those
// is a separate way the feature can be half-implemented and still look like
// it works from the API response.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueShape } from "../src/shapes";
import {
  CALLER,
  bearer,
  createBoard,
  createIssue,
  jsonReq,
  makeHarness,
  type Harness,
} from "./harness";
import { DAY_MS, type TideDay } from "../src/lib/tide/compute";

const DAY0 = Date.UTC(2026, 6, 20);
const at = (dayOffset: number, hour = 12) => DAY0 + dayOffset * DAY_MS + hour * 3_600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(0, 1));
});
afterEach(() => {
  vi.useRealTimers();
});

/** Fire the endpoint and hand back the raw response, for status assertions. */
const markRaw = (h: Harness, issueId: string, target: string | null) =>
  h.app.request(
    `/api/v0/issues/${issueId}/duplicate-of`,
    jsonReq("POST", { duplicate_of_issue_id: target }),
    {},
  );

/** Fire it expecting success, and hand back the updated issue. */
const mark = async (h: Harness, issueId: string, target: string | null): Promise<IssueShape> => {
  const res = await markRaw(h, issueId, target);
  expect(res.status).toBe(200);
  return ((await res.json()) as { issue: IssueShape }).issue;
};

const reasonOf = async (res: Response): Promise<string> =>
  ((await res.json()) as { reason: string }).reason;

describe("POST /api/v0/issues/:id/duplicate-of", () => {
  it("sets the pointer and moves the duplicate to Done", async () => {
    const h = makeHarness();
    await createBoard(h);
    const original = await createIssue(h, { title: "Original" });
    const dupe = await createIssue(h, { title: "Filed twice" });
    expect(dupe.status).toBe("Todo");

    const marked = await mark(h, dupe.id, original.id);

    expect(marked.duplicate_of_issue_id).toBe(original.id);
    expect(marked.status).toBe("Done");
    // The Done transition is a real one: completed_at_ms is stamped and the
    // move is in the audit trail, exactly as if somebody had dragged it.
    expect(marked.completed_at_ms).toBe(at(0, 1));
    expect(
      h.db.statusChanges.filter((s) => s["issue_id"] === dupe.id && s["to_status"] === "Done"),
    ).toHaveLength(1);
    // The ORIGINAL is untouched — a duplicate mark is one-directional.
    const originalRow = h.db.issues.find((i) => i["id"] === original.id);
    expect(originalRow?.["duplicate_of_issue_id"] ?? null).toBe(null);
    expect(originalRow?.["status"]).toBe("Todo");
  });

  it("accepts the target by short id as well as uuid", async () => {
    const h = makeHarness();
    await createBoard(h);
    const original = await createIssue(h, { title: "Original" });
    const dupe = await createIssue(h, { title: "Filed twice" });
    expect(original.short_id).not.toBeNull();

    const marked = await mark(h, dupe.id, original.short_id!);
    // Resolved to the id, not stored as the short id — the pointer is an id
    // column, and short ids get re-minted on a cross-board move.
    expect(marked.duplicate_of_issue_id).toBe(original.id);
  });

  it("clears the pointer without moving the issue back out of Done", async () => {
    const h = makeHarness();
    await createBoard(h);
    const original = await createIssue(h, { title: "Original" });
    const dupe = await createIssue(h, { title: "Filed twice" });
    await mark(h, dupe.id, original.id);

    const cleared = await mark(h, dupe.id, null);

    expect(cleared.duplicate_of_issue_id).toBe(null);
    // THE INVARIANT: state reverts, the audit trail does not. The move to
    // Done happened; un-marking must not write a second status change
    // undoing it, and must not move the card.
    expect(cleared.status).toBe("Done");
    expect(
      h.db.statusChanges.filter((s) => s["issue_id"] === dupe.id && s["to_status"] !== null),
    ).toHaveLength(2); // creation → Todo, then Todo → Done. Nothing else.
  });

  it("is a no-op when clearing an issue that was never a duplicate", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h, { title: "Ordinary" });

    const after = await mark(h, issue.id, null);

    expect(after.duplicate_of_issue_id).toBe(null);
    expect(after.updated_at_ms).toBe(issue.updated_at_ms);
    expect(h.audit.events.some((r) => r.event_type === "issue_duplicate_cleared")).toBe(false);
  });

  it("marking a duplicate that is ALREADY in Done still sets the pointer", async () => {
    const h = makeHarness();
    await createBoard(h);
    const original = await createIssue(h, { title: "Original" });
    const dupe = await createIssue(h, { title: "Filed twice", status: "Done" });

    const marked = await mark(h, dupe.id, original.id);

    expect(marked.duplicate_of_issue_id).toBe(original.id);
    expect(marked.status).toBe("Done");
    // No column moved, so no second status-change row is appended.
    expect(
      h.db.statusChanges.filter((s) => s["issue_id"] === dupe.id && s["to_status"] === "Done"),
    ).toHaveLength(1);
  });

  describe("cycle prevention", () => {
    it("rejects pointing an issue at itself", async () => {
      const h = makeHarness();
      await createBoard(h);
      const issue = await createIssue(h, { title: "Ouroboros" });

      const res = await markRaw(h, issue.id, issue.id);

      expect(res.status).toBe(400);
      expect(await reasonOf(res)).toBe("circular_duplicate");
    });

    it("rejects a two-hop cycle (A→B when B→A already)", async () => {
      const h = makeHarness();
      await createBoard(h);
      const a = await createIssue(h, { title: "A" });
      const b = await createIssue(h, { title: "B" });
      await mark(h, b.id, a.id);

      const res = await markRaw(h, a.id, b.id);

      expect(res.status).toBe(400);
      expect(await reasonOf(res)).toBe("circular_duplicate");
      // Rejected means UNCHANGED — a failed mark must not have transitioned
      // A to Done on its way to discovering the cycle.
      const rowA = h.db.issues.find((i) => i["id"] === a.id);
      expect(rowA?.["duplicate_of_issue_id"] ?? null).toBe(null);
      expect(rowA?.["status"]).toBe("Todo");
    });

    it("rejects a longer cycle (A→B→C when C→A already)", async () => {
      const h = makeHarness();
      await createBoard(h);
      const a = await createIssue(h, { title: "A" });
      const b = await createIssue(h, { title: "B" });
      const c = await createIssue(h, { title: "C" });
      await mark(h, b.id, c.id); // B → C
      await mark(h, c.id, a.id); // C → A

      const res = await markRaw(h, a.id, b.id); // would close A→B→C→A

      expect(res.status).toBe(400);
      expect(await reasonOf(res)).toBe("circular_duplicate");
    });

    it("allows a chain that does not close (A→B, B→C)", async () => {
      const h = makeHarness();
      await createBoard(h);
      const a = await createIssue(h, { title: "A" });
      const b = await createIssue(h, { title: "B" });
      const c = await createIssue(h, { title: "C" });

      await mark(h, b.id, c.id);
      const markedA = await mark(h, a.id, b.id);

      expect(markedA.duplicate_of_issue_id).toBe(b.id);
    });
  });

  describe("target validation", () => {
    it("400s an unresolvable target rather than silently storing it", async () => {
      const h = makeHarness();
      await createBoard(h);
      const dupe = await createIssue(h, { title: "Filed twice" });

      const res = await markRaw(h, dupe.id, "no-such-issue");

      expect(res.status).toBe(400);
      expect(await reasonOf(res)).toBe("duplicate-target-not-found");
    });

    it("400s a target on a different board", async () => {
      const h = makeHarness();
      await createBoard(h);
      await createBoard(h, "other");
      const elsewhere = await createIssue(h, { title: "Elsewhere" }, "other");
      const dupe = await createIssue(h, { title: "Filed twice" });

      const res = await markRaw(h, dupe.id, elsewhere.id);

      expect(res.status).toBe(400);
      expect(await reasonOf(res)).toBe("duplicate-target-other-board");
    });

    it("400s a non-string, non-null body value", async () => {
      const h = makeHarness();
      await createBoard(h);
      const dupe = await createIssue(h, { title: "Filed twice" });

      const res = await h.app.request(
        `/api/v0/issues/${dupe.id}/duplicate-of`,
        jsonReq("POST", { duplicate_of_issue_id: 7 }),
        {},
      );

      expect(res.status).toBe(400);
      expect(await reasonOf(res)).toBe("duplicate_of_issue_id");
    });

    it("401s an anonymous caller", async () => {
      const h = makeHarness();
      await createBoard(h);
      const original = await createIssue(h, { title: "Original" });
      const dupe = await createIssue(h, { title: "Filed twice" });

      const res = await h.app.request(
        `/api/v0/issues/${dupe.id}/duplicate-of`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ duplicate_of_issue_id: original.id }),
        },
        {},
      );

      expect(res.status).toBe(401);
    });
  });

  it("records the mark in the audit log", async () => {
    const h = makeHarness();
    await createBoard(h);
    const original = await createIssue(h, { title: "Original" });
    const dupe = await createIssue(h, { title: "Filed twice" });

    await mark(h, dupe.id, original.id);

    const row = h.audit.events.find((r) => r.event_type === "issue_marked_duplicate");
    expect(row).toBeDefined();
    expect(row?.details).toMatchObject({ issue: dupe.id, duplicate_of: original.id });
  });
});

// A cross-board move re-mints the short id in the target board's numbering.
// A pointer carried across would then be RENDERED in that new vocabulary
// while still referencing an issue on the old board — a link to a ticket
// that isn't the one named.
describe("move-to-board and the duplicate pointer", () => {
  it("clears the pointer when the issue changes board", async () => {
    const h = makeHarness();
    await createBoard(h);
    await createBoard(h, "other");
    const original = await createIssue(h, { title: "Original" });
    const dupe = await createIssue(h, { title: "Filed twice" });
    await mark(h, dupe.id, original.id);

    const target = h.db.boards.find((b) => b["slug"] === "other");
    const res = await h.app.request(
      `/api/v0/issues/${dupe.id}/move-to-board`,
      jsonReq("POST", { target_board_id: target?.["id"] }),
      {},
    );
    expect(res.status).toBe(200);
    const moved = ((await res.json()) as { issue: IssueShape }).issue;

    expect(moved.duplicate_of_issue_id).toBe(null);
    expect(h.db.issues.find((i) => i["id"] === dupe.id)?.["duplicate_of_issue_id"]).toBe(null);
  });
});

// The exclusion is RETROACTIVE by construction: the row never enters the
// replay, so it contributes nothing on any day — including days before it
// was marked. That is deliberate (a duplicate was never extra work), and it
// is exactly the property a filter applied at the wrong layer would lose.
describe("tide excludes duplicates", () => {
  const createSprint = async (h: Harness) => {
    const res = await h.app.request(
      "/api/v0/boards/kb/sprints",
      jsonReq("POST", { name: "Sprint 1" }),
      {},
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { sprint: { id: string } }).sprint;
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
  };
  const getTide = async (h: Harness, path: string) => {
    const res = await h.app.request(path, { headers: bearer }, {});
    expect(res.status).toBe(200);
    return (await res.json()) as { days: TideDay[] };
  };

  it("drops a duplicate out of sprint committed_pts on every day", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const keeper = await createIssue(h, { title: "Real work" });
    const dupe = await createIssue(h, { title: "Filed twice" });
    await addIssue(h, sprint.id, keeper.id);
    await addIssue(h, sprint.id, dupe.id);
    await patchIssue(h, keeper.id, { estimate: 5 });
    await patchIssue(h, dupe.id, { estimate: 3 });

    // Day 0: both count — 8 points committed.
    const before = await getTide(h, `/api/v0/boards/kb/sprints/${sprint.id}/tide?days=1`);
    expect(before.days.map((d) => d.committed_pts)).toEqual([8]);

    vi.setSystemTime(at(1));
    await mark(h, dupe.id, keeper.id);

    const after = await getTide(h, `/api/v0/boards/kb/sprints/${sprint.id}/tide?days=2`);
    // Day 0 is now 5, not 8: the duplicate's 3 points leave history too. It
    // also does NOT appear as 3 done_pts on day 1, which is the failure this
    // guards — a duplicate "delivering" points nobody worked for.
    expect(after.days.map((d) => d.committed_pts)).toEqual([5, 5]);
    expect(after.days.map((d) => d.done_pts)).toEqual([0, 0]);
  });

  it("brings it back when the pointer is cleared", async () => {
    const h = makeHarness();
    await createBoard(h);
    const sprint = await createSprint(h);
    const keeper = await createIssue(h, { title: "Real work" });
    const dupe = await createIssue(h, { title: "Filed twice" });
    await addIssue(h, sprint.id, keeper.id);
    await addIssue(h, sprint.id, dupe.id);
    await patchIssue(h, keeper.id, { estimate: 5 });
    await patchIssue(h, dupe.id, { estimate: 3 });
    await mark(h, dupe.id, keeper.id);
    await mark(h, dupe.id, null);

    const body = await getTide(h, `/api/v0/boards/kb/sprints/${sprint.id}/tide?days=1`);
    // Back in scope — and now genuinely done, because un-marking left the
    // Done transition standing.
    expect(body.days.map((d) => d.committed_pts)).toEqual([8]);
    expect(body.days.map((d) => d.done_pts)).toEqual([3]);
  });

  it("drops a duplicate out of the kanban board tide too", async () => {
    const h = makeHarness();
    await createBoard(h);
    const keeper = await createIssue(h, { title: "Real work", container: "active" });
    const dupe = await createIssue(h, { title: "Filed twice", container: "active" });
    await patchIssue(h, keeper.id, { estimate: 5 });
    await patchIssue(h, dupe.id, { estimate: 3 });

    const before = await getTide(h, "/api/v0/boards/kb/tide?days=1");
    expect(before.days.map((d) => d.committed_pts)).toEqual([8]);

    await mark(h, dupe.id, keeper.id);

    const after = await getTide(h, "/api/v0/boards/kb/tide?days=1");
    expect(after.days.map((d) => d.committed_pts)).toEqual([5]);
    expect(after.days.map((d) => d.done_pts)).toEqual([0]);
  });
});

describe("caller identity", () => {
  it("attributes the Done transition to the marker, not the assignee", async () => {
    const h = makeHarness();
    await createBoard(h);
    const original = await createIssue(h, { title: "Original" });
    const dupe = await createIssue(h, { title: "Filed twice" });

    await mark(h, dupe.id, original.id);

    const change = h.db.statusChanges.find(
      (s) => s["issue_id"] === dupe.id && s["to_status"] === "Done",
    );
    expect(change?.["actor_pubkey"]).toBe(CALLER);
  });
});
