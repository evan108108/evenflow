import { Hono } from "hono";
import { Effect } from "effect";
import { AuditLog, Db, bootstrap } from "./effects";
import { asShortId } from "./slug";
import { INVITE_CODE_PREFIX } from "./roles";
import type { AppHonoEnv } from "./http";
import { optionalAuth } from "./middleware/requireAuth";
import { mountAll } from "./router";
import { scheduled } from "./scheduled";

const app = new Hono<AppHonoEnv>();

// The Effect handler pattern every future route follows: describe the work
// as an Effect against service Tags, then run it against the per-request
// Live environment from `bootstrap(c.env)`.
// EFB-82: healthz also reports the git sha this Worker was built from.
//
// This is the source of truth for "what is actually live", deliberately in
// preference to deploy metadata. Two reasons. Wrangler 3's `deploy` has no
// `--message` flag at all (only `versions upload` does, which is a different
// gradual-rollout workflow), so the metadata channel the ticket assumed does
// not exist here. And metadata describes what someone INTENDED to ship, while
// a value compiled into the running Worker proves what IS shipped — the
// distinction that made the EFB-14 FTS5 rollback undiagnosable for 34 hours.
//
// DELIBERATELY UNAUTHENTICATED — do not auth-gate this in a consistency pass.
//
// Three reasons, in order of weight:
//
//  1. The predeploy check must read it with nothing but git and curl, from any
//     machine, before any credentials are loaded. Gating it defeats the whole
//     primitive.
//  2. It discloses nothing. evan108108/evenflow is a PUBLIC repo, so every
//     commit sha is already enumerable by anyone via `git ls-remote`. Saying
//     "the live build came from a commit in that public history" is zero
//     information gain.
//  3. It is a different class from EFB-76's 401-not-404 rule. That rule governs
//     reads whose ANSWER VARIES PER CALLER and thereby reveals whether private
//     things exist. This returns one identical, content-free answer to
//     everybody. Version and diagnostic surfaces are conventionally open for
//     exactly that reason.
app.get("/healthz", async (c) => {
  const gitSha = c.env.GIT_SHA ?? null;
  const healthz = Effect.gen(function* () {
    const audit = yield* AuditLog;
    yield* audit.record({ event_type: "healthz_check", details: { path: c.req.path } });
    return {
      ok: true,
      service: "evenflow",
      version: "0.0.1",
      // null means "deployed without the wrapper, or before EFB-82" — the
      // predeploy check treats that as refuse-by-default, not as fine.
      git_sha: gitSha,
      git_sha_short: gitSha === null ? null : gitSha.slice(0, 7),
    };
  });
  return c.json(await Effect.runPromise(Effect.provide(healthz, bootstrap(c.env))));
});

// Phase 16: /api/v0/* runs behind OPTIONAL auth — a present JWT must be
// valid (401 otherwise), an absent one passes through anonymous so public
// boards read without sign-in. Every mutation gates on requireCaller.
//
// Registered before mountAll so it wraps every /api/v0 router below. The
// /auth, / and /mcp mounts sit outside it by design and are unaffected.
app.use("/api/v0/*", optionalAuth());

// EFB-100 removed a `GET /api/v0/me` placeholder that lived here — a phase-16
// demo that echoed the verified claims, registered directly on the app rather
// than through the manifest, and called by nothing (tests/auth.test.ts
// registers its own copy on a test app, so they are unaffected).
//
// It had to go before the manifest could be a security perimeter. Scope
// enforcement fails CLOSED on a route with no manifest entry, so this one
// would have answered 403 to every scoped key — a route nobody remembered
// existed, refusing traffic for a reason nobody would think to look for. More
// to the point, its existence quietly falsified the claim the perimeter rests
// on, written at the top of routes-manifest.ts: that a route not in the
// manifest does not exist. Deleting it makes that sentence true.

// EFB-98: every mount, in order, from the one table in src/router.ts. The
// list that used to live here was copied into three test files and had
// already drifted from all of them.
mountAll(app);

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
  // Singular /issue/ (EFB-89): this is the canonical emitter for every
  // pasted ref, so it mints the canonical form. The plural route still
  // resolves for links minted before the rename.
  if (row.org_slug === null) {
    return c.redirect(`/boards/${row.board_slug}/issue/${shortId}`, 302);
  }
  return c.redirect(`/@${row.org_slug}/${row.board_slug}/issue/${shortId}`, 302);
});

// Legacy board URLs 302 to the canonical /@{handle}/{board} namespace when
// the board resolves to an org; sub-paths (backlog, issue/FLOW-1, …) keep
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

// The default export carries both entrypoints since EFB-22 added the tide
// cron: `app.fetch` alone would leave `[triggers]` in wrangler.toml firing
// into a Worker with no scheduled handler.
export default { fetch: app.fetch, scheduled };
