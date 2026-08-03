// EFB-82 — the predeploy ancestry check, exercised end-to-end.
//
// These run the real script against a local stand-in for /healthz rather than
// unit-testing its parts. The thing that has to be true is "it refuses the
// states that would silently revert someone's work and clears the ones that
// wouldn't", and that is a property of the whole script — the fetch, the git
// plumbing, and the exit code together.
//
// The non-ancestor case uses `git commit-tree` to mint a DANGLING commit: a
// real object, reachable from no ref, therefore genuinely not an ancestor of
// HEAD. It mutates nothing — no branch moves, and the object is unreferenced.
// That is what the live sha looks like when someone deploys an unmerged
// branch, which is the exact state that killed EFB-14's search for 34 hours.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..");
const SCRIPT = resolve(REPO, "scripts/predeploy-ancestry-check.mjs");

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();

/** Serves whatever body the current test assigns, standing in for /healthz. */
let server: Server;
let port: number;
let body: unknown = {};
let status = 200;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
});

const run = (env: Record<string, string> = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((ok) => {
    execFile(
      "node",
      [SCRIPT],
      {
        cwd: REPO,
        env: { ...process.env, HEALTH_URL: `http://127.0.0.1:${port}/healthz`, ...env },
      },
      (err, stdout, stderr) => {
        ok({ code: err === null ? 0 : ((err as { code?: number }).code ?? 1), stdout, stderr });
      },
    );
  });

describe("predeploy ancestry check", () => {
  it("clears a deploy when the live sha is an ancestor of HEAD", async () => {
    body = { ok: true, git_sha: git("rev-parse", "HEAD~1") };
    status = 200;
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("is an ancestor of HEAD");
    // Names how much is being released — the accumulated diff, not just "your"
    // commit. Deploying always ships everything below the target.
    expect(r.stdout).toMatch(/Shipping \d+ commit\(s\)/);
  });

  it("clears a redeploy of the identical commit", async () => {
    body = { ok: true, git_sha: git("rev-parse", "HEAD") };
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("live sha == HEAD");
  });

  it("REFUSES when the live sha is not an ancestor — the EFB-14 state", async () => {
    // A real commit, parented one back from HEAD, reachable from no ref.
    const dangling = git("commit-tree", `${git("rev-parse", "HEAD^{tree}")}`, "-p", "HEAD~1", "-m", "someone's unmerged branch");
    body = { ok: true, git_sha: dangling };
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("NOT an ancestor");
    // Whitespace-tolerant: the message hard-wraps, so a literal substring
    // would be asserting on the line width rather than on what it says.
    expect(r.stderr).toMatch(/silently\s+revert/);
    // The message has to say what to DO, not just that something is wrong.
    expect(r.stderr).toContain("Identify whose branch");
  });

  it("REFUSES an unstamped prod by default, and says how to proceed", async () => {
    body = { ok: true, git_sha: null };
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no git sha");
    expect(r.stderr).toContain("ALLOW_UNSTAMPED=1");
  });

  it("proceeds past an unstamped prod only with the explicit override", async () => {
    body = { ok: true, git_sha: null };
    const r = await run({ ALLOW_UNSTAMPED: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("unstamped");
  });

  it("REFUSES when /healthz is unreachable rather than assuming the best", async () => {
    const r = await run({ HEALTH_URL: "http://127.0.0.1:1/healthz" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Not deploying blind");
  });

  it("REFUSES on a non-200 from /healthz", async () => {
    status = 500;
    body = { error: "boom" };
    const r = await run();
    status = 200;
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("answered 500");
  });
});
