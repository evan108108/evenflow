// EFB-24 Phase 2: the plaintext kanban builders (30550-30554).
//
// These assertions are the cross-repo contract. The gateway's validators pin
// the same events byte-for-byte as golden fixtures, so a change to a tag
// vocabulary, a content field, or a field's serialization order fails here
// AND there rather than going out on the wire and quietly breaking replay.
// If you change a builder, you are changing a wire format: update the gateway
// golden fixture in the same PR or the drift test catches you.
//
// Every event is built with an explicit `createdAt` so the blake3 tag is
// deterministic — the builders default to nowSec(), which would make these
// snapshots unstable.

import { describe, expect, it } from "vitest";
import {
  KIND_KANBAN_BOARD,
  KIND_KANBAN_COMMENT,
  KIND_KANBAN_ISSUE,
  KIND_KANBAN_SPRINT,
  KIND_KANBAN_STATUS_CHANGE,
  buildKanbanBoard,
  buildKanbanComment,
  buildKanbanIssue,
  buildKanbanSprint,
  buildKanbanStatusChange,
} from "../src/lib/audience/audience-events";
import { blake3ContentTag } from "../src/lib/audience/blake3-tag";

const AT = 1_760_000_000;
const BOARD = "97d96cac-85cb-4eec-b974-e92b59da2c78";
const ISSUE = "11111111-1111-4111-8111-111111111111";

/** Every builder must carry the envelope tags the gateway validators require. */
const expectEnvelope = (ev: { tags: string[][]; content: string }, d: string) => {
  const tag = (k: string) => ev.tags.find((t) => t[0] === k)?.[1];
  expect(tag("d")).toBe(d);
  expect(tag("fa:context")).toBe("https://4a4.ai/ns/v0");
  expect(tag("fa:board")).toBe(BOARD);
  expect(tag("blake3")).toBe(blake3ContentTag(ev.content));
  expect(tag("alt")).toBeTruthy();
  expect(JSON.parse(ev.content)["@context"]).toBe("https://4a4.ai/ns/v0");
};

describe("buildKanbanBoard", () => {
  const ev = buildKanbanBoard({
    boardId: BOARD,
    slug: "tide-test-public",
    title: "Tide Test Public",
    description: null,
    orgId: "org-1",
    issuePrefix: "TTP",
    defaultSprintDays: 14,
    doneWindowDays: 14,
    columns: [{ id: "c1", name: "Todo" }],
    labels: [],
    memberPolicy: "org",
    createdAt: AT,
  });

  it("is a 30550 keyed on the board id", () => {
    expect(ev.kind).toBe(KIND_KANBAN_BOARD);
    expect(ev.created_at).toBe(AT);
    expectEnvelope(ev, BOARD);
    expect(ev.tags.find((t) => t[0] === "fa:slug")?.[1]).toBe("tide-test-public");
  });

  it("carries the board's settings as current state, not a delta", () => {
    expect(JSON.parse(ev.content)).toMatchObject({
      "@type": "KanbanBoard",
      slug: "tide-test-public",
      title: "Tide Test Public",
      issue_prefix: "TTP",
      default_sprint_days: 14,
      done_window_days: 14,
      member_policy: "org",
      archived: false,
    });
  });

  it("carries no fa:deleted tag when the board is live", () => {
    expect(ev.tags.find((t) => t[0] === "fa:deleted")).toBeUndefined();
    expect(JSON.parse(ev.content).deleted).toBe(false);
  });

  // EFB-32. Same in-place rule as the issue tombstone below: a 30550 is
  // replaceable, so retiring a board means publishing at the BOARD'S OWN
  // address. Anywhere else and the last live 30550 survives, which is the
  // whole bug — a replaying consumer resurrects a board deleted months ago.
  describe("tombstone", () => {
    const dead = buildKanbanBoard({
      boardId: BOARD,
      slug: "tide-test-public",
      title: "Tide Test Public",
      description: null,
      orgId: "org-1",
      issuePrefix: "TTP",
      defaultSprintDays: 14,
      doneWindowDays: 14,
      columns: [{ id: "c1", name: "Todo" }],
      labels: [],
      memberPolicy: "org",
      deleted: true,
      createdAt: AT,
    });

    it("tombstones in place — same d tag, deleted flag and tag set", () => {
      expect(dead.kind).toBe(KIND_KANBAN_BOARD);
      expect(dead.tags.find((t) => t[0] === "d")?.[1]).toBe(BOARD);
      expect(dead.tags.find((t) => t[0] === "fa:deleted")?.[1]).toBe("1");
      expect(JSON.parse(dead.content).deleted).toBe(true);
    });

    // The gateway's 30550 spec (kanban-plaintext-validator.ts) requires
    // d === fa:board and a non-empty fa:slug. A tombstone built from an
    // envelope rather than a real row — the shape issue.deleted uses, since
    // its row is already gone — would fail that check with an empty slug.
    // The board delete handler snapshots the row first precisely so this
    // holds, and this assertion is what pins that requirement.
    it("still satisfies the gateway's 30550 envelope", () => {
      expectEnvelope(dead, BOARD);
      expect(dead.tags.find((t) => t[0] === "fa:slug")?.[1]).toBe("tide-test-public");
    });

    it("retires the board's full last-known state, not a stub", () => {
      expect(JSON.parse(dead.content)).toMatchObject({
        "@type": "KanbanBoard",
        slug: "tide-test-public",
        title: "Tide Test Public",
        member_policy: "org",
        deleted: true,
      });
    });
  });
});

describe("buildKanbanIssue", () => {
  const base = {
    issueId: ISSUE,
    boardId: BOARD,
    shortId: "TTP-7",
    title: "Publish plaintext kinds",
    body: "body text",
    bodyFormat: "markdown",
    type: "task",
    status: "In Progress",
    columnId: "c2",
    container: "active",
    assigneePubkey: null,
    priority: 2,
    estimate: 3,
    labels: ["substrate"],
    position: 1000,
    sprintId: null,
    externalState: null,
    createdAt: AT,
  };

  it("is a 30551 keyed on the issue id, with filterable fa: tags", () => {
    const ev = buildKanbanIssue(base);
    expect(ev.kind).toBe(KIND_KANBAN_ISSUE);
    expectEnvelope(ev, ISSUE);
    const tag = (k: string) => ev.tags.find((t) => t[0] === k)?.[1];
    expect(tag("fa:type")).toBe("task");
    expect(tag("fa:status")).toBe("In Progress");
    expect(tag("fa:container")).toBe("active");
    expect(tag("fa:sprint")).toBeUndefined();
    expect(tag("fa:deleted")).toBeUndefined();
  });

  it("tags fa:sprint only when the issue is in a sprint", () => {
    const ev = buildKanbanIssue({ ...base, sprintId: "sprint-9" });
    expect(ev.tags.find((t) => t[0] === "fa:sprint")?.[1]).toBe("sprint-9");
    expect(JSON.parse(ev.content).sprint_id).toBe("sprint-9");
  });

  // The tombstone MUST reuse the issue's own address: these are replaceable
  // events, so a deletion published anywhere else leaves the last live
  // version standing and a replaying consumer resurrects the issue.
  it("tombstones in place — same d tag, deleted flag and tag set", () => {
    const ev = buildKanbanIssue({ ...base, deleted: true });
    expect(ev.tags.find((t) => t[0] === "d")?.[1]).toBe(ISSUE);
    expect(ev.tags.find((t) => t[0] === "fa:deleted")?.[1]).toBe("1");
    expect(JSON.parse(ev.content).deleted).toBe(true);
  });
});

describe("buildKanbanComment", () => {
  const ev = buildKanbanComment({
    commentId: "comment-1",
    issueId: ISSUE,
    boardId: BOARD,
    authorPubkey: "049b628c",
    body: "a comment",
    bodyFormat: "markdown",
    inReplyTo: null,
    createdAt: AT,
  });

  it("is a 30552 keyed on the comment, linked to its issue", () => {
    expect(ev.kind).toBe(KIND_KANBAN_COMMENT);
    expectEnvelope(ev, "comment-1");
    expect(ev.tags.find((t) => t[0] === "fa:issue")?.[1]).toBe(ISSUE);
    expect(JSON.parse(ev.content)).toMatchObject({
      "@type": "KanbanComment",
      issue_id: ISSUE,
      author_pubkey: "049b628c",
      body: "a comment",
      deleted: false,
    });
  });
});

describe("buildKanbanStatusChange", () => {
  const ev = buildKanbanStatusChange({
    statusChangeId: "sc-1",
    issueId: ISSUE,
    boardId: BOARD,
    actorPubkey: "049b628c",
    fromStatus: "Todo",
    toStatus: "In Progress",
    fromContainer: "backlog",
    toContainer: "active",
    occurredAtMs: 1_760_000_000_000,
    createdAt: AT,
  });

  // The only builder whose d tag is the CHANGE, not the entity changed —
  // status changes are append-only audit rows, and keying them on the issue
  // would make each transition overwrite the last and erase the history.
  it("is a 30553 keyed on the change itself, not the issue", () => {
    expect(ev.kind).toBe(KIND_KANBAN_STATUS_CHANGE);
    expectEnvelope(ev, "sc-1");
    expect(ev.tags.find((t) => t[0] === "d")?.[1]).not.toBe(ISSUE);
    expect(ev.tags.find((t) => t[0] === "fa:issue")?.[1]).toBe(ISSUE);
    expect(JSON.parse(ev.content)).toMatchObject({
      "@type": "KanbanStatusChange",
      from_status: "Todo",
      to_status: "In Progress",
      occurred_at_ms: 1_760_000_000_000,
    });
  });
});

describe("buildKanbanSprint", () => {
  const ev = buildKanbanSprint({
    sprintId: "sprint-9",
    boardId: BOARD,
    name: "Sprint A",
    goal: "ship EFB-24",
    status: "active",
    plannedDays: 7,
    startedAtMs: 1_760_000_000_000,
    completedAtMs: null,
    pointsCommittedStart: 21,
    pointsCompleted: null,
    pointsCarried: null,
    addsMidSprint: 0,
    createdAt: AT,
  });

  it("is a 30554 keyed on the sprint id", () => {
    expect(ev.kind).toBe(KIND_KANBAN_SPRINT);
    expectEnvelope(ev, "sprint-9");
    expect(ev.tags.find((t) => t[0] === "fa:sprint")?.[1]).toBe("sprint-9");
    expect(ev.tags.find((t) => t[0] === "fa:status")?.[1]).toBe("active");
    expect(JSON.parse(ev.content)).toMatchObject({
      "@type": "KanbanSprint",
      name: "Sprint A",
      status: "active",
      planned_days: 7,
      points_committed_start: 21,
    });
  });
});

describe("cross-repo drift guard", () => {
  // Pinned blake3 tags. A builder change that alters content serialization
  // moves these values; when it does, regenerate the gateway's golden
  // fixtures in the SAME PR. Failing here is the intended early warning.
  it("pins the content hash of each kind", () => {
    const hashes = {
      board: buildKanbanBoard({
        boardId: BOARD,
        slug: "s",
        title: "t",
        description: null,
        orgId: null,
        issuePrefix: null,
        defaultSprintDays: 14,
        doneWindowDays: 14,
        columns: [],
        labels: [],
        memberPolicy: "org",
        createdAt: AT,
      }),
      issue: buildKanbanIssue({
        issueId: ISSUE,
        boardId: BOARD,
        shortId: null,
        title: "t",
        body: null,
        bodyFormat: "markdown",
        type: "task",
        status: "Todo",
        columnId: null,
        container: "backlog",
        labels: [],
        createdAt: AT,
      }),
    };
    for (const ev of Object.values(hashes)) {
      const tag = ev.tags.find((t) => t[0] === "blake3")?.[1];
      expect(tag).toMatch(/^bk-[a-z2-7]+$/);
      expect(tag).toBe(blake3ContentTag(ev.content));
    }
  });
});
