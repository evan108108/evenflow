// EFB-15 — CSV import.
//
// Split the way the feature is: the SHAPE rules are asserted against the schema
// directly, with no database and no router, because `src/lib/csv-canonical.ts`
// is pure and that is the entire payoff of the Boundary Discipline division.
// The STATE rules — dedup, roster mapping, status resolution, idempotency —
// need a board, so they run through the real router over DbMock.
//
// The one test that would be easy to leave out and matters most is
// `templatesFor` returning nothing for an import event. Without it, the kind
// name is one character away from publishing a false, signed, unretractable
// claim to a public relay. See the guard in src/lib/kanban/publish.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";
import { decodeBody } from "../src/lib/route-body";
import {
  CANONICAL_COLUMNS,
  ImportIssueRow,
  MAX_IMPORT_ROWS,
  PostBulkIssuesBody,
} from "../src/lib/csv-canonical";
import { resolveStatusColumn } from "../src/routes/imports";
import { templatesFor } from "../src/lib/kanban/publish";
import { ISSUE_TYPES, type Column } from "../src/columns";
import type { BoardShape } from "../src/shapes";
import type { BoardEvent } from "../src/durable-objects/board-events";
import {
  CALLER,
  bearer,
  createBoard,
  jsonReq,
  makeHarness,
  seedBoardMember,
  type Harness,
} from "./harness";

const IMPORT_ID = "3f1c2b8a-0000-4000-8000-000000000001";
const OTHER_IMPORT_ID = "3f1c2b8a-0000-4000-8000-000000000002";

const decode = <A, I>(schema: Parameters<typeof decodeBody<A, I>>[0], input: unknown) =>
  Effect.runSync(Effect.exit(decodeBody(schema, input)));

const reasonOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "<succeeded>";
  const err = (exit.cause as { error?: { reason?: string } }).error;
  return err?.reason ?? "<no reason>";
};

const bulkBody = (issues: ReadonlyArray<Record<string, unknown>>, importId = IMPORT_ID) => ({
  import_id: importId,
  issues,
});

// ── SHAPE — no database, no router ───────────────────────────────────────

describe("canonical row — shape", () => {
  it("accepts a row carrying only a title", () => {
    const exit = decode(ImportIssueRow, { title: "Fix the thing" });
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("rejects a row with no title", () => {
    expect(reasonOf(decode(ImportIssueRow, { body: "orphan" }))).toBe("title");
  });

  it("rejects a title that is only whitespace", () => {
    expect(reasonOf(decode(ImportIssueRow, { title: "   " }))).toBe("title");
  });

  it("names an unknown column rather than dropping it", () => {
    // The EFB-53 rule. A `titl` typo must not return 200 with the field
    // silently missing.
    expect(reasonOf(decode(ImportIssueRow, { title: "x", titl: "y" }))).toBe("titl-unknown");
  });

  it("trims the title, and hands back the trimmed form", () => {
    const exit = decode(ImportIssueRow, { title: "  padded  " });
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ title: "padded" });
  });

  it("normalizes type case and surrounding space", () => {
    const exit = decode(ImportIssueRow, { title: "x", type: " Bug " });
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ type: "bug" });
  });

  it("accepts every one of the six real issue types", () => {
    // Regression guard for the brief's `bug|task|feature`. A narrower union
    // here would reject `story` at import while the UI creates one happily.
    for (const type of ISSUE_TYPES) {
      const exit = decode(ImportIssueRow, { title: "x", type });
      expect(Exit.isSuccess(exit), `type ${type} should be accepted`).toBe(true);
    }
  });

  it("rejects a type outside the vocabulary", () => {
    expect(reasonOf(decode(ImportIssueRow, { title: "x", type: "epic" }))).toBe("type");
  });

  it("accepts `iced` as the pre-EFB-17 spelling of icebox", () => {
    const exit = decode(ImportIssueRow, { title: "x", container: "iced" });
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ container: "icebox" });
  });

  it("rejects a container outside the vocabulary", () => {
    expect(reasonOf(decode(ImportIssueRow, { title: "x", container: "frozen" }))).toBe(
      "container",
    );
  });

  it("does NOT coerce a numeric string into a number", () => {
    // Invariant 2. The browser types the column before POSTing.
    expect(reasonOf(decode(ImportIssueRow, { title: "x", estimate: "3" }))).toBe("estimate");
  });

  it("rejects a negative estimate", () => {
    expect(reasonOf(decode(ImportIssueRow, { title: "x", estimate: -1 }))).toBe("estimate");
  });

  it("requires external_url to be an absolute http(s) URL", () => {
    expect(reasonOf(decode(ImportIssueRow, { title: "x", external_url: "/issues/4" }))).toBe(
      "external_url",
    );
  });

  it("accepts an assignee that is not an identity reference at all", () => {
    // The deliberate policy exception: a foreign export writes emails and
    // display names, and 400-ing the batch over one would break most real
    // imports. Mapping happens in the handler; unmappable costs the FIELD.
    const exit = decode(ImportIssueRow, { title: "x", assignee_pubkey: "jane@acme.com" });
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("accepts labels as an array and rejects the raw CSV string", () => {
    expect(
      Exit.isSuccess(decode(ImportIssueRow, { title: "x", labels: ["auth", "urgent"] })),
    ).toBe(true);
    // `;`-separation is a CSV encoding detail that dies in the browser.
    expect(reasonOf(decode(ImportIssueRow, { title: "x", labels: "auth;urgent" }))).toBe(
      "labels",
    );
  });

  it("treats an explicit null the same as an absent optional", () => {
    const exit = decode(ImportIssueRow, { title: "x", body: null, status: null });
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("bulk body — shape", () => {
  it("accepts a well-formed batch", () => {
    expect(Exit.isSuccess(decode(PostBulkIssuesBody, bulkBody([{ title: "a" }])))).toBe(true);
  });

  it("requires import_id to be a uuid", () => {
    expect(reasonOf(decode(PostBulkIssuesBody, bulkBody([{ title: "a" }], "not-a-uuid")))).toBe(
      "import_id",
    );
  });

  it("rejects an empty batch", () => {
    expect(reasonOf(decode(PostBulkIssuesBody, bulkBody([])))).toBe("issues");
  });

  it(`rejects more than ${MAX_IMPORT_ROWS} rows`, () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => ({ title: "a" }));
    expect(reasonOf(decode(PostBulkIssuesBody, bulkBody(rows)))).toBe("issues");
  });

  it(`accepts exactly ${MAX_IMPORT_ROWS} rows`, () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, () => ({ title: "a" }));
    expect(Exit.isSuccess(decode(PostBulkIssuesBody, bulkBody(rows)))).toBe(true);
  });

  it("names the offending ROW INDICES, not just the field", () => {
    // The whole reason `ImportIssueRows` exists. Without it every problem in a
    // thousand rows collapses to `issues`, which tells a user nothing.
    const rows = [{ title: "ok" }, { title: "" }, { title: "ok" }, { nope: 1 }];
    expect(reasonOf(decode(PostBulkIssuesBody, bulkBody(rows)))).toBe("issues-rows-1-3");
  });

  it("rejects an unknown key at the top level", () => {
    expect(
      reasonOf(decode(PostBulkIssuesBody, { ...bulkBody([{ title: "a" }]), dry_run: true })),
    ).toBe("dry_run-unknown");
  });

  it("exposes the canonical column list the docs and UI read from", () => {
    expect([...CANONICAL_COLUMNS]).toEqual([
      "title",
      "body",
      "type",
      "status",
      "container",
      "estimate",
      "labels",
      "assignee_pubkey",
      "external_url",
      "created_at_ms",
    ]);
  });
});

// ── the substrate guard ──────────────────────────────────────────────────

describe("issues.imported — substrate publish", () => {
  const board = {
    id: "b1",
    slug: "kb",
    title: "Board",
    visibility: "public",
    columns: [],
  } as unknown as BoardShape;

  it("builds NO substrate template for an import event", () => {
    // If this ever returns a template, an import is publishing a signed public
    // claim about something that did not happen. The kind name being plural is
    // NOT what makes this pass — the explicit guard in publish.ts is.
    const event: BoardEvent = {
      kind: "issues.imported",
      board_id: "b1",
      at_ms: 1_000,
      payload: { import_id: IMPORT_ID, count: 3, created: 3, skipped: 0, unassigned: 0 },
    };
    expect(templatesFor(board, event, null)).toEqual([]);
  });
});

// ── status resolution ────────────────────────────────────────────────────

describe("resolveStatusColumn", () => {
  const columns: Column[] = [
    { id: "c1", name: "Todo", order: 0, enabled: true, category: "todo" },
    { id: "c2", name: "In Review", order: 1, enabled: true, category: "in_review" },
    { id: "c3", name: "Archive", order: 2, enabled: false, category: "done" },
  ];

  it("matches ignoring case and surrounding whitespace", () => {
    expect(resolveStatusColumn(columns, "  in review ")?.id).toBe("c2");
    expect(resolveStatusColumn(columns, "TODO")?.id).toBe("c1");
  });

  it("returns undefined for a name this board does not have", () => {
    // Never guesses, never creates a column on the fly.
    expect(resolveStatusColumn(columns, "Not Started")).toBeUndefined();
  });

  it("does not match on a partial name", () => {
    expect(resolveStatusColumn(columns, "Review")).toBeUndefined();
  });

  it("finds a disabled column when nothing enabled matches", () => {
    expect(resolveStatusColumn(columns, "archive")?.id).toBe("c3");
  });
});

// ── STATE — through the real router ──────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

interface ImportReport {
  import_id: string;
  counts: {
    total: number;
    created: number;
    skipped: number;
    failed: number;
    unassigned: number;
  };
  substrate: { state: string; reason: string };
  rows: Array<{
    row: number;
    status: string;
    short_id?: string;
    reason?: string;
    value?: string;
    existing_short_id?: string;
    assignee_skipped?: string;
  }>;
}

const importInto = async (
  h: Harness,
  issues: ReadonlyArray<Record<string, unknown>>,
  importId = IMPORT_ID,
  slug = "kb",
): Promise<{ status: number; report: ImportReport }> => {
  const res = await h.app.request(
    `/api/v0/boards/${slug}/issues/bulk`,
    jsonReq("POST", bulkBody(issues, importId)),
    {},
  );
  return { status: res.status, report: (await res.json()) as ImportReport };
};

describe("POST /api/v0/boards/:slug/issues/bulk", () => {
  it("creates every valid row and reports each one", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { status, report } = await importInto(h, [
      { title: "First" },
      { title: "Second", type: "bug", status: "In Progress", container: "active", estimate: 3 },
    ]);

    expect(status).toBe(200);
    expect(report.counts).toEqual({
      total: 2,
      created: 2,
      skipped: 0,
      failed: 0,
      unassigned: 0,
    });
    expect(report.rows.map((r) => r.status)).toEqual(["created", "created"]);
    expect(h.db.issues).toHaveLength(2);
    expect(h.db.issues[1]).toMatchObject({
      title: "Second",
      type: "bug",
      status: "In Progress",
      container: "active",
      estimate: 3,
      import_event_id: IMPORT_ID,
    });
  });

  it("writes a status-change row per imported issue", async () => {
    // Not a notification — this is what tide/velocity compute against, so an
    // imported backlog that skipped these would be invisible to `adds_today`.
    const h = makeHarness();
    await createBoard(h);
    await importInto(h, [{ title: "a" }, { title: "b" }]);
    expect(h.db.statusChanges).toHaveLength(2);
    expect(h.db.statusChanges[0]).toMatchObject({
      actor_pubkey: CALLER,
      from_status: null,
      to_status: "Todo",
      from_container: null,
      to_container: "backlog",
    });
  });

  it("emits ONE aggregate event, not one per issue", async () => {
    const h = makeHarness();
    await createBoard(h);
    h.emitter.events.length = 0;
    await importInto(h, [{ title: "a" }, { title: "b" }, { title: "c" }]);

    const kinds = h.emitter.events.map((e) => e.event.kind);
    expect(kinds).toEqual(["issues.imported"]);
    expect(kinds).not.toContain("issue.created");
    expect(h.emitter.events[0]?.event.payload).toMatchObject({
      import_id: IMPORT_ID,
      count: 3,
      created: 3,
    });
  });

  it("says explicitly that imports do not publish to the substrate", async () => {
    // Surfaced rather than left as an unexplained NULL column, so nobody files
    // "why is substrate_event_id NULL here?" as a bug.
    const h = makeHarness();
    await createBoard(h);
    const { report } = await importInto(h, [{ title: "a" }]);
    expect(report.substrate.state).toBe("not_applicable_for_imports");
  });

  it("skips a row whose status names no column, and creates the rest", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { report } = await importInto(h, [
      { title: "lands" },
      { title: "homeless", status: "Not Started" },
      { title: "also lands" },
    ]);

    expect(report.counts).toMatchObject({ total: 3, created: 2, skipped: 1 });
    expect(report.rows[1]).toMatchObject({
      row: 1,
      status: "skipped",
      reason: "unknown-status",
      value: "Not Started",
    });
    expect(h.db.issues).toHaveLength(2);
    // No column was invented to hold it.
    expect(h.db.issues.map((i) => i["status"])).toEqual(["Todo", "Todo"]);
  });

  it("keeps rows in submission order regardless of outcome", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { report } = await importInto(h, [
      { title: "a", status: "Nope" },
      { title: "b" },
      { title: "c", status: "Nope" },
    ]);
    expect(report.rows.map((r) => r.row)).toEqual([0, 1, 2]);
    expect(report.rows.map((r) => r.status)).toEqual(["skipped", "created", "skipped"]);
  });

  it("does not burn issue numbers on skipped rows", async () => {
    // Gaps in a visible permanent sequence read as deleted work.
    const h = makeHarness();
    await createBoard(h);
    await importInto(h, [
      { title: "a" },
      { title: "skipped", status: "Nope" },
      { title: "b" },
    ]);
    expect(h.db.issues.map((i) => i["short_id"])).toEqual(["BOA-1", "BOA-2"]);
  });

  it("skips a re-imported row by external_url", async () => {
    const h = makeHarness();
    await createBoard(h);
    await importInto(h, [{ title: "orig", external_url: "https://x.test/1" }]);
    const { report } = await importInto(
      h,
      [
        { title: "orig again", external_url: "https://x.test/1" },
        { title: "new", external_url: "https://x.test/2" },
      ],
      OTHER_IMPORT_ID,
    );

    expect(report.counts).toMatchObject({ created: 1, skipped: 1 });
    expect(report.rows[0]).toMatchObject({
      status: "skipped",
      reason: "duplicate-external-url",
      existing_short_id: "BOA-1",
    });
    expect(h.db.issues).toHaveLength(2);
  });

  it("skips a duplicate that appears twice within ONE batch", async () => {
    // The pre-check cannot see rows that do not exist yet.
    const h = makeHarness();
    await createBoard(h);
    const { report } = await importInto(h, [
      { title: "first", external_url: "https://x.test/dup" },
      { title: "second", external_url: "https://x.test/dup" },
    ]);
    expect(report.counts).toMatchObject({ created: 1, skipped: 1 });
    expect(report.rows[1]).toMatchObject({ reason: "duplicate-external-url-in-batch" });
    expect(h.db.issues).toHaveLength(1);
  });

  it("lands an issue unassigned when the assignee cannot be mapped", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { report } = await importInto(h, [
      { title: "orphaned", assignee_pubkey: "jane@acme.com" },
    ]);

    // CREATED, not skipped — the issue exists, only the field was dropped.
    expect(report.rows[0]).toMatchObject({
      status: "created",
      assignee_skipped: "jane@acme.com",
    });
    expect(report.counts).toMatchObject({ created: 1, skipped: 0, unassigned: 1 });
    expect(h.db.issues[0]).toMatchObject({ assignee_pubkey: null });
  });

  it("assigns when the CSV names an actual board member", async () => {
    const h = makeHarness();
    await createBoard(h);
    const board = h.db.boards[0];
    seedBoardMember(h, String(board?.["id"]), "test:mallory", "contributor");
    const { report } = await importInto(h, [
      { title: "assigned", assignee_pubkey: "test:mallory" },
    ]);

    expect(report.counts).toMatchObject({ unassigned: 0 });
    expect(report.rows[0]?.assignee_skipped).toBeUndefined();
    expect(h.db.issues[0]).toMatchObject({ assignee_pubkey: "test:mallory" });
  });

  it("drops a well-formed identity that is not on THIS board's roster", async () => {
    const h = makeHarness();
    await createBoard(h);
    const stranger = "nostr:1111111111111111111111111111111111111111111111111111111111111111";
    const { report } = await importInto(h, [{ title: "x", assignee_pubkey: stranger }]);
    expect(report.rows[0]).toMatchObject({ status: "created", assignee_skipped: stranger });
    expect(h.db.issues[0]).toMatchObject({ assignee_pubkey: null });
  });

  it("replays the original report for a repeated import_id", async () => {
    const h = makeHarness();
    await createBoard(h);
    const first = await importInto(h, [{ title: "once" }]);
    const second = await importInto(h, [{ title: "once" }]);

    expect(second.status).toBe(200);
    expect(second.report).toEqual(first.report);
    // The point: no second copy of the backlog.
    expect(h.db.issues).toHaveLength(1);
  });

  it("imports once, and answers 200 twice, when the same batch is POSTed concurrently", async () => {
    // Asserts the CONTRACT, not the branch. Two identical POSTs in flight can
    // both clear the replay check before either writes the claim row; whichever
    // path serves the loser — replay or the claim-collision guard — the two
    // things that must hold are the same: nobody gets a 500 on a request whose
    // issues committed, and the backlog is not imported twice.
    //
    // Deliberately not written to force a particular branch. A test that
    // planted the claim row first would only re-test the replay check while
    // claiming to cover the race, which is worse than not having it.
    const h = makeHarness();
    await createBoard(h);
    const rows = [{ title: "a", external_url: "https://x.test/c1" }, { title: "b" }];

    const [first, second] = await Promise.all([
      importInto(h, rows),
      importInto(h, rows),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The url-bearing row is protected by the UNIQUE index either way; the
    // titles-only row is what a broken claim path would duplicate.
    expect(h.db.issues.filter((i) => i["title"] === "b")).toHaveLength(1);
    expect(h.db.issueImports).toHaveLength(1);
  });

  it("does not replay a dedup row that has aged out of the window", async () => {
    // The sweep runs BEFORE the replay check, so the window is exactly the TTL
    // rather than "the TTL, plus however long until somebody imports again".
    const h = makeHarness();
    await createBoard(h);
    h.db.issueImportDedup.push({
      id: IMPORT_ID,
      created_at_ms: 1_000 - 25 * 60 * 60 * 1000, // 25h old
      response_json: JSON.stringify({ import_id: IMPORT_ID, counts: { created: 99 } }),
    });

    const { report } = await importInto(h, [{ title: "fresh" }]);
    expect(report.counts).toMatchObject({ total: 1, created: 1 });
    expect(h.db.issues).toHaveLength(1);
  });

  it("treats a DIFFERENT import_id as a new import", async () => {
    const h = makeHarness();
    await createBoard(h);
    await importInto(h, [{ title: "a" }]);
    await importInto(h, [{ title: "b" }], OTHER_IMPORT_ID);
    expect(h.db.issues).toHaveLength(2);
  });

  it("honours a per-row created_at_ms so an imported backlog keeps its age", async () => {
    const h = makeHarness();
    await createBoard(h);
    await importInto(h, [{ title: "old", created_at_ms: 42 }]);
    expect(h.db.issues[0]).toMatchObject({ created_at_ms: 42 });
  });

  it("rejects the whole batch when any row is malformed, writing nothing", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request(
      "/api/v0/boards/kb/issues/bulk",
      jsonReq("POST", bulkBody([{ title: "fine" }, { title: "" }])),
      {},
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { reason: string }).toMatchObject({
      reason: "issues-rows-1",
    });
    expect(h.db.issues).toHaveLength(0);
  });

  it("requires a caller", async () => {
    const h = makeHarness();
    await createBoard(h);
    const res = await h.app.request("/api/v0/boards/kb/issues/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bulkBody([{ title: "a" }])),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v0/boards/:slug/imports", () => {
  it("lists past imports with their counts", async () => {
    const h = makeHarness();
    await createBoard(h);
    await importInto(h, [
      { title: "a" },
      { title: "b", status: "Nope" },
      { title: "c", assignee_pubkey: "jane@acme.com" },
    ]);

    const res = await h.app.request("/api/v0/boards/kb/imports", { headers: bearer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      imports: Array<Record<string, unknown>>;
      max_rows_per_import: number;
    };
    expect(body.max_rows_per_import).toBe(MAX_IMPORT_ROWS);
    expect(body.imports).toHaveLength(1);
    expect(body.imports[0]).toMatchObject({
      id: IMPORT_ID,
      imported_by_pubkey: CALLER,
      row_count: 3,
      created_count: 2,
      skipped_count: 1,
      failed_count: 0,
      // Survives the 24h sweep that takes the per-row report with it.
      unmapped_assignees: 1,
    });
  });
});
