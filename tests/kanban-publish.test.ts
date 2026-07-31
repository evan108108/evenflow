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
import {
  bearer,
  createBoard,
  createIssue,
  createPublicBoard,
  jsonReq,
  makeHarness,
  type Harness,
} from "./harness";
import { generateEpochKeypair } from "../src/lib/audience/audience-keys";
import { KANBAN_PLAINTEXT_PATH, publishesPlaintext } from "../src/lib/kanban/publish";
import type { BoardShape } from "../src/shapes";

/** Minting an audience needs a registered session key (same as tide-publish). */
const registerKey = async (h: Harness, sessionPub: string) => {
  const res = await h.app.request(
    "/api/v0/session/register-key",
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
      `/api/v0/issues/${issue.id}/comments`,
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
      `/api/v0/issues/${issue.id}/comments`,
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
      "/api/v0/boards/kb",
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
      "/api/v0/boards/kb",
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

describe("tide publish — EFB-22 gate fix", () => {
  // EFB-22 shipped `board === null || board.encryption_active`, so a private
  // board with no audience published its committed/done/remaining points as a
  // cleartext 30560. Same three-state collapse, same fix, shared predicate.
  it("does not publish a 30560 for a private board with no audience", async () => {
    const h = makeHarness();
    await createBoard(h);

    const res = await h.app.request("/api/v0/boards/kb/tide", { headers: bearer }, {});
    expect(res.status).toBe(200);
    await settle();

    expect(h.audience.calls.filter((c) => c.path.includes("kanban_tide"))).toHaveLength(0);
  });
});
