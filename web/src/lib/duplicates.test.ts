// EFB-30 — the duplicate-of pointer → short-id resolution.
//
// Small surface, but the miss case is the one that matters: the client only
// holds the pages it has loaded, so `refFor` returning null is a routine
// outcome and must never be read as "not a duplicate".

import { describe, expect, it } from "vitest";
import { refFor, shortIdIndex } from "./duplicates";
import type { Issue } from "./types";

const issue = (over: Partial<Issue> & { id: string }): Issue =>
  ({
    short_id: `KB-${over.id}`,
    board_id: "b1",
    title: "An issue",
    body: null,
    body_format: "markdown",
    type: "task",
    status: "Todo",
    column_id: "c1",
    container: "backlog",
    assignee_pubkey: null,
    priority: null,
    estimate: null,
    labels: [],
    github_links: [],
    created_at_ms: 1,
    updated_at_ms: 1,
    completed_at_ms: null,
    ...over,
  }) as Issue;

describe("shortIdIndex", () => {
  it("maps id → short id and skips rows awaiting backfill", () => {
    const index = shortIdIndex([
      issue({ id: "1" }),
      issue({ id: "2", short_id: null }),
    ]);
    expect(index.get("1")).toBe("KB-1");
    expect(index.has("2")).toBe(false);
  });
});

describe("refFor", () => {
  it("resolves the target's short id", () => {
    const index = shortIdIndex([issue({ id: "7" })]);
    expect(refFor(index, issue({ id: "9", duplicate_of_issue_id: "7" }))).toBe("KB-7");
  });

  it("returns null when the issue is not a duplicate", () => {
    const index = shortIdIndex([issue({ id: "7" })]);
    expect(refFor(index, issue({ id: "9" }))).toBe(null);
  });

  // The important case: a duplicate whose original hasn't been paged in.
  // Callers must decide "is a duplicate" from the pointer, never from this.
  it("returns null when the target isn't loaded, even though it IS a duplicate", () => {
    const index = shortIdIndex([issue({ id: "9" })]);
    const dupe = issue({ id: "9", duplicate_of_issue_id: "not-loaded" });
    expect(refFor(index, dupe)).toBe(null);
    expect(dupe.duplicate_of_issue_id).toBe("not-loaded");
  });

  it("returns null when the target is loaded but has no short id yet", () => {
    const index = shortIdIndex([issue({ id: "7", short_id: null })]);
    expect(refFor(index, issue({ id: "9", duplicate_of_issue_id: "7" }))).toBe(null);
  });
});
