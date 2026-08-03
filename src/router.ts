/**
 * EFB-98: the one place routers are mounted.
 *
 * Before this file the mount list was written out four times — src/index.ts,
 * tests/harness.ts, tests/profile.test.ts and tests/auth.test.ts — and they had
 * already drifted. Six mounts existed in index.ts and in no harness, so the
 * org-scoped github, imports and search routers (11 effective paths) were
 * served in production and exercised by no test at all.
 *
 * A test app built from a hand-copied mount list can only ever prove things
 * about that copy. Everything now builds from MOUNTS, so "tested" and "served"
 * are the same set by construction.
 *
 * ORDER IS LOAD-BEARING. Hono resolves by registration order, so the routers
 * that own a specific path must mount before the mirrored board-family routers
 * that would otherwise swallow it. Each such constraint is commented at its
 * entry; do not sort this list.
 */

import type { Hono } from "hono";
import type { AppHonoEnv } from "./http";
import type { LayerFor } from "./http";

import { makeAttachmentsRouter } from "./routes/attachments";
import { makeAudiencesRouter } from "./routes/audiences";
import { makeAuthRouter } from "./routes/auth";
import { makeBoardsRouter } from "./routes/boards";
import { makeCommentsRouter } from "./routes/comments";
import { makeFeedRouter } from "./routes/feed";
import { makeGithubRouter } from "./routes/github";
import { makeImportsRouter } from "./routes/imports";
import { makeInvitesRouter } from "./routes/invites";
import { makeIssuesRouter } from "./routes/issues";
import { makeKeysRouter } from "./routes/keys";
import { makeMcpRouter } from "./routes/mcp";
import { makeNotificationsRouter } from "./routes/notifications";
import { makeOrgsRouter } from "./routes/orgs";
import { makeProfileRouter } from "./routes/profile";
import { makeSearchRouter } from "./routes/search";
import { makeSessionRouter } from "./routes/session";
import { makeSigninRouter } from "./routes/signin";
import { makeSprintsRouter } from "./routes/sprints";
import { makeStorageRouter } from "./routes/storage";
import { makeWebhooksRouter } from "./routes/webhooks";
import { makeWellKnownRouter } from "./routes/wellknown";

type Mount = {
  /** Path prefix to mount under. */
  readonly prefix: string;
  /**
   * Router factory. Each one defaults `layerFor` to the production bootstrap,
   * so omitting the argument builds the real thing.
   *
   */
  readonly make: (layerFor?: LayerFor) => Hono<AppHonoEnv>;
  /** Why this entry sits where it sits, when order matters. */
  readonly note?: string;
};

/**
 * The org-scoped prefix.
 *
 * Still `/orgs/` at this step, deliberately. Extracting the mount list and
 * renaming the prefix are two different changes, and doing them in one commit
 * would mean a red suite proves nothing about either. This step is provably
 * behavior-preserving — same routers, same prefixes, same order — so the
 * existing tests are a real regression signal for it. The rename to `/org/`
 * lands next and is a one-line edit here, which is the property the manifest
 * exists to provide.
 */
export const ORG_PREFIX = "/api/v0/orgs/:org_slug";
export const API_PREFIX = "/api/v0";

export const MOUNTS: readonly Mount[] = [
  { prefix: "/auth", make: makeAuthRouter },

  // Public: RFC 9728 discovery + MCP. MCP authenticates per JSON-RPC call
  // inside the router (answering -32001 rather than HTTP 401), so it cannot
  // sit behind the /api/v0 optional-auth middleware.
  { prefix: "/", make: makeWellKnownRouter },
  { prefix: "/", make: makeMcpRouter },

  { prefix: API_PREFIX, make: makeSigninRouter },
  { prefix: API_PREFIX, make: makeSessionRouter },
  {
    prefix: API_PREFIX,
    make: makeOrgsRouter,
    note: "Before the org-scoped board mounts: /org/:org_slug/boards and /org/:org_slug/board/:slug/members must resolve to the orgs router, not to a mirrored board router.",
  },
  { prefix: API_PREFIX, make: makeInvitesRouter },
  { prefix: API_PREFIX, make: makeKeysRouter },
  {
    prefix: API_PREFIX,
    make: makeStorageRouter,
    note: "Owns /server-pubkey and /org/:org_slug/storage; same precedence reason as the orgs router.",
  },
  { prefix: API_PREFIX, make: makeNotificationsRouter },
  {
    prefix: API_PREFIX,
    make: makeGithubRouter,
    note: "Carries the public inbound webhook (/webhook/github/:board_id, HMAC-gated, never reads claims) alongside the admin surface, so it mounts before the board-family routers.",
  },

  // Board-family routers, each mounted twice: bare and org-scoped.
  { prefix: API_PREFIX, make: makeBoardsRouter },
  {
    prefix: API_PREFIX,
    make: makeImportsRouter,
    note: "Before the issues router. Nothing currently matches /board/:slug/issues/bulk there, but the day someone adds /board/:slug/issue/:id a bulk POST would resolve to it with `bulk` as the id.",
  },
  { prefix: API_PREFIX, make: makeIssuesRouter },
  { prefix: API_PREFIX, make: makeSprintsRouter },
  { prefix: API_PREFIX, make: makeCommentsRouter },
  { prefix: API_PREFIX, make: makeFeedRouter },
  { prefix: API_PREFIX, make: makeAttachmentsRouter },
  { prefix: API_PREFIX, make: makeWebhooksRouter },
  { prefix: API_PREFIX, make: makeSearchRouter },

  { prefix: ORG_PREFIX, make: makeBoardsRouter },
  { prefix: ORG_PREFIX, make: makeImportsRouter },
  { prefix: ORG_PREFIX, make: makeIssuesRouter },
  { prefix: ORG_PREFIX, make: makeSprintsRouter },
  { prefix: ORG_PREFIX, make: makeCommentsRouter },
  { prefix: ORG_PREFIX, make: makeFeedRouter },
  { prefix: ORG_PREFIX, make: makeAttachmentsRouter },
  { prefix: ORG_PREFIX, make: makeSearchRouter },

  // Audiences and profile mount after the org block, exactly as index.ts had
  // them. Nothing here is known to depend on that position, but this step's
  // whole claim is "same routers, same order", so the order is reproduced
  // rather than tidied.
  { prefix: API_PREFIX, make: makeAudiencesRouter },
  { prefix: ORG_PREFIX, make: makeAudiencesRouter },
  { prefix: ORG_PREFIX, make: makeGithubRouter },
  { prefix: API_PREFIX, make: makeProfileRouter },
];

/**
 * Mount every router onto `app`, in order.
 *
 * Production calls this with no factory; tests pass one that returns a layer
 * over an in-memory database. Nothing else about the two apps differs, which
 * is the property that makes the route tests meaningful.
 */
export const mountAll = (app: Hono<AppHonoEnv>, layerFor?: LayerFor): void => {
  for (const mount of MOUNTS) {
    app.route(mount.prefix, layerFor === undefined ? mount.make() : mount.make(layerFor));
  }
};
