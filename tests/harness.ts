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
  makeBlossomTest,
  makeS3Test,
  makeAudienceTest,
  makeBoardEmitterTest,
  makeEmailTest,
  makeFourATest,
  type AppServices,
  type Claims,
} from "../src/effects";
import type { AppHonoEnv } from "../src/http";
import { mountAll } from "../src/router";
import { optionalAuth } from "../src/middleware/requireAuth";
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
  const blossom = makeBlossomTest();
  const s3 = makeS3Test();
  const audience = makeAudienceTest();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtMultiTest,
    db.layer,
    audit.layer,
    emitter.layer,
    fourA.layer,
    email.layer,
    blossom.layer,
    s3.layer,
    audience.layer,
  );
  const app = new Hono<AppHonoEnv>();
  app.use("/api/v0/*", optionalAuth(() => layer));
  // EFB-98: mounted from the same table src/index.ts uses, so the app under
  // test IS the app that ships. The hand-copied list this replaced had drifted
  // — it was missing the profile, search and /auth mounts entirely, and all
  // three org-scoped github/imports/search mounts, so 11 effective paths were
  // served in production and exercised by nothing.
  mountAll(app, () => layer);
  return { app, db, audit, emitter, fourA, email, blossom, s3, audience };
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

export const createBoard = async (
  h: Harness,
  slug = "kb",
  overrides?: Record<string, unknown>,
) => {
  const res = await h.app.request(
    "/api/v0/boards",
    jsonReq("POST", { slug, title: "Board", ...overrides }),
    {},
  );
  expect(res.status).toBe(201);
};

/**
 * A board that actually publishes to the substrate. Boards are born PRIVATE
 * with no audience (boards.ts), and that state is not "public" — it just
 * happens to have `encryption_active === false`. Any test asserting a
 * plaintext publish must opt in explicitly, or it is testing a private board
 * and proving the opposite of what its name says.
 */
export const createPublicBoard = (h: Harness, slug = "kb") =>
  createBoard(h, slug, { visibility: "public" });

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
