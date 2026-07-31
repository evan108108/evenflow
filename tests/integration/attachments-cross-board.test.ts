// EFB-49 — cross-board isolation on the attachment path, proven live.
//
// WHY THIS FILE EXISTS
//
// EFB-35 found that tests/dbMock.ts silently dropped the `board_id` bind on
// `WHERE short_id = ? AND board_id = ?`, so every cross-board assertion in the
// unit suite passed against a fake that wasn't enforcing anything. The mock is
// fixed. But fixing the mock only restored our *belief* that
// src/routes/attachments.ts isolates by board — the live route had still never
// been exercised end-to-end. This file removes the belief and replaces it with
// a run: real Worker, real D1, real migrations, real HS256 auth, real HTTP.
// See tests/integration/harness.ts for exactly what is real and what is not.
//
// THE BOUNDARY UNDER TEST
//
// Two shapes of attachment route, isolating two different ways:
//
//   Board-scoped  (`/boards/:slug/issues/:issue_ref/attachments`, list+upload)
//     resolveBoardScope() resolves the board from the URL, then the issue
//     lookup filters `AND board_id = ?` (attachments.ts fetchScopedIssue).
//     An issue from another board must not resolve here. Cases 1-3.
//
//   Id-addressed  (`/attachments/:id`, PATCH + DELETE)
//     No board in the URL at all. fetchAttachment() loads the row globally,
//     walks to its issue, then calls authorizeBoardById() against the
//     attachment's OWN board — so authorization follows the data, not the
//     request. Correct by construction, never proven. Case 5.
//
// Note that short_id prefixes are globally unique (idx_issueCache_short_id),
// so cross-board short ids never collide. Case 2 is therefore asserting "the
// board_id predicate is enforced", NOT "ids happen not to overlap" — if that
// predicate were dropped, boardA's issue would resolve inside boardB's scope
// and its attachments would be listed to boardB's owner.
//
// A DESIGN PROPERTY THIS FILE NAMES RATHER THAN FIXES (case 4)
//
// The brief asked for a presigned-URL leak check. There are no presigned URLs
// to check: `blob_url` is an immutable, PUBLIC, sha256-content-addressed
// Blossom URL. It carries no token, no signature, no expiry, and no board
// scope. So attachments on a private board are not private at the blob layer —
// anyone holding the URL, or anyone who happens to hash the same bytes, reads
// the blob regardless of board visibility, membership, or the board later
// being made private. That is a deliberate consequence of Blossom's
// content-addressed storage model, but it is not obvious from a board's
// `visibility: "private"` promise, and it is a design question rather than a
// bug to patch here.
//
// Case 4 therefore asserts the shape that is actually true today. If anyone
// later moves attachments to a presigned or board-scoped URL scheme, these
// assertions fail — deliberately — and force that change to be considered
// against this analysis instead of silently invalidating it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mintToken,
  seedAttachment,
  seedBoard,
  seedIssue,
  startStack,
  type SeededAttachment,
  type SeededBoard,
  type SeededIssue,
  type Stack,
} from "./harness";

/** Booting the Worker runtime + migrating a fresh D1 is slow by nature. */
const BOOT_TIMEOUT_MS = 180_000;

interface ErrorBody {
  readonly error: string;
  readonly reason?: string;
}

interface AttachmentsBody {
  readonly attachments: SeededAttachment[];
}

describe("attachments — cross-board isolation (live route, live D1)", () => {
  let stack: Stack;

  // Two genuinely distinct owners. Alice's board is the one holding the
  // secret; Bob is the adversary, and — importantly — Bob is a legitimate
  // user with a real board of his own, not an anonymous stranger. The
  // interesting failure is one authenticated tenant reaching another's data.
  const aliceToken = mintToken("alice");
  const bobToken = mintToken("bob");

  let alice: SeededBoard;
  let bob: SeededBoard;
  let aliceIssue: SeededIssue;
  let bobIssue: SeededIssue;
  let secret: SeededAttachment;

  const SECRET_CONTENTS = "alice-private-board-contents";

  beforeAll(async () => {
    stack = await startStack();

    alice = await seedBoard(stack, aliceToken, "alpha", "Alpha Board");
    bob = await seedBoard(stack, bobToken, "bravo", "Bravo Board");

    aliceIssue = await seedIssue(stack, alice, "Alice's issue");
    bobIssue = await seedIssue(stack, bob, "Bob's issue");

    secret = await seedAttachment(
      stack,
      alice,
      aliceIssue,
      "secret.txt",
      SECRET_CONTENTS,
    );
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.stop();
  });

  it("seeds two boards under two distinct owners", () => {
    expect(alice.orgSlug).not.toBe(bob.orgSlug);
    expect(alice.boardId).not.toBe(bob.boardId);
    // Distinct prefixes, so nothing below passes by id coincidence.
    expect(aliceIssue.short_id).not.toBe(bobIssue.short_id);
  });

  it("uploaded via the real route, signing a real BUD-01 authorization", () => {
    expect(secret.storage_kind).toBe("blossom_default");
    // The stub 401s unsigned uploads, so a recorded header proves the
    // Worker's Blossom signing path actually ran.
    expect(stack.blossom.authHeaders.length).toBe(1);
    expect(stack.blossom.authHeaders[0]).toMatch(/^Nostr /);
    expect(stack.blossom.blobs.has(secret.sha256)).toBe(true);
  });

  // ── Case 1 — baseline ────────────────────────────────────────────────────
  it("case 1: the owner sees the attachment in its own board's scope", async () => {
    const res = await stack.api<AttachmentsBody>(
      aliceToken,
      "GET",
      `/api/v0/orgs/${alice.orgSlug}/boards/${alice.boardSlug}/issues/${aliceIssue.short_id}/attachments`,
    );
    expect(res.status).toBe(200);
    expect(res.body.attachments.length).toBe(1);
    expect(res.body.attachments[0]?.id).toBe(secret.id);
    expect(res.body.attachments[0]?.filename).toBe("secret.txt");
  });

  // ── Case 2 — cross-board via URL ─────────────────────────────────────────
  //
  // Bob asks his OWN board for Alice's issue. The board resolves (it's his),
  // so authorization passes — the only thing standing between Bob and Alice's
  // attachment is the `AND board_id = ?` predicate on the issue lookup. The
  // 404 must say "issue", not "board": "board" would mean the request was
  // stopped by board authorization earlier and this case proved nothing.
  it("case 2: another board's issue does not resolve inside boardB's scope (short id)", async () => {
    const res = await stack.api<ErrorBody>(
      bobToken,
      "GET",
      `/api/v0/orgs/${bob.orgSlug}/boards/${bob.boardSlug}/issues/${aliceIssue.short_id}/attachments`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not-found");
    expect(res.body.reason).toBe("issue");
  });

  it("case 2: same, addressed by UUID rather than short id", async () => {
    // fetchScopedIssue takes a different branch for UUIDs; both bind board_id
    // and both must be proven.
    const res = await stack.api<ErrorBody>(
      bobToken,
      "GET",
      `/api/v0/orgs/${bob.orgSlug}/boards/${bob.boardSlug}/issues/${aliceIssue.id}/attachments`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not-found");
    expect(res.body.reason).toBe("issue");
  });

  it("case 2: an outsider cannot even resolve the private board", async () => {
    // Alice pointing at Bob's board stops one layer earlier — board
    // authorization. Recorded so the reason codes above stay meaningful.
    const res = await stack.api<ErrorBody>(
      aliceToken,
      "GET",
      `/api/v0/orgs/${bob.orgSlug}/boards/${bob.boardSlug}/issues/${aliceIssue.short_id}/attachments`,
    );
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("board");
  });

  it("case 2: uploading into another board's issue is refused too", async () => {
    // The write path shares fetchScopedIssue; a leak here would be worse than
    // a read leak, so it is asserted rather than assumed.
    const res = await stack.api<ErrorBody>(
      bobToken,
      "POST",
      `/api/v0/orgs/${bob.orgSlug}/boards/${bob.boardSlug}/issues/${aliceIssue.short_id}/attachments`,
      {
        file_b64: Buffer.from("bob-was-here", "utf8").toString("base64"),
        filename: "bob.txt",
        content_type: "text/plain",
      },
    );
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("issue");
  });

  // ── Case 3 — cross-board list ────────────────────────────────────────────
  it("case 3: boardB's own issue lists no attachments from boardA", async () => {
    const res = await stack.api<AttachmentsBody>(
      bobToken,
      "GET",
      `/api/v0/orgs/${bob.orgSlug}/boards/${bob.boardSlug}/issues/${bobIssue.short_id}/attachments`,
    );
    expect(res.status).toBe(200);
    expect(res.body.attachments).toEqual([]);
  });

  // ── Case 5 — id-addressed routes ─────────────────────────────────────────
  //
  // PATCH and DELETE take no board in the URL, so isolation rests entirely on
  // fetchAttachment() authorizing against the attachment's own board. Both
  // handlers are asserted: they share a helper today, but they are separate
  // handlers and either could be rewritten alone.
  it("case 5: another board's owner cannot PATCH the attachment", async () => {
    const res = await stack.api<ErrorBody>(
      bobToken,
      "PATCH",
      `/api/v0/attachments/${secret.id}`,
      { is_cover: true },
    );
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("attachment");
  });

  it("case 5: another board's owner cannot DELETE the attachment", async () => {
    const res = await stack.api<ErrorBody>(
      bobToken,
      "DELETE",
      `/api/v0/attachments/${secret.id}`,
    );
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("attachment");
  });

  it("case 5: the attachment survived both attempts, and its owner still can", async () => {
    // Proves the 404s above were refusals, not silent successes reported as
    // errors — the row is untouched and Alice's own PATCH still works.
    const stillThere = await stack.api<AttachmentsBody>(
      aliceToken,
      "GET",
      `/api/v0/orgs/${alice.orgSlug}/boards/${alice.boardSlug}/issues/${aliceIssue.short_id}/attachments`,
    );
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.attachments.length).toBe(1);
    expect(stillThere.body.attachments[0]?.is_cover).toBe(false);

    const mine = await stack.api<{ attachment: SeededAttachment }>(
      aliceToken,
      "PATCH",
      `/api/v0/attachments/${secret.id}`,
      { is_cover: true },
    );
    expect(mine.status).toBe(200);
    expect(mine.body.attachment.is_cover).toBe(true);
  });

  // ── Case 4 — the blob URL is public and content-addressed, not presigned ──
  //
  // Read the file header before changing these. They encode a design property
  // on purpose; if the property changes, this test SHOULD fail.
  describe("case 4: blob URLs are content-addressed and unscoped, not presigned", () => {
    it("is <host>/<sha256>, with no token, signature, or expiry", () => {
      expect(secret.blob_url).toBe(`${stack.blossom.url}/${secret.sha256}`);
      expect(secret.blob_url).toMatch(
        new RegExp(`^${stack.blossom.url}/[0-9a-f]{64}$`),
      );
      // In production the same shape is https://blossom.band/<sha256>.
      const url = new URL(secret.blob_url);
      expect(url.search).toBe("");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(url.pathname).toBe(`/${secret.sha256}`);
    });

    it("addresses the content itself — the path IS the hash of the bytes", async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(SECRET_CONTENTS),
      );
      const hex = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      expect(secret.sha256).toBe(hex);
    });

    it("serves the private board's attachment to an unauthenticated caller", async () => {
      // The uncomfortable one. No Evenflow session, no board membership, no
      // relationship to Alice at all — just the URL.
      const res = await fetch(secret.blob_url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(SECRET_CONTENTS);
    });

    it("board visibility does not gate the blob", async () => {
      const board = await stack.api<{ board: { visibility: string } }>(
        aliceToken,
        "GET",
        `/api/v0/orgs/${alice.orgSlug}/boards/${alice.boardSlug}`,
      );
      expect(board.status).toBe(200);
      // Boards are born private, and the blob above was readable anyway.
      expect(board.body.board.visibility).toBe("private");
    });
  });
});
