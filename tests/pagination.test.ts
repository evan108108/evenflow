// Phase 22: cursor-paged board streams.
//
// The bug this phase exists to kill is a SILENT one — a board over the old
// 100-issue ceiling simply stopped showing cards, with no error anywhere.
// So the tests here are mostly "is every row reachable by walking the
// cursor to exhaustion", which is the only assertion that actually catches
// a truncated stream.

import { describe, expect, it } from "vitest";
import {
  cursorOf,
  cursorPredicate,
  decodeCursor,
  encodeCursor,
  orderByFor,
} from "../src/issue-cursor";
import { makeHarness, bearer, createBoard, jsonReq, type Harness } from "./harness";
import type { IssueShape } from "../src/shapes";

// ── cursor unit tests ─────────────────────────────────────────────────────

describe("issue cursor", () => {
  it("round-trips a position cursor", () => {
    const c = { kind: "position" as const, isNull: 0 as const, value: 12.5, id: "abc" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("round-trips a recency cursor", () => {
    const c = { kind: "recency" as const, isNull: 0 as const, value: 1785391549064, id: "x-1" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("round-trips an id containing dots", () => {
    const c = { kind: "position" as const, isNull: 1 as const, value: 0, id: "a.b.c" };
    expect(decodeCursor(encodeCursor(c))?.id).toBe("a.b.c");
  });

  it("is opaque — the raw values are not readable in the token", () => {
    expect(encodeCursor({ kind: "position", isNull: 0, value: 12.5, id: "abc" })).not.toContain("12.5");
  });

  it("rejects malformed cursors instead of silently restarting the stream", () => {
    // Restarting from the top on a bad cursor would loop an infinite
    // scroll forever, which is worse than a 400.
    const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const bad of [
      "",
      "!!!",
      b64("not json"),
      b64(JSON.stringify(["z", 0, 1, "id"])), // unknown stream tag
      b64(JSON.stringify(["p", 2, 1, "id"])), // is-null flag out of range
      b64(JSON.stringify(["p", 0, "x", "id"])), // non-numeric key
      b64(JSON.stringify(["p", 0, 1, ""])), // empty id
      b64(JSON.stringify(["p", 0, 1])), // wrong arity
    ]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it("orders the position stream with the NULL tail last", () => {
    expect(orderByFor("position")).toBe("ORDER BY (position IS NULL) ASC, position ASC, id DESC");
  });

  it("pages FORWARD on the ascending position stream", () => {
    // The brief's draft had `position <` against an ASC scan, which walks
    // away from the tail and stalls the scroll on page one.
    const { sql } = cursorPredicate({ kind: "position", isNull: 0, value: 5, id: "i" });
    expect(sql).toContain("COALESCE(position, 0) > ?");
    expect(sql).not.toContain("COALESCE(position, 0) < ?");
  });

  it("derives a cursor that carries the NULL flag", () => {
    expect(cursorOf("position", { id: "i", position: null, updated_at_ms: 5 })).toMatchObject({
      isNull: 1,
    });
    expect(cursorOf("position", { id: "i", position: 3, updated_at_ms: 5 })).toMatchObject({
      isNull: 0,
      value: 3,
    });
  });
});

// ── endpoint tests ────────────────────────────────────────────────────────

const seed = (h: Harness, boardId: string, columnId: string, n: number, from = 0) => {
  for (let k = 0; k < n; k++) {
    const i = from + k;
    h.db.issues.push({
      id: `i${String(i).padStart(4, "0")}`,
      short_id: `KB-${i}`,
      board_id: boardId,
      title: `Issue ${i}`,
      body: null,
      body_format: "markdown",
      type: "task",
      status: "Todo",
      column_id: columnId,
      container: "active",
      assignee_pubkey: null,
      priority: null,
      estimate: null,
      labels: "[]",
      github_links: "[]",
      position: (i + 1) * 100,
      sprint_id: null,
      external_state: null,
      external_state_updated_at_ms: null,
      created_at_ms: 1,
      updated_at_ms: 1000 + i,
      completed_at_ms: null,
    });
  }
};

const firstColumnId = (h: Harness): string => {
  const cols = JSON.parse(String(h.db.boards[0]!["columns"])) as Array<{ id: string }>;
  return cols[0]!.id;
};

/** Walk the stream to exhaustion, returning every title seen plus page count. */
const drain = async (h: Harness, query: string, limit: number) => {
  const titles: string[] = [];
  let after: string | null = null;
  let pages = 0;
  for (;;) {
    const url = `/api/v0/boards/kb/issues?${query}&limit=${limit}${after === null ? "" : `&after=${encodeURIComponent(after)}`}`;
    const res = await h.app.request(url, { headers: bearer }, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issues: IssueShape[];
      has_more: boolean;
      next_after: string | null;
    };
    titles.push(...body.issues.map((i) => i.title));
    pages++;
    if (!body.has_more) {
      // A terminal page must not hand back a cursor — a client that keeps
      // following one would spin.
      expect(body.next_after).toBeNull();
      break;
    }
    expect(body.next_after).not.toBeNull();
    after = body.next_after;
    if (pages > 50) throw new Error("stream did not terminate");
  }
  return { titles, pages };
};

describe("paged column stream", () => {
  it("reaches every issue past the old 100 ceiling", async () => {
    const h = makeHarness();
    await createBoard(h);
    const col = firstColumnId(h);
    seed(h, String(h.db.boards[0]!["id"]), col, 120);

    const { titles } = await drain(h, `container=active&column_id=${col}`, 50);
    expect(titles).toHaveLength(120);
    expect(new Set(titles).size).toBe(120);
  });

  it("pages in position order with no gaps or repeats", async () => {
    const h = makeHarness();
    await createBoard(h);
    const col = firstColumnId(h);
    seed(h, String(h.db.boards[0]!["id"]), col, 10);

    const { titles, pages } = await drain(h, `container=active&column_id=${col}`, 3);
    expect(pages).toBe(4);
    expect(titles).toEqual(Array.from({ length: 10 }, (_, i) => `Issue ${i}`));
  });

  it("reaches legacy NULL-position rows in the tail", async () => {
    // The whole reason the sort key is a tuple: a scalar `position > ?`
    // can never step past NULL, so these rows would be permanently
    // invisible — the original bug, relocated to the oldest cards.
    const h = makeHarness();
    await createBoard(h);
    const col = firstColumnId(h);
    const boardId = String(h.db.boards[0]!["id"]);
    seed(h, boardId, col, 4);
    seed(h, boardId, col, 2, 90);
    for (const r of h.db.issues) {
      if (Number(String(r["short_id"]).split("-")[1]) >= 90) r["position"] = null;
    }

    const { titles } = await drain(h, `container=active&column_id=${col}`, 2);
    expect(titles).toHaveLength(6);
    expect(titles.slice(-2).sort()).toEqual(["Issue 90", "Issue 91"]);
  });

  it("honours limit and caps it at the maximum", async () => {
    const h = makeHarness();
    await createBoard(h);
    const col = firstColumnId(h);
    seed(h, String(h.db.boards[0]!["id"]), col, 150);

    const res = await h.app.request(
      `/api/v0/boards/kb/issues?container=active&column_id=${col}&limit=500`,
      { headers: bearer },
      {},
    );
    const body = (await res.json()) as { issues: IssueShape[]; has_more: boolean };
    expect(body.issues).toHaveLength(100);
    expect(body.has_more).toBe(true);
  });

  it("keeps total across pages so the column header can show a count", async () => {
    const h = makeHarness();
    await createBoard(h);
    const col = firstColumnId(h);
    seed(h, String(h.db.boards[0]!["id"]), col, 7);

    const res = await h.app.request(
      `/api/v0/boards/kb/issues?container=active&column_id=${col}&limit=3`,
      { headers: bearer },
      {},
    );
    expect(((await res.json()) as { total: number }).total).toBe(7);
  });

  it("survives the anchor row being deleted mid-scroll", async () => {
    // The reason the cursor is encoded rather than an issue id: a client
    // holding a cursor whose row has since been deleted must keep paging,
    // not hard-fail.
    const h = makeHarness();
    await createBoard(h);
    const col = firstColumnId(h);
    seed(h, String(h.db.boards[0]!["id"]), col, 6);

    const first = (await (
      await h.app.request(
        `/api/v0/boards/kb/issues?container=active&column_id=${col}&limit=3`,
        { headers: bearer },
        {},
      )
    ).json()) as { next_after: string; issues: IssueShape[] };

    const lastId = first.issues.at(-1)!.id;
    h.db.issues.splice(
      h.db.issues.findIndex((r) => r["id"] === lastId),
      1,
    );

    const res = await h.app.request(
      `/api/v0/boards/kb/issues?container=active&column_id=${col}&limit=3&after=${encodeURIComponent(first.next_after)}`,
      { headers: bearer },
      {},
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { issues: IssueShape[] }).issues.map((i) => i.title)).toEqual([
      "Issue 3",
      "Issue 4",
      "Issue 5",
    ]);
  });

  it("rejects an unknown column_id and a cursor from the wrong stream", async () => {
    const h = makeHarness();
    await createBoard(h);
    const col = firstColumnId(h);

    const bad = await h.app.request(
      "/api/v0/boards/kb/issues?container=active&column_id=nope",
      { headers: bearer },
      {},
    );
    expect(bad.status).toBe(400);

    const recency = encodeCursor({ kind: "recency", isNull: 0, value: 1, id: "x" });
    const mismatched = await h.app.request(
      `/api/v0/boards/kb/issues?container=active&column_id=${col}&after=${encodeURIComponent(recency)}`,
      { headers: bearer },
      {},
    );
    expect(mismatched.status).toBe(400);
    expect(((await mismatched.json()) as { reason: string }).reason).toBe("after-stream-mismatch");
  });

  it("claims legacy rows whose column_id was never backfilled", async () => {
    const h = makeHarness();
    await createBoard(h);
    const col = firstColumnId(h);
    const cols = JSON.parse(String(h.db.boards[0]!["columns"])) as Array<{ id: string; name: string }>;
    seed(h, String(h.db.boards[0]!["id"]), col, 2);
    h.db.issues.push({
      ...h.db.issues[0],
      id: "legacy1",
      short_id: "KB-999",
      title: "Legacy",
      column_id: null,
      status: cols[0]!.name,
      position: 50,
    });

    const { titles } = await drain(h, `container=active&column_id=${col}`, 10);
    expect(titles).toContain("Legacy");
  });
});

describe("paged side-list stream", () => {
  it("pages backlog by recency and accepts a bare issue id for back-compat", async () => {
    const h = makeHarness();
    await createBoard(h);
    const boardId = String(h.db.boards[0]!["id"]);
    seed(h, boardId, firstColumnId(h), 5);
    for (const r of h.db.issues) r["container"] = "backlog";

    const { titles } = await drain(h, "container=backlog", 2);
    // Recency stream is newest-first.
    expect(titles).toEqual(["Issue 4", "Issue 3", "Issue 2", "Issue 1", "Issue 0"]);

    // Pre-22 clients passed the last issue id directly.
    const res = await h.app.request(
      "/api/v0/boards/kb/issues?container=backlog&limit=2&after=i0004",
      { headers: bearer },
      {},
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { issues: IssueShape[] }).issues.map((i) => i.title)).toEqual([
      "Issue 3",
      "Issue 2",
    ]);
  });
});

describe("composed filters", () => {
  it("narrows a column stream by assignee", async () => {
    const h = makeHarness();
    await createBoard(h);
    const col = firstColumnId(h);
    seed(h, String(h.db.boards[0]!["id"]), col, 4);
    h.db.issues[1]!["assignee_pubkey"] = "test:me";
    h.db.issues[3]!["assignee_pubkey"] = "test:me";

    const { titles } = await drain(h, `container=active&column_id=${col}&assignee=test:me`, 10);
    expect(titles).toEqual(["Issue 1", "Issue 3"]);
  });

  it("narrows by a q substring over title and body", async () => {
    const h = makeHarness();
    await createBoard(h);
    const col = firstColumnId(h);
    seed(h, String(h.db.boards[0]!["id"]), col, 3);
    h.db.issues[2]!["body"] = "mentions widgets";

    const byTitle = await drain(h, `container=active&column_id=${col}&q=Issue%201`, 10);
    expect(byTitle.titles).toEqual(["Issue 1"]);

    const byBody = await drain(h, `container=active&column_id=${col}&q=widgets`, 10);
    expect(byBody.titles).toEqual(["Issue 2"]);
  });
});
