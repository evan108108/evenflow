import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { url } from "../src/routes-manifest";
import { Effect, Exit } from "effect";
import { decodeBody } from "../src/lib/route-body";
import { PostCommentBody } from "../src/actions/comments";
import type { CommentShape } from "../src/shapes";
import {
  CALLER,
  bearer,
  createBoard,
  createIssue,
  jsonReq,
  makeHarness,
  seedForeignBoardAndIssue,
} from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const postComment = async (
  h: ReturnType<typeof makeHarness>,
  issueId: string,
  body: Record<string, unknown>,
) => h.app.request(url("comment.create", { id: issueId }), jsonReq("POST", body), {});

describe("POST /api/v0/issues/:id/comments", () => {
  it("creates a comment authored by the caller", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const res = await postComment(h, issue.id, { body: "First!" });
    expect(res.status).toBe(201);
    const { comment } = (await res.json()) as { comment: CommentShape };
    expect(comment).toMatchObject({
      issue_id: issue.id,
      author_pubkey: CALLER,
      body: "First!",
      in_reply_to: null,
      created_at_ms: 1_000,
    });
    expect(h.db.comments).toHaveLength(1);
  });

  it("threads replies and rejects dangling in_reply_to", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const root = ((await (await postComment(h, issue.id, { body: "root" })).json()) as {
      comment: CommentShape;
    }).comment;

    const reply = await postComment(h, issue.id, { body: "reply", in_reply_to: root.id });
    expect(reply.status).toBe(201);
    expect(((await reply.json()) as { comment: CommentShape }).comment.in_reply_to).toBe(root.id);

    const dangling = await postComment(h, issue.id, { body: "x", in_reply_to: "nope" });
    expect(dangling.status).toBe(400);
    expect(await dangling.json()).toEqual({ error: "invalid-body", reason: "in_reply_to" });
  });

  it("400s on a missing or empty body", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    for (const body of [{}, { body: "" }, { body: 42 }]) {
      const res = await postComment(h, issue.id, body as Record<string, unknown>);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-body", reason: "body" });
    }
  });

  it("404s on unknown and foreign issues", async () => {
    const h = makeHarness();
    seedForeignBoardAndIssue(h);
    for (const id of ["nope", "fi"]) {
      const res = await postComment(h, id, { body: "hi" });
      expect(res.status).toBe(404);
    }
  });
});

describe("GET /api/v0/issues/:id/comments", () => {
  it("lists chronologically with total and keyset pagination", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const ids: string[] = [];
    for (const [i, text] of (["one", "two", "three"] as const).entries()) {
      vi.setSystemTime(1_000 * (i + 1));
      const res = await postComment(h, issue.id, { body: text });
      ids.push(((await res.json()) as { comment: CommentShape }).comment.id);
    }

    const all = await h.app.request(url("comment.create", { id: issue.id }), { headers: bearer }, {});
    expect(all.status).toBe(200);
    const page = (await all.json()) as { comments: CommentShape[]; total: number; has_more: boolean };
    expect(page.comments.map((c) => c.body)).toEqual(["one", "two", "three"]);
    expect(page.total).toBe(3);
    expect(page.has_more).toBe(false);

    const rest = await h.app.request(
      `${url("comment.create", { id: issue.id })}?after=${ids[0]}&limit=1`,
      { headers: bearer },
      {},
    );
    const page2 = (await rest.json()) as { comments: CommentShape[]; has_more: boolean };
    expect(page2.comments.map((c) => c.body)).toEqual(["two"]);
    expect(page2.has_more).toBe(true);
  });
});

describe("DELETE /api/v0/comments/:id", () => {
  it("lets the author delete; 403s a non-author; 404s unknown", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const mine = ((await (await postComment(h, issue.id, { body: "mine" })).json()) as {
      comment: CommentShape;
    }).comment;
    // A comment someone else authored on the same issue.
    h.db.comments.push({
      id: "other", issue_id: issue.id, author_pubkey: "github:999",
      body: "not yours", in_reply_to: null, created_at_ms: 1_500,
    });

    const forbidden = await h.app.request(url("comment.delete", { id: "other" }), { method: "DELETE", headers: bearer }, {});
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden", reason: "not-author" });

    const ok = await h.app.request(url("comment.delete", { id: mine.id }), { method: "DELETE", headers: bearer }, {});
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: true });
    expect(h.db.comments.map((c) => c["id"])).toEqual(["other"]);

    const missing = await h.app.request(url("comment.delete", { id: mine.id }), { method: "DELETE", headers: bearer }, {});
    expect(missing.status).toBe(404);
  });
});

describe("auth gating", () => {
  it.each([
    ["POST", url("comment.create", { id: "x" })],
    ["DELETE", url("comment.delete", { id: "x" })],
  ])("%s %s rejects unauthenticated mutations with 401", async (method, path) => {
    const h = makeHarness();
    const res = await h.app.request(path, { method }, {});
    expect(res.status).toBe(401);
  });

  // Anonymous reads pass optionalAuth; EFB-76 makes invisible resources 401
  // rather than 404, uniformly for private and nonexistent alike.
  it("GET /api/v0/issues/x/comments answers 401 to anonymous callers", async () => {
    const h = makeHarness();
    const res = await h.app.request(url("comment.create", { id: "x" }), {}, {});
    expect(res.status).toBe(401);
  });
});

// ── phase 18c: rich comments — body_format + attachment claims ────────────

const uploadTo = async (h: ReturnType<typeof makeHarness>, issueId: string) => {
  const res = await h.app.request(
    url("attachment.create", { slug: "kb", issue_ref: issueId }),
    jsonReq("POST", {
      file_b64: btoa("png-bytes"),
      filename: "shot.png",
      content_type: "image/png",
    }),
    {},
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { attachment: { id: string } }).attachment;
};

describe("comment attachments (phase 18c)", () => {
  it("new comments are markdown-format", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const res = await postComment(h, issue.id, { body: "**bold**" });
    const { comment } = (await res.json()) as { comment: CommentShape };
    expect(comment.body_format).toBe("markdown");
  });

  it("claims uploaded attachments for the comment and hides them from the Files list", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const a = await uploadTo(h, issue.id);
    const b = await uploadTo(h, issue.id);

    const res = await postComment(h, issue.id, { body: "see attached", attachment_ids: [a.id, b.id] });
    expect(res.status).toBe(201);
    const { comment } = (await res.json()) as {
      comment: CommentShape & { attachments: Array<{ id: string; comment_id: string | null }> };
    };
    expect(comment.attachments.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(comment.attachments.every((x) => x.comment_id === comment.id)).toBe(true);

    // GET comments carries the enrichment.
    const list = await h.app.request(url("comment.create", { id: issue.id }), { headers: bearer }, {});
    const listed = (await list.json()) as {
      comments: Array<{ id: string; attachments: Array<{ id: string }> }>;
    };
    expect(listed.comments[0]!.attachments).toHaveLength(2);

    // The issue's Files panel no longer lists claimed attachments.
    const files = await h.app.request(
      url("attachment.create", { slug: "kb", issue_ref: issue.id }),
      { headers: bearer },
      {},
    );
    expect(((await files.json()) as { attachments: unknown[] }).attachments).toHaveLength(0);
  });

  it("rejects unknown, cross-issue, and double-claimed attachment ids", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const other = await createIssue(h, { title: "Other" });
    const mine = await uploadTo(h, issue.id);
    const theirs = await uploadTo(h, other.id);

    const unknown = await postComment(h, issue.id, { body: "x", attachment_ids: ["nope"] });
    expect(unknown.status).toBe(400);

    const crossIssue = await postComment(h, issue.id, { body: "x", attachment_ids: [theirs.id] });
    expect(crossIssue.status).toBe(400);

    const first = await postComment(h, issue.id, { body: "x", attachment_ids: [mine.id] });
    expect(first.status).toBe(201);
    const doubleClaim = await postComment(h, issue.id, { body: "y", attachment_ids: [mine.id] });
    expect(doubleClaim.status).toBe(400);

    const notArray = await postComment(h, issue.id, { body: "x", attachment_ids: "nope" });
    expect(notArray.status).toBe(400);
  });

  it("deleting a comment soft-deletes its attachments", async () => {
    const h = makeHarness();
    await createBoard(h);
    const issue = await createIssue(h);
    const a = await uploadTo(h, issue.id);
    const res = await postComment(h, issue.id, { body: "x", attachment_ids: [a.id] });
    const { comment } = (await res.json()) as { comment: CommentShape };

    const del = await h.app.request(url("comment.delete", { id: comment.id }), jsonReq("DELETE"), {});
    expect(del.status).toBe(200);
    const row = h.db.attachments.find((r) => r["id"] === a.id);
    expect(row?.["deleted_at_ms"]).not.toBeNull();
  });
});

// ── EFB-61: PostCommentBody schema ────────────────────────────────────────
//
// The route-level tests above pin the WIRE contract (status + reason). These
// pin the schema itself, which is why they run without a harness — the point
// of `decodeBody` being split out of `parseRouteBody` in route-body.ts.
//
// The reason strings here are load-bearing: the pre-EFB-61 handler answered
// `body` / `attachment_ids` / `in_reply_to`, and a migration that changed them
// would be an API break wearing a refactor's clothes.
describe("PostCommentBody (EFB-61)", () => {
  const decode = (input: unknown) =>
    Effect.runSync(Effect.exit(decodeBody(PostCommentBody, input)));

  // Same shape as tests/csv-import.test.ts — read the reason off the cause
  // rather than matching on it, so a failure that is not a ValidationError
  // shows up as a wrong string instead of passing silently.
  const reasonOf = (exit: Exit.Exit<unknown, unknown>): string => {
    if (Exit.isSuccess(exit)) return "<succeeded>";
    const err = (exit.cause as { error?: { reason?: string } }).error;
    return err?.reason ?? "<no reason>";
  };

  it("the instrument can fail — rejects what the old handler rejected", () => {
    for (const input of [{}, { body: "" }, { body: 42 }]) {
      expect(reasonOf(decode(input))).toBe("body");
    }
  });

  it("rejects whitespace-only body — minLength(1) alone would have accepted it", () => {
    expect(reasonOf(decode({ body: "   " }))).toBe("body");
    expect(reasonOf(decode({ body: "\n\t" }))).toBe("body");
  });

  it("accepts the shapes the route has always accepted", () => {
    expect(Exit.isSuccess(decode({ body: "hi" }))).toBe(true);
    // null in_reply_to means "no parent" and always has.
    expect(Exit.isSuccess(decode({ body: "hi", in_reply_to: null }))).toBe(true);
    expect(Exit.isSuccess(decode({ body: "hi", in_reply_to: "abc" }))).toBe(true);
    expect(Exit.isSuccess(decode({ body: "hi", attachment_ids: [] }))).toBe(true);
    expect(Exit.isSuccess(decode({ body: "hi", attachment_ids: ["a", "b"] }))).toBe(true);
  });

  it("keeps the attachment_ids rules the handler used to enforce by hand", () => {
    expect(reasonOf(decode({ body: "hi", attachment_ids: ["a", "a"] }))).toBe("attachment_ids");
    expect(reasonOf(decode({ body: "hi", attachment_ids: [1] }))).toBe("attachment_ids");
    expect(reasonOf(decode({ body: "hi", attachment_ids: "a" }))).toBe("attachment_ids");
    const tooMany = Array.from({ length: 21 }, (_, i) => `id-${i}`);
    expect(reasonOf(decode({ body: "hi", attachment_ids: tooMany }))).toBe("attachment_ids");
  });

  it("rejects a non-string in_reply_to", () => {
    expect(reasonOf(decode({ body: "hi", in_reply_to: 42 }))).toBe("in_reply_to");
  });

  // THE BEHAVIOR CHANGE. Before EFB-61 this returned 201 and silently ignored
  // `bogus`; that silent-ignore is the whole bug class EFB-53/54 exist to
  // delete. Pinned here so it is a decision on the record, not a side effect.
  it("now REJECTS an unknown key that used to be silently ignored", () => {
    expect(reasonOf(decode({ body: "hi", bogus: 1 }))).toBe("bogus-unknown");
  });
});
