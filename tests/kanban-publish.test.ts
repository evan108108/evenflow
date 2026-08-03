// EFB-24 Phase 3: the plaintext publish fork inside emitSecureBoardEvent.
//
// The assertions that matter most here are the NEGATIVE ones. A board can be
// in three states, and only one of them may reach a public relay:
//
//   public                        → publish 30550-30554
//   private, audience minted      → encrypted wraps only (30555-30557)
//   private, NO audience yet      → publish NOTHING
//
// That third state is where every board starts, so a gate written as
// `!encryption_active` — which is what the EFB-24 brief originally specified
// and what EFB-22 shipped — pushes private issue titles and comment bodies to
// the substrate in cleartext. The "stays silent" tests below are the
// regression guard for exactly that.

import { describe, expect, it } from "vitest";
import { url } from "../src/routes-manifest";
import {
  bearer,
  createBoard,
  createIssue,
  createPublicBoard,
  jsonReq,
  makeHarness,
  seedBoardMember,
  CALLER,
  type Harness,
} from "./harness";
import { generateEpochKeypair } from "../src/lib/audience/audience-keys";
import { KANBAN_PLAINTEXT_PATH, publishesPlaintext } from "../src/lib/kanban/publish";
import type { BoardShape } from "../src/shapes";

/** Minting an audience needs a registered session key (same as tide-publish). */
const registerKey = async (h: Harness, sessionPub: string) => {
  const res = await h.app.request(
    url("session.key.register"),
    jsonReq("POST", { session_pubkey: sessionPub }),
    {},
  );
  expect(res.status).toBe(201);
};

/**
 * Yield once before asserting. The publish is awaited inside the request now,
 * so this is belt-and-braces rather than load-bearing — it stays because it
 * costs nothing and keeps these assertions correct if the publish ever moves
 * off the request path again (see the fork comment in audiences.ts).
 */
const settle = () => new Promise((r) => setTimeout(r, 0));

const plaintextPosts = (h: { audience: { calls: Array<{ path: string; body: unknown }> } }) =>
  h.audience.calls.filter((c) => c.path === KANBAN_PLAINTEXT_PATH);

const board = (over: Partial<BoardShape>): BoardShape =>
  ({ id: "b", visibility: "private", encryption_active: false, ...over }) as BoardShape;

describe("publishesPlaintext", () => {
  it("admits only a genuinely public board", () => {
    expect(publishesPlaintext(board({ visibility: "public" }))).toBe(true);
  });

  // The whole point. `encryption_active` is false here too, so a gate written
  // against it would let this board through.
  it("rejects a private board that has not minted an audience", () => {
    expect(publishesPlaintext(board({ visibility: "private", encryption_active: false }))).toBe(
      false,
    );
  });

  it("rejects an encrypted board", () => {
    expect(publishesPlaintext(board({ visibility: "private", encryption_active: true }))).toBe(
      false,
    );
  });

  // An unreadable board row is an availability failure, not a public board.
  it("fails closed when the board could not be loaded", () => {
    expect(publishesPlaintext(null)).toBe(false);
  });
});

describe("public board — plaintext kanban publish", () => {
  it("publishes a 30551 for a new issue and stamps issueCache", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h, { title: "Open work" });
    await settle();

    const posts = plaintextPosts(h);
    expect(posts.length).toBeGreaterThanOrEqual(1);
    const issuePost = posts
      .map((p) => (p.body as { event: { id: string; kind: number; tags: string[][] } }).event)
      .find((e) => e.kind === 30551);
    expect(issuePost).toBeDefined();
    expect(issuePost!.tags.find((t) => t[0] === "d")?.[1]).toBe(issue.id);

    const row = h.db.issues.find((r) => r["id"] === issue.id)!;
    expect(row["substrate_event_id"]).toBe(issuePost!.id);
  });

  it("publishes a 30550 when the board itself is created public", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    await settle();

    const kinds = plaintextPosts(h).map((p) => (p.body as { event: { kind: number } }).event.kind);
    expect(kinds).toContain(30550);
  });

  it("publishes a 30552 for a comment", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h);
    await h.app.request(
      url("comment.create", { id: issue.id }),
      jsonReq("POST", { body: "a comment" }),
      {},
    );
    await settle();

    const kinds = plaintextPosts(h).map((p) => (p.body as { event: { kind: number } }).event.kind);
    expect(kinds).toContain(30552);
  });

  it("leaves substrate_event_id NULL when the gateway is down", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    h.audience.flags.failPosts = true;
    const issue = await createIssue(h, { title: "Unpublished" });
    await settle();

    // The mutation itself must not care that the substrate was unreachable.
    const row = h.db.issues.find((r) => r["id"] === issue.id)!;
    expect(row["substrate_event_id"] ?? null).toBeNull();
  });

  it("publishes nothing when EVENFLOW_KANBAN_SECRET is unset", async () => {
    const h = makeHarness();
    h.audience.flags.noKanbanKey = true;
    await createPublicBoard(h);
    await createIssue(h);
    await settle();

    expect(plaintextPosts(h)).toHaveLength(0);
  });
});

describe("private board — stays silent", () => {
  // THE regression test. This board has encryption_active === false, which is
  // exactly what makes the naive gate wrong.
  it("publishes NOTHING for a board that is private with no audience", async () => {
    const h = makeHarness();
    await createBoard(h); // born private, audience never minted
    const issue = await createIssue(h, { title: "Confidential title" });
    await h.app.request(
      url("comment.create", { id: issue.id }),
      jsonReq("POST", { body: "confidential comment" }),
      {},
    );
    await settle();

    expect(plaintextPosts(h)).toHaveLength(0);
    const row = h.db.issues.find((r) => r["id"] === issue.id)!;
    expect(row["substrate_event_id"] ?? null).toBeNull();
  });

  it("does not regress the encrypted path for a board with an audience", async () => {
    const h = makeHarness();
    const session = generateEpochKeypair();
    await registerKey(h, session.pub);
    await createBoard(h);
    const flip = await h.app.request(
      url("board.get", { slug: "kb" }),
      jsonReq("PATCH", { visibility: "private" }),
      {},
    );
    expect(flip.status).toBe(200);

    await createIssue(h, { title: "Secret work" });
    await settle();

    // Encrypted wraps still go out on their own path…
    expect(h.audience.calls.some((c) => c.path.includes("publish-wraps"))).toBe(true);
    // …and nothing went to the plaintext route.
    expect(plaintextPosts(h)).toHaveLength(0);
  });
});

describe("board visibility flip", () => {
  it("starts publishing only once the board is flipped public", async () => {
    const h = makeHarness();
    await createBoard(h);
    await createIssue(h, { title: "Written while private" });
    await settle();
    expect(plaintextPosts(h)).toHaveLength(0);

    const flip = await h.app.request(
      url("board.get", { slug: "kb" }),
      jsonReq("PATCH", { visibility: "public" }),
      {},
    );
    expect(flip.status).toBe(200);
    await settle();

    // The flip itself is a board.updated → 30550.
    const kinds = plaintextPosts(h).map((p) => (p.body as { event: { kind: number } }).event.kind);
    expect(kinds).toContain(30550);
  });
});

// EFB-32. Deleting a public board used to leave its last live 30550 standing
// on the substrate forever, so a consumer replaying the log resurrected a board
// that no longer exists. The naive fix publishes nothing at all: the fork inside
// emitSecureBoardEvent re-reads the board to decide whether it may publish, and
// board.deleted is the one kind whose subject IS the row being deleted, so the
// read fails closed every time. The handler passes its pre-delete snapshot
// instead — these tests are what stop that parameter being "simplified" away.
describe("board delete — 30550 tombstone", () => {
  const deleteBoard = (h: Harness, slug = "kb") =>
    h.app.request(url("board.get", { slug: slug }), { method: "DELETE", headers: bearer }, {});

  const boardEvents = (h: Harness) =>
    plaintextPosts(h)
      .map((p) => (p.body as { event: { id: string; kind: number; tags: string[][] } }).event)
      .filter((e) => e.kind === 30550);

  it("publishes a tombstone at the board's own address", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const boardId = h.db.boards.find((r) => r["slug"] === "kb")!["id"];
    await settle();

    expect((await deleteBoard(h)).status).toBe(200);
    await settle();

    const tombstone = boardEvents(h).at(-1)!;
    expect(tombstone.tags.find((t) => t[0] === "fa:deleted")?.[1]).toBe("1");
    // Same address as the live 30550 the board create published — that is what
    // makes it supersede rather than sit alongside.
    expect(tombstone.tags.find((t) => t[0] === "d")?.[1]).toBe(boardId);
    expect(boardEvents(h)[0]!.tags.find((t) => t[0] === "d")?.[1]).toBe(boardId);
  });

  it("supersedes the live board event — the tombstone is the last 30550", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    await h.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", { title: "Renamed" }), {});
    await settle();
    const beforeDelete = boardEvents(h);
    expect(beforeDelete.length).toBeGreaterThanOrEqual(2);
    expect(beforeDelete.every((e) => e.tags.every((t) => t[0] !== "fa:deleted"))).toBe(true);

    await deleteBoard(h);
    await settle();

    const after = boardEvents(h);
    expect(after).toHaveLength(beforeDelete.length + 1);
    expect(after.at(-1)!.tags.find((t) => t[0] === "fa:deleted")?.[1]).toBe("1");
  });

  // The regression this ticket exists to prevent reintroducing: before EFB-32
  // the delete handler emitted nothing at all.
  it("actually reaches the substrate rather than being swallowed", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    await settle();
    const before = boardEvents(h).length;

    await deleteBoard(h);
    await settle();

    expect(boardEvents(h).length).toBe(before + 1);
  });

  // Board delete deliberately does NOT cascade to issueCache (boards.ts: "soft
  // FKs; issues orphan, a v2 cleanup path reaps them"). Tombstoning those
  // issues would tell the substrate they are gone while they still serve over
  // REST — a lie in the opposite direction from the bug being fixed. The
  // mirror stays faithful to what D1 actually holds.
  it("does not tombstone issues or comments the delete leaves behind", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h, { title: "Orphaned by the delete" });
    await h.app.request(url("comment.create", { id: issue.id }), jsonReq("POST", { body: "c" }), {});
    await settle();

    await deleteBoard(h);
    await settle();

    const tombstoned = plaintextPosts(h)
      .map((p) => (p.body as { event: { kind: number; tags: string[][] } }).event)
      .filter((e) => e.tags.some((t) => t[0] === "fa:deleted"));
    expect(tombstoned.map((e) => e.kind)).toEqual([30550]);
    // …and the rows really are still there, which is what makes that correct.
    expect(h.db.issues.some((r) => r["id"] === issue.id)).toBe(true);
  });

  it("still deletes the board when the gateway is down", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    await settle();
    h.audience.flags.failPosts = true;

    expect((await deleteBoard(h)).status).toBe(200);
    expect(h.db.boards.some((r) => r["slug"] === "kb")).toBe(false);
  });
});

describe("board delete — private boards", () => {
  const deleteBoard = (h: Harness) =>
    h.app.request(url("board.get", { slug: "kb" }), { method: "DELETE", headers: bearer }, {});

  // The snapshot feeds the SAME gate as every other emit, so the three-state
  // collapse this file exists to guard is still guarded on the delete path.
  it("publishes NOTHING for a board that is private with no audience", async () => {
    const h = makeHarness();
    await createBoard(h);
    await settle();

    expect((await deleteBoard(h)).status).toBe(200);
    await settle();

    expect(plaintextPosts(h)).toHaveLength(0);
  });

  // The encrypted tombstone is an ADDITION, not a change: a private board's
  // delete previously fired nothing here either, swallowed by the same failed
  // re-read. Fixing the re-read fixes both paths by construction — one fork,
  // no special-casing — so private consumers stop resurrecting dead boards too.
  it("gift-wraps an encrypted tombstone and leaks no cleartext", async () => {
    const h = makeHarness();
    const session = generateEpochKeypair();
    await registerKey(h, session.pub);
    await createBoard(h);
    const flip = await h.app.request(
      url("board.get", { slug: "kb" }),
      jsonReq("PATCH", { visibility: "private" }),
      {},
    );
    expect(flip.status).toBe(200);
    await settle();
    const wrapsBefore = h.audience.calls.filter((c) => c.path.includes("publish-wraps")).length;

    await deleteBoard(h);
    await settle();

    expect(h.audience.calls.filter((c) => c.path.includes("publish-wraps")).length).toBe(
      wrapsBefore + 1,
    );
    expect(plaintextPosts(h)).toHaveLength(0);
  });
});

describe("tide publish — EFB-22 gate fix", () => {
  // EFB-22 shipped `board === null || board.encryption_active`, so a private
  // board with no audience published its committed/done/remaining points as a
  // cleartext 30560. Same three-state collapse, same fix, shared predicate.
  it("does not publish a 30560 for a private board with no audience", async () => {
    const h = makeHarness();
    await createBoard(h);

    const res = await h.app.request(url("board.tide", { slug: "kb" }), { headers: bearer }, {});
    expect(res.status).toBe(200);
    await settle();

    expect(h.audience.calls.filter((c) => c.path.includes("kanban_tide"))).toHaveLength(0);
  });
});

// EFB-33: the fifth kind. EFB-24 shipped four of five because the
// statusChangeCache row id was generated inside insertStatusChange and thrown
// away — and a 30553 keys on that id (it is the `d` tag), so there was
// nothing to sign against. Threading it out is the whole ticket.
describe("EFB-33 — 30553 KanbanStatusChange", () => {
  const eventsOf = (h: Harness) =>
    plaintextPosts(h).map(
      (p) => (p.body as { event: { id: string; kind: number; tags: string[][]; content: string } }).event,
    );
  const kindsOf = (h: Harness) => eventsOf(h).map((e) => e.kind);
  const transition = (h: Harness, id: string, to: string) =>
    h.app.request(url("issue.transition", { id: id }), jsonReq("POST", { to }), {});

  it("publishes a 30553 on a public-board transition and stamps statusChangeCache", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h, { title: "Ship it" });
    await settle();

    const res = await transition(h, issue.id, "In Progress");
    expect(res.status).toBe(200);
    await settle();

    // Select the 30553 BY ITS ROW, not by position. EFB-56 made creation
    // publish a 30553 of its own (the null → first-column change), so "the
    // first 30553" is no longer this transition's — it is the creation's. The
    // row identity was always the right key; taking [0] only worked while
    // transitions were the sole publisher.
    const row = h.db.statusChanges.find((r) => r["to_status"] === "In Progress")!;
    expect(row).toBeDefined();
    const change = eventsOf(h).find(
      (e) => e.kind === 30553 && e.tags.find((t) => t[0] === "d")?.[1] === row["id"],
    );
    expect(change).toBeDefined();
    expect(row["substrate_event_id"]).toBe(change!.id);
  });

  // The fan-out is the point of the templatesFor change: a transition is BOTH
  // the issue's new state and the change record. Publishing one INSTEAD of the
  // other is the regression this pins.
  it("publishes the 30551 alongside it, not instead of it", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h);
    await settle();
    const before = plaintextPosts(h).length;

    await transition(h, issue.id, "In Progress");
    await settle();

    const emitted = eventsOf(h).slice(before);
    expect(emitted.map((e) => e.kind).sort()).toEqual([30551, 30553]);

    // and BOTH rows got stamped, with different event ids.
    // NB: creating an issue ALSO writes a statusChangeCache row (null → first
    // column), so select the transition's row by to_status rather than by
    // issue_id — the first match would be the creation row, which publishes no
    // 30553 and would make this look like a stamping failure.
    const issueRow = h.db.issues.find((r) => r["id"] === issue.id)!;
    const changeRow = h.db.statusChanges.find((r) => r["to_status"] === "In Progress")!;
    expect(issueRow["substrate_event_id"]).toBe(emitted.find((e) => e.kind === 30551)!.id);
    expect(changeRow["substrate_event_id"]).toBe(emitted.find((e) => e.kind === 30553)!.id);
    expect(issueRow["substrate_event_id"]).not.toBe(changeRow["substrate_event_id"]);
  });

  // Attribution. actor_pubkey is WHO MOVED THE CARD; assignee_pubkey is who
  // owns the work. Reading the assignee here would publish a signed, public
  // event attributing the change to the wrong person — and it would typecheck.
  it("attributes the change to the actor, not the assignee", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const stranger = "nostr:1111111111111111111111111111111111111111111111111111111111111111";
    const issue = await createIssue(h);
    seedBoardMember(h, h.db.boards[0]!["id"] as string, stranger, "contributor");
    await h.app.request(
      url("issue.get", { id: issue.id }),
      jsonReq("PATCH", { assignee_pubkey: stranger }),
      {},
    );
    await settle();

    await transition(h, issue.id, "In Progress");
    await settle();

    const change = eventsOf(h).find((e) => e.kind === 30553)!;
    const content = JSON.parse(change.content) as { actor_pubkey: string };
    expect(content.actor_pubkey).toBe(CALLER);
    expect(content.actor_pubkey).not.toBe(stranger);
  });

  it("publishes a 30553 for a container move", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h);
    await settle();

    await h.app.request(`/api/v0/issues/${issue.id}/send_to_icebox`, jsonReq("POST", {}), {});
    await settle();

    // By row, not by position — creation now publishes a 30553 of its own
    // (EFB-56), so [0] would be the creation's, whose to_container is where the
    // issue was born rather than where this move sent it.
    const row = h.db.statusChanges.find((r) => r["to_container"] === "icebox")!;
    expect(row).toBeDefined();
    const change = eventsOf(h).find(
      (e) => e.kind === 30553 && e.tags.find((t) => t[0] === "d")?.[1] === row["id"],
    )!;
    expect(change).toBeDefined();
    const content = JSON.parse(change.content) as {
      from_container: string;
      to_container: string;
    };
    expect(content.to_container).toBe("icebox");
  });

  // A no-op transition writes no statusChangeCache row and emits no event.
  // Nothing to publish is not the same as something failing to publish.
  it("publishes no 30553 when the transition is a no-op", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h);
    await settle();
    const before = plaintextPosts(h).length;

    await transition(h, issue.id, issue.status);
    await settle();

    expect(kindsOf(h).slice(before)).not.toContain(30553);
  });

  // THE REGRESSION GUARD, and the one that matters most: a private board must
  // never put a status change on a public relay in cleartext.
  it("publishes NOTHING in plaintext when the board is private", async () => {
    const h = makeHarness();
    await createBoard(h); // born private, no audience
    const issue = await createIssue(h, { title: "Confidential" });
    await transition(h, issue.id, "In Progress");
    await settle();

    expect(plaintextPosts(h)).toHaveLength(0);
    const changeRow = h.db.statusChanges.find((r) => r["issue_id"] === issue.id);
    expect(changeRow?.["substrate_event_id"] ?? null).toBeNull();
  });

  it("keeps a private board with an audience on the encrypted path", async () => {
    const h = makeHarness();
    const session = generateEpochKeypair();
    await registerKey(h, session.pub);
    await createBoard(h);
    expect(
      (await h.app.request(url("board.get", { slug: "kb" }), jsonReq("PATCH", { visibility: "private" }), {}))
        .status,
    ).toBe(200);
    const issue = await createIssue(h, { title: "Secret" });
    await transition(h, issue.id, "In Progress");
    await settle();

    expect(h.audience.calls.some((c) => c.path.includes("publish-wraps"))).toBe(true);
    expect(plaintextPosts(h)).toHaveLength(0);
  });

  // Best-effort is per item: a gateway failure on one must not un-publish or
  // un-stamp the other.
  it("leaves both substrate ids NULL when the gateway is down", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h);
    await settle();
    h.audience.flags.failPosts = true;

    const res = await transition(h, issue.id, "In Progress");
    expect(res.status).toBe(200); // the mutation does not care
    await settle();

    // The TRANSITION's row specifically. Since EFB-56 the issue already has a
    // creation-time row, and that one was published normally — it happened
    // before `failPosts` was set, so it carries a substrate id. Asserting on
    // "the first row for this issue" would now be asserting about the wrong
    // event entirely, and would fail for a reason unrelated to the gateway.
    const changeRow = h.db.statusChanges.find(
      (r) => r["issue_id"] === issue.id && r["to_status"] === "In Progress",
    )!;
    expect(changeRow).toBeDefined();
    expect(changeRow["substrate_event_id"] ?? null).toBeNull();
  });

  // ── EFB-56 — creation is a status change too ──────────────────────────
  //
  // Creation writes a real null → first-column statusChangeCache row, but the
  // id used to be discarded at the creation callsite, so `issue.created`
  // referenced nothing and the publish path had no 30553 to fan out. The
  // consequence was semantic, not cosmetic: the substrate's audit trail for an
  // issue began at its FIRST TRANSITION. The one status change every issue is
  // guaranteed to have was the one guaranteed never to be published.

  it("publishes BOTH the 30551 and a 30553 when an issue is created", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h, { title: "Born in Todo" });
    await settle();

    const kinds = kindsOf(h);
    expect(kinds).toContain(30551);
    expect(kinds).toContain(30553);
  });

  it("keys the creation 30553 to the null-to-first-column row via its d tag", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h, { title: "Born in Todo" });
    await settle();

    // The creation row is the one with no prior status. Identified by that
    // rather than by position, for the same reason the tests above were
    // rewritten: position stops meaning what you think once a second row can
    // exist for the same issue.
    const row = h.db.statusChanges.find(
      (r) => r["issue_id"] === issue.id && r["from_status"] === null,
    )!;
    expect(row).toBeDefined();

    const change = eventsOf(h).find(
      (e) => e.kind === 30553 && e.tags.find((t) => t[0] === "d")?.[1] === row["id"],
    );
    expect(change).toBeDefined();

    // Stamped back, exactly as a transition's row is — this is what proves the
    // id survived the whole round trip rather than merely being generated.
    expect(row["substrate_event_id"]).toBe(change!.id);
  });

  it("carries the creation's from/to on the published 30553", async () => {
    const h = makeHarness();
    await createPublicBoard(h);
    const issue = await createIssue(h, { title: "Born in Todo" });
    await settle();

    const row = h.db.statusChanges.find(
      (r) => r["issue_id"] === issue.id && r["from_status"] === null,
    )!;
    const change = eventsOf(h).find(
      (e) => e.kind === 30553 && e.tags.find((t) => t[0] === "d")?.[1] === row["id"],
    )!;
    const content = JSON.parse(change.content) as {
      from_status: string | null;
      to_status: string | null;
    };

    // from_status null is the whole point: this is the null → first-column
    // change, and an event that lost it would be indistinguishable from an
    // ordinary transition.
    expect(content.from_status).toBeNull();
    expect(content.to_status).toBe(row["to_status"]);
  });
});
