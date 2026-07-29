import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
) => h.app.request(`/api/v0/issues/${issueId}/comments`, jsonReq("POST", body), {});

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

    const all = await h.app.request(`/api/v0/issues/${issue.id}/comments`, { headers: bearer }, {});
    expect(all.status).toBe(200);
    const page = (await all.json()) as { comments: CommentShape[]; total: number; has_more: boolean };
    expect(page.comments.map((c) => c.body)).toEqual(["one", "two", "three"]);
    expect(page.total).toBe(3);
    expect(page.has_more).toBe(false);

    const rest = await h.app.request(
      `/api/v0/issues/${issue.id}/comments?after=${ids[0]}&limit=1`,
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

    const forbidden = await h.app.request("/api/v0/comments/other", { method: "DELETE", headers: bearer }, {});
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden", reason: "not-author" });

    const ok = await h.app.request(`/api/v0/comments/${mine.id}`, { method: "DELETE", headers: bearer }, {});
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: true });
    expect(h.db.comments.map((c) => c["id"])).toEqual(["other"]);

    const missing = await h.app.request(`/api/v0/comments/${mine.id}`, { method: "DELETE", headers: bearer }, {});
    expect(missing.status).toBe(404);
  });
});

describe("auth gating", () => {
  it.each([
    ["POST", "/api/v0/issues/x/comments"],
    ["DELETE", "/api/v0/comments/x"],
  ])("%s %s rejects unauthenticated mutations with 401", async (method, path) => {
    const h = makeHarness();
    const res = await h.app.request(path, { method }, {});
    expect(res.status).toBe(401);
  });

  // Anonymous reads pass optionalAuth and 404 on invisible resources.
  it("GET /api/v0/issues/x/comments answers 404 to anonymous callers", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/v0/issues/x/comments", {}, {});
    expect(res.status).toBe(404);
  });
});
