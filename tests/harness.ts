// Shared route-test harness: full /api/v0 app over the SQL-interpreting
// DbMock, plus seed helpers. Lives outside *.test.ts so importing it never
// re-registers another file's tests.

import { expect } from "vitest";
import { Hono } from "hono";
import { Layer } from "effect";
import {
  JwtTest,
  JWT_TEST_CLAIMS,
  JWT_TEST_TOKEN,
  KmsClientTest,
  makeAuditLogTest,
  type AppServices,
} from "../src/effects";
import type { AppHonoEnv } from "../src/http";
import { requireAuth } from "../src/middleware/requireAuth";
import { makeBoardsRouter } from "../src/routes/boards";
import { makeCommentsRouter } from "../src/routes/comments";
import { makeIssuesRouter } from "../src/routes/issues";
import type { IssueShape } from "../src/shapes";
import { makeDbMock } from "./dbMock";

/** The stand-in pubkey the routers derive until KMS is wired. */
export const CALLER = `${JWT_TEST_CLAIMS.provider}:${JWT_TEST_CLAIMS.oauth_id}`;

export const makeHarness = () => {
  const db = makeDbMock();
  const audit = makeAuditLogTest();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtTest,
    db.layer,
    audit.layer,
    KmsClientTest,
  );
  const app = new Hono<AppHonoEnv>();
  app.use("/api/v0/*", requireAuth(() => layer));
  app.route("/api/v0", makeBoardsRouter(() => layer));
  app.route("/api/v0", makeIssuesRouter(() => layer));
  app.route("/api/v0", makeCommentsRouter(() => layer));
  return { app, db, audit };
};

export type Harness = ReturnType<typeof makeHarness>;

export const bearer = { Authorization: `Bearer ${JWT_TEST_TOKEN}` };

export const jsonReq = (method: string, body?: unknown) => ({
  method,
  headers: { ...bearer, "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const createBoard = async (h: Harness, slug = "kb") => {
  const res = await h.app.request("/api/v0/boards", jsonReq("POST", { slug, title: "Board" }), {});
  expect(res.status).toBe(201);
};

export const createIssue = async (
  h: Harness,
  overrides?: Record<string, unknown>,
  slug = "kb",
): Promise<IssueShape> => {
  const res = await h.app.request(
    `/api/v0/boards/${slug}/issues`,
    jsonReq("POST", { title: "An issue", ...overrides }),
    {},
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { issue: IssueShape }).issue;
};

/** A board + issue owned by someone who is not the test caller. */
export const seedForeignBoardAndIssue = (h: Harness) => {
  h.db.boards.push({
    id: "fb", pubkey: "github:999", slug: "theirs", title: "Theirs",
    description: null, columns: JSON.stringify(["Todo", "Done"]), labels: "[]",
    member_policy: "invite", is_encrypted: 0, created_at_ms: 1, updated_at_ms: 1,
  });
  h.db.issues.push({
    id: "fi", board_id: "fb", title: "Their issue", body: null, status: "Todo",
    container: "backlog", assignee_pubkey: null, priority: null, estimate: null,
    labels: "[]", github_links: "[]", created_at_ms: 1, updated_at_ms: 1, completed_at_ms: null,
  });
};
