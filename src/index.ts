import { Hono } from "hono";
import { Effect } from "effect";
import { AuditLog, Db, bootstrap } from "./effects";
import { asShortId } from "./slug";
import { INVITE_CODE_PREFIX } from "./roles";
import type { AppHonoEnv } from "./http";
import { optionalAuth } from "./middleware/requireAuth";
import { makeAttachmentsRouter } from "./routes/attachments";
import { makeAuthRouter } from "./routes/auth";
import { makeBoardsRouter } from "./routes/boards";
import { makeCommentsRouter } from "./routes/comments";
import { makeFeedRouter } from "./routes/feed";
import { makeInvitesRouter } from "./routes/invites";
import { makeKeysRouter } from "./routes/keys";
import { makeIssuesRouter } from "./routes/issues";
import { makeMcpRouter } from "./routes/mcp";
import { makeOrgsRouter } from "./routes/orgs";
import { makeProfileRouter } from "./routes/profile";
import { makeSessionRouter } from "./routes/session";
import { makeWellKnownRouter } from "./routes/wellknown";

const app = new Hono<AppHonoEnv>();

// The Effect handler pattern every future route follows: describe the work
// as an Effect against service Tags, then run it against the per-request
// Live environment from `bootstrap(c.env)`.
app.get("/healthz", async (c) => {
  const healthz = Effect.gen(function* () {
    const audit = yield* AuditLog;
    yield* audit.record({ event_type: "healthz_check", details: { path: c.req.path } });
    return { ok: true, service: "evenflow", version: "0.0.1" };
  });
  return c.json(await Effect.runPromise(Effect.provide(healthz, bootstrap(c.env))));
});

app.route("/auth", makeAuthRouter());

// Public mounts: RFC 9728 discovery + the MCP endpoint (auth happens per
// JSON-RPC call inside the router, answering -32001 instead of HTTP 401).
app.route("/", makeWellKnownRouter());
app.route("/", makeMcpRouter());

// Phase 16: /api/v0/* runs behind OPTIONAL auth — a present JWT must be
// valid (401 otherwise), an absent one passes through anonymous so public
// boards read without sign-in. Every mutation gates on requireCaller.
app.use("/api/v0/*", optionalAuth());

// Placeholder demonstrating the middleware end-to-end: echoes the verified claims.
app.get("/api/v0/me", (c) => {
  const claims = c.get("claims");
  if (claims === undefined) {
    return c.json({ error: "unauthorized", reason: "missing-authorization" }, 401);
  }
  return c.json(claims);
});

app.route("/api/v0", makeSessionRouter());
// Orgs before the org-scoped board mounts: /orgs/:slug/boards (org listing)
// and /orgs/:org_slug/boards/:slug/members must match the orgs/invites
// routers, not the mirrored board routers.
app.route("/api/v0", makeOrgsRouter());
app.route("/api/v0", makeInvitesRouter());
app.route("/api/v0", makeKeysRouter());

// Board-family routers, mounted twice: legacy compat at /api/v0 and the
// canonical org-scoped namespace at /api/v0/orgs/:org_slug. Handlers branch
// on the org_slug param via resolveBoardScope.
app.route("/api/v0", makeBoardsRouter());
app.route("/api/v0", makeIssuesRouter());
app.route("/api/v0", makeCommentsRouter());
app.route("/api/v0", makeFeedRouter());
app.route("/api/v0", makeAttachmentsRouter());
app.route("/api/v0/orgs/:org_slug", makeBoardsRouter());
app.route("/api/v0/orgs/:org_slug", makeIssuesRouter());
app.route("/api/v0/orgs/:org_slug", makeCommentsRouter());
app.route("/api/v0/orgs/:org_slug", makeFeedRouter());
app.route("/api/v0/orgs/:org_slug", makeAttachmentsRouter());
app.route("/api/v0", makeProfileRouter());

// /i/FLOW-42 — the paste-anywhere deep link (git commits, chat). Resolves
// the board slug server-side and bounces to the full canonical SPA URL.
// Unauthed on purpose: it discloses only slug + issue existence, and the
// destination page still demands membership; requiring auth here would
// break pasted links. /i/inv-… codes are NOT short ids — they fall through
// to the SPA, which renders the invite preview page.
app.get("/i/:ref", async (c, next) => {
  const ref = c.req.param("ref");
  if (ref.startsWith(INVITE_CODE_PREFIX)) return next();
  const shortId = asShortId(ref);
  if (shortId === null) return c.redirect("/", 302);
  const program = Effect.flatMap(Db, (db) =>
    db.queryFirst<{ board_slug: string; org_slug: string | null }>(
      "SELECT boardCache.slug AS board_slug, orgCache.slug AS org_slug FROM issueCache JOIN boardCache ON boardCache.id = issueCache.board_id LEFT JOIN orgCache ON orgCache.id = boardCache.org_id WHERE issueCache.short_id = ?",
      [shortId],
    ),
  );
  const row = await Effect.runPromise(
    Effect.provide(program, bootstrap(c.env)).pipe(Effect.catchAll(() => Effect.succeed(null))),
  );
  if (row === null) return c.redirect("/", 302);
  if (row.org_slug === null) {
    return c.redirect(`/boards/${row.board_slug}/issues/${shortId}`, 302);
  }
  return c.redirect(`/@${row.org_slug}/${row.board_slug}/issues/${shortId}`, 302);
});

// Legacy board URLs 302 to the canonical /@{handle}/{board} namespace when
// the board resolves to an org; sub-paths (backlog, issues/FLOW-1, …) keep
// their tail. Ambiguous slugs (same board slug in several orgs) pick the
// oldest — pre-16 slugs were globally unique in practice. Unresolvable
// slugs fall through to the SPA, which renders its 404.
const legacyBoardRedirect: import("hono").MiddlewareHandler<AppHonoEnv> = async (c, next) => {
  const slug = c.req.param("slug");
  const program = Effect.flatMap(Db, (db) =>
    db.queryFirst<{ org_slug: string }>(
      "SELECT orgCache.slug AS org_slug FROM boardCache JOIN orgCache ON orgCache.id = boardCache.org_id WHERE boardCache.slug = ? AND orgCache.deleted_at_ms IS NULL ORDER BY boardCache.created_at_ms ASC",
      [slug],
    ),
  );
  const row = await Effect.runPromise(
    Effect.provide(program, bootstrap(c.env)).pipe(Effect.catchAll(() => Effect.succeed(null))),
  );
  if (row === null) return next();
  const prefix = `/boards/${slug}`;
  const tail = c.req.path.slice(prefix.length);
  return c.redirect(`/@${row.org_slug}/${slug}${tail}`, 302);
};

app.get("/boards/:slug/*", legacyBoardRedirect);
app.get("/boards/:slug", legacyBoardRedirect);

// API-shaped paths keep their JSON 404; everything else is the SPA.
const API_PREFIXES = ["/api/", "/auth/", "/mcp", "/healthz", "/.well-known/"];

// SPA fallback: built asset files are served by the platform before the
// Worker runs, so any GET that reaches here (/, /boards, /@handle/…) gets
// index.html and Solid Router takes over client-side.
app.get("*", async (c) => {
  if (API_PREFIXES.some((p) => c.req.path === p || c.req.path.startsWith(p))) {
    return c.json({ error: "not_found", path: c.req.path }, 404);
  }
  const assets = c.env.ASSETS;
  if (assets === undefined) return c.json({ error: "not_found", path: c.req.path }, 404);
  return assets.fetch(new URL("/index.html", c.req.url));
});

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

// Durable Object classes must be exported from the Worker entrypoint.
export { BoardDO } from "./durable-objects/BoardDO";

export default app;
