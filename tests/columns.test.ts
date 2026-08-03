// Phase 17: structured board columns + issue types.
//
// Unit half: the shared vocabulary in src/columns.ts (category inference,
// string[] coercion, the Column[] validation matrix). Route half: the
// behavior the shapes power — create/patch with types, transition by
// column_id, rename keeping issues in place, delete-with-issues (move and
// hide paths), and category-driven completed_at_ms.

import { describe, expect, it } from "vitest";
import { url } from "../src/routes-manifest";
import {
  MAX_COLUMNS,
  coerceStringColumns,
  columnArrayProblem,
  defaultColumns,
  inferCategory,
  type Column,
} from "../src/columns";
import type { BoardShape, IssueShape } from "../src/shapes";
import { createIssue, jsonReq, makeHarness, type Harness } from "./harness";

let mintCounter = 0;
const mint = () => `id-${mintCounter++}`;

const col = (over: Partial<Column> & { id: string; name: string; order: number }): Column => ({
  enabled: true,
  category: "todo",
  ...over,
});

// ── inferCategory ─────────────────────────────────────────────────────────

describe("inferCategory", () => {
  it("maps the documented substrings, case-insensitively", () => {
    const cases: Array<[string, string]> = [
      ["Todo", "todo"],
      ["Backlog", "todo"],
      ["In Progress", "in_progress"],
      ["doing", "in_progress"],
      ["WIP", "in_progress"],
      ["In Review", "in_review"],
      ["PR Zone", "in_review"],
      ["QA", "in_review"],
      ["Done", "done"],
      ["Shipped", "done"],
      ["Completed", "done"],
      ["closed", "done"],
      ["Finished", "done"],
      ["Blocked", "blocked"],
      ["Stuck", "blocked"],
      ["waiting on evan", "blocked"],
      ["Cluster", "todo"], // fallback
    ];
    for (const [name, category] of cases) {
      expect(inferCategory(name), name).toBe(category);
    }
  });
});

// ── coercion + defaults ───────────────────────────────────────────────────

describe("coerceStringColumns / defaultColumns", () => {
  it("coerces a legacy name array with position order and inferred categories", () => {
    const columns = coerceStringColumns(["Backlog", "Doing", "Shipped"], mint);
    expect(columns).toMatchObject([
      { name: "Backlog", order: 0, enabled: true, category: "todo" },
      { name: "Doing", order: 1, enabled: true, category: "in_progress" },
      { name: "Shipped", order: 2, enabled: true, category: "done" },
    ]);
    expect(new Set(columns.map((c) => c.id)).size).toBe(3);
  });

  it("defaults to the stock four with the right categories", () => {
    expect(defaultColumns(mint).map((c) => [c.name, c.category])).toEqual([
      ["Todo", "todo"],
      ["In Progress", "in_progress"],
      ["In Review", "in_review"],
      ["Done", "done"],
    ]);
  });
});

// ── validation matrix ─────────────────────────────────────────────────────

describe("columnArrayProblem", () => {
  const valid = [
    col({ id: "a", name: "Todo", order: 0 }),
    col({ id: "b", name: "Done", order: 1, category: "done" }),
  ];

  it("accepts a well-formed set", () => {
    expect(columnArrayProblem(valid)).toBeNull();
  });

  it("rejects every documented malformation", () => {
    expect(columnArrayProblem("nope")).toBe("shape");
    expect(columnArrayProblem([])).toBe("shape");
    expect(
      columnArrayProblem(
        Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => col({ id: `c${i}`, name: `C${i}`, order: i })),
      ),
    ).toBe("too-many");
    expect(columnArrayProblem([{ ...valid[0], id: "" }, valid[1]])).toBe("id");
    expect(columnArrayProblem([{ ...valid[0], name: "  " }, valid[1]])).toBe("name");
    expect(columnArrayProblem([{ ...valid[0], name: "x".repeat(31) }, valid[1]])).toBe("name");
    expect(columnArrayProblem([{ ...valid[0], order: 0.5 }, valid[1]])).toBe("order");
    expect(columnArrayProblem([{ ...valid[0], enabled: "yes" }, valid[1]])).toBe("enabled");
    expect(columnArrayProblem([{ ...valid[0], category: "doing" }, valid[1]])).toBe("category");
    expect(
      columnArrayProblem(valid.map((c) => ({ ...c, enabled: false }))),
    ).toBe("none-enabled");
    expect(
      columnArrayProblem([valid[0], { ...valid[1], id: "a" }]),
    ).toBe("id-duplicate");
    expect(
      columnArrayProblem([valid[0], { ...valid[1], name: "TODO" }]),
    ).toBe("name-duplicate");
    expect(
      columnArrayProblem([valid[0], { ...valid[1], order: 2 }]),
    ).toBe("order-not-contiguous");
  });

  it("allows a disabled column to shadow an enabled column's name", () => {
    expect(
      columnArrayProblem([
        valid[0],
        valid[1],
        col({ id: "c", name: "todo", order: 2, enabled: false }),
      ]),
    ).toBeNull();
  });
});

// ── route behavior ────────────────────────────────────────────────────────

const createBoardWith = async (h: Harness, columns?: unknown, slug = "kb") => {
  const res = await h.app.request(
    url("board.create"),
    jsonReq("POST", { slug, title: "Board", ...(columns === undefined ? {} : { columns }) }),
    {},
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { board: BoardShape }).board;
};

const patchBoard = (h: Harness, body: unknown, slug = "kb") =>
  h.app.request(url("board.get", { slug: slug }), jsonReq("PATCH", body), {});

const getIssue = async (h: Harness, id: string): Promise<IssueShape> => {
  const res = await h.app.request(url("issue.get", { id: id }), { headers: jsonReq("GET").headers }, {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { issue: IssueShape }).issue;
};

describe("board columns over the wire", () => {
  it("coerces a legacy string[] on create (backwards compat)", async () => {
    const h = makeHarness();
    const board = await createBoardWith(h, ["Backlog", "Doing", "QA", "Shipped", "Waiting"]);
    expect(board.columns.map((c) => c.category)).toEqual([
      "todo",
      "in_progress",
      "in_review",
      "done",
      "blocked",
    ]);
    expect(board.columns.map((c) => c.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it("accepts a client-supplied Column[] on create", async () => {
    const h = makeHarness();
    const board = await createBoardWith(h, [
      col({ id: "todo", name: "Todo", order: 0 }),
      col({ id: "done", name: "Done", order: 1, category: "done" }),
    ]);
    expect(board.columns).toHaveLength(2);
    expect(board.columns[1]).toMatchObject({ id: "done", category: "done" });
  });

  it("PATCH rejects each malformed Column[] with a specific reason", async () => {
    const h = makeHarness();
    await createBoardWith(h);
    for (const [columns, reason] of [
      [[], "columns-shape"],
      [
        Array.from({ length: 13 }, (_, i) => col({ id: `c${i}`, name: `C${i}`, order: i })),
        "columns-too-many",
      ],
      [
        [col({ id: "a", name: "A", order: 0 }), col({ id: "a", name: "B", order: 1 })],
        "columns-id-duplicate",
      ],
      [
        [col({ id: "a", name: "Same", order: 0 }), col({ id: "b", name: "same", order: 1 })],
        "columns-name-duplicate",
      ],
      [
        [col({ id: "a", name: "A", order: 0 }), col({ id: "b", name: "B", order: 5 })],
        "columns-order-not-contiguous",
      ],
      [[col({ id: "a", name: "A", order: 0, enabled: false })], "columns-none-enabled"],
      [[{ id: "a", name: "A", order: 0, enabled: true, category: "later" }], "columns-category"],
    ] as Array<[unknown, string]>) {
      const res = await patchBoard(h, { columns });
      expect(res.status, reason).toBe(400);
      expect(((await res.json()) as { reason: string }).reason).toBe(reason);
    }
  });

  it("rename keeps issues in place: same id, new status mirror", async () => {
    const h = makeHarness();
    const board = await createBoardWith(h);
    const review = board.columns.find((c) => c.name === "In Review")!;
    const issue = await createIssue(h, { status: "In Review" });
    expect(issue.column_id).toBe(review.id);

    const renamed = board.columns.map((c) =>
      c.id === review.id ? { ...c, name: "PR Zone" } : c,
    );
    const res = await patchBoard(h, { columns: renamed });
    expect(res.status).toBe(200);
    const { board: after } = (await res.json()) as { board: BoardShape };
    expect(after.columns.find((c) => c.id === review.id)).toMatchObject({
      name: "PR Zone",
      category: "in_review",
    });

    const moved = await getIssue(h, issue.id);
    expect(moved.column_id).toBe(review.id);
    expect(moved.status).toBe("PR Zone");
  });

  it("refuses to delete a column that still has issues without a move map", async () => {
    const h = makeHarness();
    const board = await createBoardWith(h);
    const progress = board.columns.find((c) => c.name === "In Progress")!;
    await createIssue(h, { status: "In Progress" });

    const res = await patchBoard(h, {
      columns: board.columns.filter((c) => c.id !== progress.id).map((c, order) => ({ ...c, order })),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("column-delete-has-issues");
  });

  it("deletes with a move map: issues land in the target column", async () => {
    const h = makeHarness();
    const board = await createBoardWith(h);
    const progress = board.columns.find((c) => c.name === "In Progress")!;
    const todo = board.columns.find((c) => c.name === "Todo")!;
    const issue = await createIssue(h, { status: "In Progress" });

    const res = await patchBoard(h, {
      columns: board.columns.filter((c) => c.id !== progress.id).map((c, order) => ({ ...c, order })),
      column_move_map: { [progress.id]: todo.id },
    });
    expect(res.status).toBe(200);
    const moved = await getIssue(h, issue.id);
    expect(moved.column_id).toBe(todo.id);
    expect(moved.status).toBe("Todo");
  });

  it("rejects a move map pointing at a disabled or missing column", async () => {
    const h = makeHarness();
    const board = await createBoardWith(h);
    const progress = board.columns.find((c) => c.name === "In Progress")!;
    await createIssue(h, { status: "In Progress" });
    const remaining = board.columns
      .filter((c) => c.id !== progress.id)
      .map((c, order) => ({ ...c, order }));

    const res = await patchBoard(h, {
      columns: remaining,
      column_move_map: { [progress.id]: "not-a-column" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("column-delete-has-issues");
  });

  it("hide-in-place: enabled:false keeps the column and its issues", async () => {
    const h = makeHarness();
    const board = await createBoardWith(h);
    const progress = board.columns.find((c) => c.name === "In Progress")!;
    const issue = await createIssue(h, { status: "In Progress" });

    const res = await patchBoard(h, {
      columns: board.columns.map((c) => (c.id === progress.id ? { ...c, enabled: false } : c)),
    });
    expect(res.status).toBe(200);
    const kept = await getIssue(h, issue.id);
    expect(kept.column_id).toBe(progress.id);
    expect(kept.status).toBe("In Progress");
  });
});

describe("issue types over the wire", () => {
  it("defaults to task, accepts each of the six, rejects junk", async () => {
    const h = makeHarness();
    await createBoardWith(h);
    const plain = await createIssue(h);
    expect(plain.type).toBe("task");
    for (const type of ["feature", "bug", "story", "improvement", "chore"]) {
      const issue = await createIssue(h, { type });
      expect(issue.type).toBe(type);
    }
    const res = await h.app.request(
      url("issue.create", { slug: "kb" }),
      jsonReq("POST", { title: "Nope", type: "epic" }),
      {},
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("type");
  });

  it("PATCH updates the type", async () => {
    const h = makeHarness();
    await createBoardWith(h);
    const issue = await createIssue(h);
    const res = await h.app.request(
      url("issue.get", { id: issue.id }),
      jsonReq("PATCH", { type: "bug" }),
      {},
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { issue: IssueShape }).issue.type).toBe("bug");
  });
});

describe("transition addressing", () => {
  const setup = async (h: Harness) => {
    const board = await createBoardWith(h);
    const issue = await createIssue(h);
    return { board, issue };
  };

  it("moves by column_id (preferred)", async () => {
    const h = makeHarness();
    const { board, issue } = await setup(h);
    const done = board.columns.find((c) => c.category === "done")!;
    const res = await h.app.request(
      url("issue.transition", { id: issue.id }),
      jsonReq("POST", { column_id: done.id }),
      {},
    );
    expect(res.status).toBe(200);
    const { issue: after } = (await res.json()) as { issue: IssueShape };
    expect(after).toMatchObject({ column_id: done.id, status: "Done" });
    expect(after.completed_at_ms).not.toBeNull();
  });

  it("column_id wins over a conflicting legacy name", async () => {
    const h = makeHarness();
    const { board, issue } = await setup(h);
    const review = board.columns.find((c) => c.name === "In Review")!;
    const res = await h.app.request(
      url("issue.transition", { id: issue.id }),
      jsonReq("POST", { column_id: review.id, to: "Done" }),
      {},
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { issue: IssueShape }).issue.column_id).toBe(review.id);
  });

  it("still accepts the legacy name forms `to` and `to_status`", async () => {
    const h = makeHarness();
    const { issue } = await setup(h);
    const viaTo = await h.app.request(
      url("issue.transition", { id: issue.id }),
      jsonReq("POST", { to: "In Progress" }),
      {},
    );
    expect(viaTo.status).toBe(200);
    expect(((await viaTo.json()) as { issue: IssueShape }).issue.status).toBe("In Progress");

    const viaToStatus = await h.app.request(
      url("issue.transition", { id: issue.id }),
      jsonReq("POST", { to_status: "In Review" }),
      {},
    );
    expect(viaToStatus.status).toBe(200);
    expect(((await viaToStatus.json()) as { issue: IssueShape }).issue.status).toBe("In Review");
  });

  it("400s on an unknown column_id or name", async () => {
    const h = makeHarness();
    const { issue } = await setup(h);
    const badId = await h.app.request(
      url("issue.transition", { id: issue.id }),
      jsonReq("POST", { column_id: "ghost" }),
      {},
    );
    expect(badId.status).toBe(400);
    const badName = await h.app.request(
      url("issue.transition", { id: issue.id }),
      jsonReq("POST", { to: "Ghost" }),
      {},
    );
    expect(badName.status).toBe(400);
  });

  it("completed_at_ms follows the done CATEGORY, not the name 'Done'", async () => {
    const h = makeHarness();
    const board = await createBoardWith(h, [
      col({ id: "open", name: "Open", order: 0 }),
      col({ id: "shipped", name: "Shipped", order: 1, category: "done" }),
    ]);
    const issue = await createIssue(h, { status: "Open" });
    expect(issue.completed_at_ms).toBeNull();

    const res = await h.app.request(
      url("issue.transition", { id: issue.id }),
      jsonReq("POST", { column_id: "shipped" }),
      {},
    );
    expect(res.status).toBe(200);
    const { issue: after } = (await res.json()) as { issue: IssueShape };
    expect(after.completed_at_ms).not.toBeNull();

    // And leaving the done-category column clears it again.
    const back = await h.app.request(
      url("issue.transition", { id: issue.id }),
      jsonReq("POST", { column_id: "open" }),
      {},
    );
    expect(((await back.json()) as { issue: IssueShape }).issue.completed_at_ms).toBeNull();
    expect(board.columns.map((c) => c.category)).toEqual(["todo", "done"]);
  });
});
