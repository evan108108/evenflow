import { Hono } from "hono";
import { Effect } from "effect";
import { AuditLog, Db, bootstrap } from "./effects";
import { asShortId } from "./slug";
import type { AppHonoEnv } from "./http";
import { requireAuth } from "./middleware/requireAuth";
import { makeAuthRouter } from "./routes/auth";
import { makeBoardsRouter } from "./routes/boards";
import { makeCommentsRouter } from "./routes/comments";
import { makeFeedRouter } from "./routes/feed";
import { makeIssuesRouter } from "./routes/issues";
import { makeMcpRouter } from "./routes/mcp";
import { makeProfileRouter } from "./routes/profile";
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

// Every /api/v0/* route requires a valid 4a JWT.
app.use("/api/v0/*", requireAuth());

// Placeholder demonstrating the middleware end-to-end: echoes the verified claims.
app.get("/api/v0/me", (c) => c.json(c.get("claims")));

app.route("/api/v0", makeBoardsRouter());
app.route("/api/v0", makeIssuesRouter());
app.route("/api/v0", makeCommentsRouter());
app.route("/api/v0", makeFeedRouter());
app.route("/api/v0", makeProfileRouter());

// /i/FLOW-42 — the paste-anywhere deep link (git commits, chat). Resolves
// the board slug server-side and bounces to the full SPA URL. Unauthed on
// purpose: it discloses only slug + issue existence, and the destination
// page still demands a JWT; requiring auth here would break pasted links.
app.get("/i/:shortId", async (c) => {
  const shortId = asShortId(c.req.param("shortId"));
  if (shortId === null) return c.redirect("/", 302);
  const program = Effect.flatMap(Db, (db) =>
    db.queryFirst<{ slug: string }>(
      "SELECT boardCache.slug AS slug FROM issueCache JOIN boardCache ON boardCache.id = issueCache.board_id WHERE issueCache.short_id = ?",
      [shortId],
    ),
  );
  const row = await Effect.runPromise(
    Effect.provide(program, bootstrap(c.env)).pipe(Effect.catchAll(() => Effect.succeed(null))),
  );
  if (row === null) return c.redirect("/", 302);
  return c.redirect(`/boards/${row.slug}/issues/${shortId}`, 302);
});

// API-shaped paths keep their JSON 404; everything else is the SPA.
const API_PREFIXES = ["/api/", "/auth/", "/mcp", "/healthz", "/.well-known/"];

// SPA fallback: built asset files are served by the platform before the
// Worker runs, so any GET that reaches here (/, /boards, /boards/x/…) gets
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
