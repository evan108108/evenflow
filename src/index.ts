import { Hono } from "hono";
import { html } from "hono/html";
import { Effect } from "effect";
import { AuditLog, bootstrap } from "./effects";
import type { AppHonoEnv } from "./http";
import { requireAuth } from "./middleware/requireAuth";
import { makeAuthRouter } from "./routes/auth";
import { makeBoardsRouter } from "./routes/boards";
import { makeCommentsRouter } from "./routes/comments";
import { makeIssuesRouter } from "./routes/issues";

const app = new Hono<AppHonoEnv>();

app.get("/", (c) => {
  return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Evenflow — The Even Flow of Work</title>
  <meta name="description" content="A kanban built on 4a. Free. Yours. Under construction." />
  <style>
    :root { color-scheme: light dark; }
    html, body { margin: 0; padding: 0; height: 100%; }
    body {
      font: 400 16px/1.6 -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
      background: #f5f2ec;
      color: #17233b;
      display: grid;
      place-items: center;
      min-height: 100vh;
      padding: 3rem 1.5rem;
      box-sizing: border-box;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0f0d1f; color: #eeeae0; }
    }
    main { max-width: 42rem; text-align: center; }
    h1 {
      font-family: "Bodoni Moda", "Playfair Display", Georgia, serif;
      font-weight: 700;
      font-size: clamp(3rem, 12vw, 6rem);
      letter-spacing: -0.03em;
      line-height: 0.9;
      margin: 0 0 1rem;
    }
    .tag { font-size: 1.25rem; font-style: italic; opacity: 0.75; margin: 0 0 3rem; }
    p { opacity: 0.7; }
    a { color: inherit; }
    .status {
      display: inline-block;
      margin-top: 2rem;
      padding: 0.4rem 0.9rem;
      border: 1px solid currentColor;
      border-radius: 999px;
      font-size: 0.75rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      opacity: 0.6;
    }
  </style>
</head>
<body>
  <main>
    <h1>Evenflow</h1>
    <p class="tag">The Even Flow of Work.</p>
    <p>A kanban built on <a href="https://4a4.ai">4a</a>. Free. Yours.</p>
    <p><a href="https://github.com/evan108108/evenflow">github.com/evan108108/evenflow</a></p>
    <div class="status">Under construction</div>
  </main>
</body>
</html>`);
});

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

// Every /api/v0/* route requires a valid 4a JWT.
app.use("/api/v0/*", requireAuth());

// Placeholder demonstrating the middleware end-to-end: echoes the verified claims.
app.get("/api/v0/me", (c) => c.json(c.get("claims")));

app.route("/api/v0", makeBoardsRouter());
app.route("/api/v0", makeIssuesRouter());
app.route("/api/v0", makeCommentsRouter());

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

export default app;
