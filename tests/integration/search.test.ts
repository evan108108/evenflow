// EFB-14 — search, proven against a real FTS5 index in a real D1.
//
// WHY THIS FILE IS IN THE INTEGRATION LANE
//
// Every interesting claim search makes is a claim about SQLite: that migration
// 0027's triggers actually populate the index, that BM25 orders results the
// way we say, that `board_id` in the FTS table actually scopes a MATCH. None
// of that is testable against tests/dbMock.ts, which interprets a subset of
// SQL and has no FTS5 in it at all. A unit test here would assert the mock's
// opinion of a virtual table it does not implement — the exact shape of the
// EFB-35 bug this lane was built to prevent (see harness.ts).
//
// So: real Worker, real D1, real migrations including 0027, real HTTP, real
// auth, real authorization. The pure query-builder half is unit-tested
// separately in tests/search-query.test.ts.
//
// WHAT EACH GROUP PROVES
//
//   round-trip   the triggers fire on insert/update/delete, and the index
//                converges on the source tables rather than drifting. This is
//                the failure mode that motivated standalone (rather than
//                external-content) FTS5 tables in 0027 — drift is silent.
//   ranking      BM25 is applied and better matches sort first.
//   scoping      a board's search never returns another board's rows.
//   authz        a private board's text is unreachable to a non-member, and
//                the board gate runs BEFORE the index is read.
//
// The authz group is the one that matters most. The FTS tables contain
// plaintext from private boards by design (0027's header explains why that is
// both necessary and safe), which means the route's board gate is the ONLY
// thing standing between a non-member and that text. If these cases ever go
// green while returning rows, the index has become a bypass.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mintToken, startStack, type SeededBoard, type Stack } from "./harness";

/** Booting the Worker runtime + migrating a fresh D1 is slow by nature. */
const BOOT_TIMEOUT_MS = 180_000;

interface ErrorBody {
  readonly error: string;
  readonly reason?: string;
}

interface IssueHit {
  readonly issue: { readonly id: string; readonly title: string; readonly body: string | null };
  readonly rank: number;
}

interface CommentHit {
  readonly comment: { readonly id: string; readonly body: string };
  readonly issue_id: string;
  readonly issue_title: string | null;
  readonly issue_short_id: string | null;
  readonly rank: number;
}

interface SearchBody {
  readonly issues: IssueHit[];
  readonly comments: CommentHit[];
}

interface Issue {
  readonly id: string;
  readonly short_id: string;
}

describe("search — FTS5 over a real D1 (live route, live index)", () => {
  let stack: Stack;

  const aliceToken = mintToken("alice");
  // Bob is a real, authenticated user with a board of his own — not an
  // anonymous stranger. The interesting failure is one tenant reaching
  // another's text.
  const bobToken = mintToken("bob");

  let alice: SeededBoard;
  let bob: SeededBoard;
  let secret: SeededBoard;

  let widgetIssue: Issue;
  let bobIssue: Issue;
  let secretIssue: Issue;
  let commentedIssue: Issue;
  let commentId: string;

  /** The word that only ever appears on Alice's PRIVATE board. */
  const SECRET_TERM = "zarquon";

  /**
   * Create a board at an EXPLICIT visibility.
   *
   * The shared `seedBoard` helper posts `{slug, title}`, and POST /boards
   * defaults an omitted visibility to `private` (boards.ts: "private is the
   * default … but a fresh board still lands in the 'private but not yet
   * encrypted' third state"). So the visibility has to be stated here, both
   * for the public boards — which would otherwise silently be private and
   * make every scoping assertion below vacuous — and for the private one.
   *
   * Private is set AT CREATE, deliberately not by PATCHing a public board
   * afterwards. That PATCH is the encryption flip: it mints an audience and
   * 409s with `audience-not-configured` when no audience server is wired up,
   * which is the case in this harness. Create-time private gives exactly the
   * board this feature has to get right anyway — `visibility: 'private'`,
   * `encryption_active: false`, bodies unambiguously plaintext in D1 — and
   * proves the ACL is what protects them, with no crypto in the picture to
   * be mistaken for the thing doing the work.
   */
  const seedBoardAt = async (
    token: string,
    slug: string,
    title: string,
    visibility: "public" | "private",
  ): Promise<SeededBoard> => {
    const res = await stack.api<{
      board: { id: string; slug: string; visibility: string };
      org: { slug: string };
    }>(token, "POST", "/api/v0/boards", { slug, title, visibility });
    if (res.status !== 201) {
      throw new Error(`seedBoardAt ${slug} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    if (res.body.board.visibility !== visibility) {
      throw new Error(
        `seedBoardAt ${slug}: asked for ${visibility}, got ${res.body.board.visibility}`,
      );
    }
    return {
      orgSlug: res.body.org.slug,
      boardSlug: res.body.board.slug,
      boardId: res.body.board.id,
      token,
    };
  };

  const createIssue = async (
    board: SeededBoard,
    title: string,
    body?: string,
  ): Promise<Issue> => {
    const res = await stack.api<{ issue: Issue }>(
      board.token,
      "POST",
      `/api/v0/orgs/${board.orgSlug}/boards/${board.boardSlug}/issues`,
      body === undefined ? { title } : { title, body },
    );
    if (res.status !== 201) {
      throw new Error(`createIssue failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.issue;
  };

  const search = (
    token: string | null,
    board: SeededBoard,
    q: string,
    limit?: number,
  ) =>
    stack.api<SearchBody & ErrorBody>(
      token,
      "POST",
      `/api/v0/orgs/${board.orgSlug}/boards/${board.boardSlug}/search`,
      limit === undefined ? { q } : { q, limit },
    );

  beforeAll(async () => {
    stack = await startStack();

    alice = await seedBoardAt(aliceToken, "alpha", "Alpha Board", "public");
    bob = await seedBoardAt(bobToken, "bravo", "Bravo Board", "public");
    // The board whose plaintext sits in the FTS index and must never reach Bob.
    secret = await seedBoardAt(aliceToken, "sealed", "Sealed Board", "private");

    // Alice's public board. "widget" appears in BOTH title and body of the
    // first issue and only in the body of the second — the ranking fixture.
    widgetIssue = await createIssue(alice, "Widget rendering is broken", "the widget misdraws");
    await createIssue(alice, "Sprint planning notes", "mentions a widget once, in passing");

    // Same distinctive word on Bob's board — the scoping fixture. If board
    // filtering fails, Alice's search finds this.
    bobIssue = await createIssue(bob, "Widget on another board", "bob's widget");

    // The private board's secret text.
    secretIssue = await createIssue(
      secret,
      `The ${SECRET_TERM} protocol`,
      `${SECRET_TERM} must not leak`,
    );

    // A comment, for the comment index. Its body carries a word that appears
    // in no issue, so a hit can only have come from commentCacheFts.
    commentedIssue = await createIssue(alice, "Discussion thread", "no distinctive words here");
    const posted = await stack.api<{ comment: { id: string } }>(
      aliceToken,
      "POST",
      `/api/v0/issues/${commentedIssue.id}/comments`,
      { body: "the flibbertigibbet behaviour needs a repro" },
    );
    if (posted.status !== 201) {
      throw new Error(`seed comment failed: ${posted.status} ${JSON.stringify(posted.body)}`);
    }
    commentId = posted.body.comment.id;
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.stop();
  });

  // ── the fixtures are what we think they are ────────────────────────────

  it("seeds three boards, two owners, one of them private", () => {
    expect(alice.boardId).not.toBe(bob.boardId);
    expect(alice.boardId).not.toBe(secret.boardId);
    expect(widgetIssue.id).not.toBe(bobIssue.id);
    expect(secretIssue.id).toBeTruthy();
    expect(commentId).toBeTruthy();
  });

  // ── round-trip: the triggers populate and maintain the index ───────────

  describe("index round-trip", () => {
    it("finds an issue created through the API — the insert trigger fired", async () => {
      const res = await search(aliceToken, alice, "widget");
      expect(res.status).toBe(200);
      expect(res.body.issues.length).toBeGreaterThan(0);
      expect(res.body.issues.map((h) => h.issue.id)).toContain(widgetIssue.id);
    });

    it("matches on body text, not just title", async () => {
      const res = await search(aliceToken, alice, "misdraws");
      expect(res.status).toBe(200);
      expect(res.body.issues.map((h) => h.issue.id)).toEqual([widgetIssue.id]);
    });

    it("finds a comment — the comment trigger fired and denormalized board_id", async () => {
      const res = await search(aliceToken, alice, "flibbertigibbet");
      expect(res.status).toBe(200);
      expect(res.body.comments.length).toBe(1);
      expect(res.body.comments[0]?.comment.id).toBe(commentId);
      // The hit carries enough to link to: this is why parents are hydrated.
      expect(res.body.comments[0]?.issue_id).toBe(commentedIssue.id);
      expect(res.body.comments[0]?.issue_title).toBe("Discussion thread");
      expect(res.body.comments[0]?.issue_short_id).toBe(commentedIssue.short_id);
    });

    it("tracks an edit: the old text stops matching and the new text starts", async () => {
      const issue = await createIssue(alice, "Original headline", "original prose");
      expect((await search(aliceToken, alice, "headline")).body.issues.length).toBe(1);

      const patched = await stack.api(
        aliceToken,
        "PATCH",
        `/api/v0/issues/${issue.id}`,
        { title: "Replacement caption" },
      );
      expect(patched.status).toBe(200);

      // Both directions matter. Only asserting the new term would pass even
      // if the update trigger inserted a duplicate and left the stale row.
      expect((await search(aliceToken, alice, "headline")).body.issues.length).toBe(0);
      const after = await search(aliceToken, alice, "caption");
      expect(after.body.issues.map((h) => h.issue.id)).toEqual([issue.id]);
    });

    it("does not duplicate a row when the same issue is edited twice", async () => {
      const issue = await createIssue(alice, "Duplication canary", "canary body");
      for (const title of ["Duplication canary v2", "Duplication canary v3"]) {
        const patched = await stack.api(aliceToken, "PATCH", `/api/v0/issues/${issue.id}`, {
          title,
        });
        expect(patched.status).toBe(200);
      }
      const res = await search(aliceToken, alice, "canary");
      expect(res.body.issues.filter((h) => h.issue.id === issue.id).length).toBe(1);
    });

    it("drops a deleted issue from the index", async () => {
      const issue = await createIssue(alice, "Ephemeral bugbear", "short-lived");
      expect((await search(aliceToken, alice, "bugbear")).body.issues.length).toBe(1);

      const deleted = await stack.api(aliceToken, "DELETE", `/api/v0/issues/${issue.id}`);
      expect([200, 204]).toContain(deleted.status);

      expect((await search(aliceToken, alice, "bugbear")).body.issues.length).toBe(0);
    });

    it("drops a deleted comment from the index", async () => {
      const issue = await createIssue(alice, "Comment deletion host", "host body");
      const posted = await stack.api<{ comment: { id: string } }>(
        aliceToken,
        "POST",
        `/api/v0/issues/${issue.id}/comments`,
        { body: "transient snollygoster remark" },
      );
      expect(posted.status).toBe(201);
      expect((await search(aliceToken, alice, "snollygoster")).body.comments.length).toBe(1);

      const deleted = await stack.api(
        aliceToken,
        "DELETE",
        `/api/v0/comments/${posted.body.comment.id}`,
      );
      expect([200, 204]).toContain(deleted.status);

      expect((await search(aliceToken, alice, "snollygoster")).body.comments.length).toBe(0);
    });
  });

  // ── ranking ────────────────────────────────────────────────────────────

  describe("BM25 ranking", () => {
    it("ranks the issue matching in title and body above the passing mention", async () => {
      const res = await search(aliceToken, alice, "widget");
      expect(res.status).toBe(200);
      expect(res.body.issues.length).toBeGreaterThanOrEqual(2);
      expect(res.body.issues[0]?.issue.id).toBe(widgetIssue.id);
    });

    it("returns rank ascending — FTS5 BM25, more negative is better", async () => {
      const res = await search(aliceToken, alice, "widget");
      const ranks = res.body.issues.map((h) => h.rank);
      expect(ranks.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < ranks.length; i += 1) {
        expect(ranks[i - 1]).toBeLessThanOrEqual(ranks[i] as number);
      }
    });

    it("requires every term — multi-term search is AND, not OR", async () => {
      // "widget" matches several issues; "misdraws" only one. The conjunction
      // must be the narrow set, not the union.
      const res = await search(aliceToken, alice, "widget misdraws");
      expect(res.body.issues.map((h) => h.issue.id)).toEqual([widgetIssue.id]);
    });

    it("honours limit, capped at the route's ceiling", async () => {
      const res = await search(aliceToken, alice, "widget", 1);
      expect(res.body.issues.length).toBe(1);

      // Above MAX_LIMIT is clamped, not rejected.
      const big = await search(aliceToken, alice, "widget", 5000);
      expect(big.status).toBe(200);
    });
  });

  // ── board scoping ──────────────────────────────────────────────────────

  describe("board scoping", () => {
    it("never returns another board's issue, even for an identical term", async () => {
      const res = await search(aliceToken, alice, "widget");
      expect(res.status).toBe(200);
      expect(res.body.issues.length).toBeGreaterThan(0);
      expect(res.body.issues.map((h) => h.issue.id)).not.toContain(bobIssue.id);
    });

    it("finds that same term on the board it does belong to", async () => {
      // Proves the previous assertion is the board filter working, not the
      // term being unfindable.
      const res = await search(bobToken, bob, "widget");
      expect(res.body.issues.map((h) => h.issue.id)).toEqual([bobIssue.id]);
    });
  });

  // ── authorization: the index must not become a bypass ──────────────────

  describe("private board text is unreachable to non-members", () => {
    it("lets the owner search their own private board", async () => {
      const res = await search(aliceToken, secret, SECRET_TERM);
      expect(res.status).toBe(200);
      expect(res.body.issues.map((h) => h.issue.id)).toEqual([secretIssue.id]);
    });

    it("answers 404 to another authenticated user — existence must not leak", async () => {
      const res = await search(bobToken, secret, SECRET_TERM);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not-found");
      expect(JSON.stringify(res.body)).not.toContain(SECRET_TERM);
    });

    it("answers 404 to an anonymous caller", async () => {
      const res = await search(null, secret, SECRET_TERM);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(SECRET_TERM);
    });

    it("does not surface private text through a board the caller CAN see", async () => {
      // The nastiest shape: Bob searching his own board for the private term.
      // He is authorized here, so the gate passes — only the board_id filter
      // keeps the private row out.
      const res = await search(bobToken, bob, SECRET_TERM);
      expect(res.status).toBe(200);
      expect(res.body.issues).toEqual([]);
      expect(res.body.comments).toEqual([]);
    });

    it("rejects an unknown board slug the same way as a forbidden one", async () => {
      const res = await stack.api<ErrorBody>(
        bobToken,
        "POST",
        `/api/v0/orgs/${bob.orgSlug}/boards/no-such-board/search`,
        { q: "anything" },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── request shape ──────────────────────────────────────────────────────

  describe("request validation", () => {
    it("rejects a missing q", async () => {
      const res = await stack.api<ErrorBody>(
        aliceToken,
        "POST",
        `/api/v0/orgs/${alice.orgSlug}/boards/${alice.boardSlug}/search`,
        {},
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid-body");
    });

    it("rejects an unknown key — parseRouteBody is strict", async () => {
      const res = await stack.api<ErrorBody>(
        aliceToken,
        "POST",
        `/api/v0/orgs/${alice.orgSlug}/boards/${alice.boardSlug}/search`,
        { q: "widget", assignee: "someone" },
      );
      expect(res.status).toBe(400);
    });

    it("answers punctuation-only text with empty results, not an error", async () => {
      // FTS5 would throw a syntax error on much of this; the extraction step
      // means the route never hands it any operators.
      for (const q of ["???", "*", '"', "AND OR NOT"]) {
        const res = await search(aliceToken, alice, q);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.issues)).toBe(true);
      }
    });

    it("survives text that is pure FTS5 syntax", async () => {
      const res = await search(aliceToken, alice, 'widget" OR title:* NEAR(');
      expect(res.status).toBe(200);
    });
  });

  // ── the board-move leg of the trigger ──────────────────────────────────

  it("moves an issue's comments between board scopes when the issue moves", async () => {
    // migration 0027's issueCacheFts_au trigger updates commentCacheFts.board_id
    // as well. Without it, a moved issue's comments keep answering searches on
    // the board they came FROM — a cross-board leak, and a silent one.
    const issue = await createIssue(alice, "Relocation subject", "will move");
    const posted = await stack.api<{ comment: { id: string } }>(
      aliceToken,
      "POST",
      `/api/v0/issues/${issue.id}/comments`,
      { body: "a peripatetic observation" },
    );
    expect(posted.status).toBe(201);
    expect((await search(aliceToken, alice, "peripatetic")).body.comments.length).toBe(1);

    const moved = await stack.api(
      aliceToken,
      "POST",
      `/api/v0/issues/${issue.id}/move-to-board`,
      { target_board_id: secret.boardId },
    );
    // If the move route's shape differs, this test has nothing to say — fail
    // loudly rather than passing vacuously.
    expect(moved.status).toBe(200);

    // Gone from the origin board...
    expect((await search(aliceToken, alice, "peripatetic")).body.comments.length).toBe(0);
    // ...and present on the destination.
    expect((await search(aliceToken, secret, "peripatetic")).body.comments.length).toBe(1);
  });
});
