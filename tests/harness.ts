// Shared route-test harness: full /api/v0 app over the SQL-interpreting
// DbMock, plus seed helpers. Lives outside *.test.ts so importing it never
// re-registers another file's tests.
//
// Mirrors index.ts since phase 16: optionalAuth (anonymous passes through,
// mutations 401 via requireCaller), org/invite/session routers, and the
// board-family routers mounted both legacy (/api/v0) and canonical
// (/api/v0/orgs/:org_slug).

import { expect } from "vitest";
import { Hono } from "hono";
import { Effect, Layer } from "effect";
import {
  Jwt,
  JwtError,
  JwtTest,
  JWT_TEST_CLAIMS,
  JWT_TEST_TOKEN,
  makeAuditLogTest,
  makeBoardEmitterTest,
  makeEmailTest,
  makeFourATest,
  type AppServices,
  type Claims,
} from "../src/effects";
import type { AppHonoEnv } from "../src/http";
import { optionalAuth } from "../src/middleware/requireAuth";
import { makeBoardsRouter } from "../src/routes/boards";
import { makeCommentsRouter } from "../src/routes/comments";
import { makeFeedRouter } from "../src/routes/feed";
import { makeInvitesRouter } from "../src/routes/invites";
import { makeIssuesRouter } from "../src/routes/issues";
import { makeMcpRouter } from "../src/routes/mcp";
import { makeOrgsRouter } from "../src/routes/orgs";
import { makeSessionRouter } from "../src/routes/session";
import { makeWellKnownRouter } from "../src/routes/wellknown";
import type { IssueShape } from "../src/shapes";
import { makeDbMock } from "./dbMock";

/** The stand-in pubkey the routers derive until KMS is wired. */
export const CALLER = `${JWT_TEST_CLAIMS.provider}:${JWT_TEST_CLAIMS.oauth_id}`;

/**
 * Extra canned identities for membership tests. Token `tok-<name>` maps to
 * pubkey `test:<name>` with login `<name>@example.com`; the primary
 * JWT_TEST_TOKEN identity keeps working unchanged.
 */
export const tokenFor = (name: string) => `tok-${name}`;
export const pubkeyFor = (name: string) => `test:${name}`;

const multiClaims = (name: string): Claims => ({
  provider: "test",
  oauth_id: name,
  login: `${name}@example.com`,
  iat: 0,
  exp: 4102444800,
});

const JwtMultiTest: Layer.Layer<Jwt> = Layer.succeed(Jwt, {
  verify: (token) => {
    if (token === JWT_TEST_TOKEN) return Effect.succeed(JWT_TEST_CLAIMS);
    if (token.startsWith("tok-")) return Effect.succeed(multiClaims(token.slice(4)));
    return Effect.fail(new JwtError({ reason: "bad-signature" }));
  },
});

export const makeHarness = () => {
  const db = makeDbMock();
  const audit = makeAuditLogTest();
  const emitter = makeBoardEmitterTest();
  const fourA = makeFourATest();
  const email = makeEmailTest();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtMultiTest,
    db.layer,
    audit.layer,
    emitter.layer,
    fourA.layer,
    email.layer,
  );
  const app = new Hono<AppHonoEnv>();
  app.use("/api/v0/*", optionalAuth(() => layer));
  app.route("/api/v0", makeSessionRouter(() => layer));
  app.route("/api/v0", makeOrgsRouter(() => layer));
  app.route("/api/v0", makeInvitesRouter(() => layer));
  app.route("/api/v0", makeBoardsRouter(() => layer));
  app.route("/api/v0", makeIssuesRouter(() => layer));
  app.route("/api/v0", makeCommentsRouter(() => layer));
  app.route("/api/v0", makeFeedRouter(() => layer));
  app.route("/api/v0/orgs/:org_slug", makeBoardsRouter(() => layer));
  app.route("/api/v0/orgs/:org_slug", makeIssuesRouter(() => layer));
  app.route("/api/v0/orgs/:org_slug", makeCommentsRouter(() => layer));
  app.route("/api/v0/orgs/:org_slug", makeFeedRouter(() => layer));
  app.route("/", makeWellKnownRouter());
  app.route("/", makeMcpRouter(() => layer));
  return { app, db, audit, emitter, fourA, email };
};

export type Harness = ReturnType<typeof makeHarness>;

export const bearer = { Authorization: `Bearer ${JWT_TEST_TOKEN}` };
export const bearerFor = (token: string) => ({ Authorization: `Bearer ${token}` });

export const jsonReq = (method: string, body?: unknown, token?: string) => ({
  method,
  headers: {
    ...(token === undefined ? bearer : bearerFor(token)),
    "Content-Type": "application/json",
  },
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

/** The caller's personal org row (auto-created by the first board create). */
export const callerOrg = (h: Harness) => {
  const org = h.db.orgs.find((o) => o["created_by"] === CALLER && o["kind"] === "personal");
  expect(org).toBeDefined();
  return org!;
};

/** Seed a team org with the given owner pubkey, straight into the mock. */
export const seedTeamOrg = (
  h: Harness,
  slug: string,
  owner: string,
  overrides?: Record<string, unknown>,
) => {
  const id = `org-${slug}`;
  h.db.orgs.push({
    id, slug, display_name: slug, avatar_url: null, bio: null, kind: "team",
    created_by: owner, substrate_event_id: null, created_at_ms: 1, updated_at_ms: 1,
    deleted_at_ms: null, ...overrides,
  });
  h.db.orgMembers.push({
    org_id: id, pubkey: owner, role: "owner", added_by: owner, added_at_ms: 1,
    substrate_event_id: null,
  });
  return id;
};

/** Seed an org membership row directly. */
export const seedOrgMember = (h: Harness, orgId: string, pubkey: string, role: string) => {
  h.db.orgMembers.push({
    org_id: orgId, pubkey, role, added_by: "seed", added_at_ms: 1, substrate_event_id: null,
  });
};

/** Seed an explicit board membership row directly. */
export const seedBoardMember = (h: Harness, boardId: string, pubkey: string, role: string) => {
  h.db.boardMembers.push({
    board_id: boardId, pubkey, role, added_by: "seed", added_at_ms: 1, substrate_event_id: null,
  });
};

/** A board + issue owned by someone who is not the test caller. */
export const seedForeignBoardAndIssue = (h: Harness) => {
  h.db.boards.push({
    id: "fb", pubkey: "github:999", slug: "theirs", title: "Theirs",
    description: null, columns: JSON.stringify(["Todo", "Done"]), labels: "[]",
    member_policy: "invite", is_encrypted: 0, org_id: null, visibility: "private",
    created_at_ms: 1, updated_at_ms: 1,
  });
  h.db.issues.push({
    id: "fi", board_id: "fb", title: "Their issue", body: null, status: "Todo",
    container: "backlog", assignee_pubkey: null, priority: null, estimate: null,
    labels: "[]", github_links: "[]", created_at_ms: 1, updated_at_ms: 1, completed_at_ms: null,
  });
};
