// EFB-82 — the predeploy ancestry check, exercised end-to-end.
//
// These run the real script against a local stand-in for /healthz rather than
// unit-testing its parts. The thing that has to be true is "it refuses the
// states that would silently revert someone's work and clears the ones that
// wouldn't", and that is a property of the whole script — the fetch, the git
// plumbing, and the exit code together.
//
// The non-ancestor cases use `git commit-tree` to mint DANGLING commits: real
// objects, reachable from no ref, therefore genuinely not ancestors of HEAD.
// They mutate nothing — no branch moves, no index touched, and the objects are
// unreferenced. That is what the live sha looks like when someone deploys a
// branch, which is the state that killed EFB-14's search for 34 hours.
//
// EFB-90 split that shape in two, because "not an ancestor" turned out to
// cover both the disaster and an entirely ordinary squash-merge:
//
//   orphaned  — live's content DID land on main under a rewritten sha. The
//               deploy is safe and must be cleared, or the check false-blocks
//               every ship in a squash-merging repo (it did, on PR #54).
//   divergent — live carries work that exists nowhere in HEAD. Refuse.
//
// A fixture is only evidence if it exhibits the property it is named for, so
// each is built to differ from the other in exactly that respect and nothing
// else: same construction, different content relationship to HEAD.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "..");
const SCRIPT = resolve(REPO, "scripts/predeploy-ancestry-check.mjs");

/**
 * EFB-85 — the fixtures build their OWN repository.
 *
 * They used to read this one: `commit-tree $(rev-parse HEAD~1^{tree}) -p HEAD~2`
 * against the checkout the suite happened to be running in. That silently
 * assumed the last few commits were ordinary single-parent commits carrying
 * independent diffs — true on a linear branch, false the moment main's tip is a
 * MERGE commit, because a merge's tree folds in a side branch and the
 * re-parented synthetic no longer patch-matches anything.
 *
 * The result was a test that passed or failed according to the shape of
 * whatever landed on main most recently, with no relationship to the code under
 * test. It went red for every worker who branched off main while its tip was a
 * merge; an EMPTY commit touching zero files reproduced it exactly. The failure
 * count even tracked the graph shape — two, then one, as main moved.
 *
 * A fixture whose verdict depends on unrelated history is not evidence. So the
 * history is now built here: five linear commits, each adding one distinct
 * file, with identity and dates pinned so the whole graph is reproducible. The
 * script is pure `git` + `fetch` and takes its repo from the process CWD, so
 * pointing `run()` at the scratch tree is the entire redirection.
 *
 * This also makes the fixtures say what they mean. `HEAD~2` used to be whatever
 * a colleague shipped on Tuesday; it is now a commit this file wrote, one line
 * up, for a stated reason.
 */
let SCRATCH: string;

const GIT_IDENT = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@localhost",
  GIT_AUTHOR_DATE: "@1700000000 +0000",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@localhost",
  GIT_COMMITTER_DATE: "@1700000000 +0000",
} as const;

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: SCRATCH,
    encoding: "utf8",
    env: { ...process.env, ...GIT_IDENT },
  }).trim();

const gitIn = (input: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd: SCRATCH,
    encoding: "utf8",
    input,
    env: { ...process.env, ...GIT_IDENT },
  }).trim();

/**
 * Five commits, linear, each adding one file nobody else touches.
 *
 * Depth is load-bearing: the replay fixture reaches back to `HEAD~3`, and the
 * one-distinct-file-per-commit shape is what makes each commit's patch
 * independent — so a re-parented tree reproduces exactly one original patch and
 * `git cherry`'s patch-id match is unambiguous.
 */
const buildScratchRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "efb85-predeploy-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_IDENT } });
  run("init", "-q", "-b", "main");
  run("config", "user.name", "fixture");
  run("config", "user.email", "fixture@localhost");
  run("config", "commit.gpgsign", "false");
  for (let i = 1; i <= 5; i++) {
    writeFileSync(join(dir, `file-${i}.txt`), `content of commit ${i}\n`);
    run("add", "-A");
    run("commit", "-q", "-m", `commit ${i}`);
  }
  return dir;
};

/**
 * A tree that is HEAD's plus one file nobody has ever committed — the content
 * signature of an unmerged branch. Written straight to the object store with
 * plumbing: `hash-object -w` and `mktree` never consult the index or the
 * working tree, so this cannot disturb the repo the suite is running inside.
 */
const treeWithNovelFile = (name: string, body: string) => {
  const blob = gitIn(body, "hash-object", "-w", "--stdin");
  return gitIn(`${git("ls-tree", "HEAD")}\n100644 blob ${blob}\t${name}\n`, "mktree");
};

/** Serves whatever body the current test assigns, standing in for /healthz. */
let server: Server;
let port: number;
let body: unknown = {};
let status = 200;
/** When set, successive requests get successive entries — simulates an
 *  edge mid-rollout answering from two Worker versions at once. */
let bodySequence: unknown[] | null = null;
let served = 0;

beforeAll(async () => {
  SCRATCH = buildScratchRepo();
  server = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    const next =
      bodySequence === null ? body : (bodySequence[served] ?? bodySequence[bodySequence.length - 1]);
    served += 1;
    res.end(JSON.stringify(next));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** Reset the response mode between tests so ordering can't leak. */
const serve = (b: unknown, seq: unknown[] | null = null) => {
  body = b;
  bodySequence = seq;
  served = 0;
  status = 200;
};

const run = (env: Record<string, string> = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((ok) => {
    execFile(
      "node",
      [SCRIPT],
      {
        // The scratch repo, not this one. The script reads its repo from the
        // process CWD, so this single line is what makes every fixture below
        // independent of whatever main's history currently looks like.
        cwd: SCRATCH,
        env: { ...process.env, HEALTH_URL: `http://127.0.0.1:${port}/healthz`, ...env },
      },
      (err, stdout, stderr) => {
        ok({ code: err === null ? 0 : ((err as { code?: number }).code ?? 1), stdout, stderr });
      },
    );
  });

describe("predeploy ancestry check", () => {
  it("clears a deploy when the live sha is an ancestor of HEAD", async () => {
    serve({ ok: true, git_sha: git("rev-parse", "HEAD~1") });
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("is an ancestor of HEAD");
    // Names how much is being released — the accumulated diff, not just "your"
    // commit. Deploying always ships everything below the target.
    expect(r.stdout).toMatch(/Shipping \d+ commit\(s\)/);
  });

  it("clears a redeploy of the identical commit", async () => {
    serve({ ok: true, git_sha: git("rev-parse", "HEAD") });
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("live sha == HEAD");
  });

  it("REFUSES when the live sha is not an ancestor AND carries work HEAD lacks — the EFB-14 state", async () => {
    // A real commit, parented one back from HEAD, reachable from no ref, and
    // holding a file that exists in no commit anywhere. Content-wise this is
    // unambiguously someone's unmerged branch: no fallback can find its work
    // in HEAD, because its work is not there.
    const dangling = git(
      "commit-tree",
      treeWithNovelFile("efb-90-unmerged-fixture.txt", "work that only exists in prod\n"),
      "-p",
      "HEAD~1",
      "-m",
      "someone's unmerged branch",
    );
    serve({ ok: true, git_sha: dangling });
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("NOT an ancestor");
    // Whitespace-tolerant: the message hard-wraps, so a literal substring
    // would be asserting on the line width rather than on what it says.
    expect(r.stderr).toMatch(/silently\s+revert/);
    // The message has to say what to DO, not just that something is wrong.
    expect(r.stderr).toContain("Identify whose branch");
    // Both verdicts on the record. A refusal that only reports the proxy is
    // the thing EFB-90 had to unpick — the reader needs to see that the
    // content question was asked too, and also said no.
    expect(r.stderr).toMatch(/ancestry:\s+✘/);
    expect(r.stderr).toMatch(/content:\s+✘ 1 live commit\(s\)/);
    expect(r.stderr).toContain("someone's unmerged branch");
  });

  // EFB-90. GitHub squash-merges rewrite the branch into a new commit, so the
  // sha that was deployed survives nowhere in main's history even though every
  // line it carried did. Ancestry cannot tell that apart from the case above;
  // content can. Without this the check false-blocks every deploy in a
  // squash-merging repo, which is what it did to PR #54's dc148f28 in prod.
  //
  // The fixture is the real shape: HEAD~1's tree re-committed onto HEAD~2 is
  // patch-identical to HEAD~1 under a sha that is an ancestor of nothing.
  it("clears a squash-merge orphan whose content already landed in HEAD", async () => {
    const orphan = git(
      "commit-tree",
      git("rev-parse", "HEAD~1^{tree}"),
      "-p",
      "HEAD~2",
      "-m",
      "branch tip as deployed, before the squash rewrote it",
    );
    serve({ ok: true, git_sha: orphan });
    const r = await run();
    expect(r.code).toBe(0);
    // Names which check cleared it, so the audit trail says WHY this deploy
    // went out over a refusing proxy rather than just that it did.
    expect(r.stdout).toContain("predeploy: squash");
    expect(r.stdout).toContain("NOT an ancestor");
    expect(r.stdout).toMatch(/already landed in HEAD's history/);
  });

  // The cheapest fallback, and the strongest: if the trees match there is no
  // diff for a deploy to revert, whatever the shas say. (This was EFB-82's
  // refusal fixture — it asserted "unmerged branch" while holding HEAD's exact
  // content, so under a content check it is now, correctly, an allow.)
  it("clears a non-ancestor whose tree is identical to HEAD's", async () => {
    const twin = git("commit-tree", git("rev-parse", "HEAD^{tree}"), "-p", "HEAD~1", "-m", "same content, different sha");
    serve({ ok: true, git_sha: twin });
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("predeploy: tree");
    expect(r.stdout).toContain("live tree == HEAD tree");
  });

  // Rebase-merge replays each commit under a new sha instead of collapsing
  // them, so the cumulative-diff test misses and the per-commit one catches
  // it. Covered now rather than after it bites: it is one `gh pr merge` flag
  // away from being this repo's default, and the failure it would produce is
  // the same false refusal.
  it("clears a rebase-merge replay, where each commit landed separately", async () => {
    // Two commits' worth of work, re-parented onto their own base: no single
    // commit in HEAD carries the whole diff, but each half is in there.
    const replayed = git(
      "commit-tree",
      git("rev-parse", "HEAD~1^{tree}"),
      "-p",
      git("commit-tree", git("rev-parse", "HEAD~2^{tree}"), "-p", "HEAD~3", "-m", "replayed 1/2"),
      "-m",
      "replayed 2/2",
    );
    serve({ ok: true, git_sha: replayed });
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/predeploy: (replay|squash)/);
  });

  // Fail-safe. The fallback exists to overturn a refusal, so its own failure
  // must never read as permission: an unanswered question is not an answer.
  it("REFUSES when live shares no history with HEAD and content cannot be compared", async () => {
    const unrelated = git(
      "commit-tree",
      treeWithNovelFile("efb-90-unrelated-fixture.txt", "from another repository entirely\n"),
      "-m",
      "parentless root commit",
    );
    serve({ ok: true, git_sha: unrelated });
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("content fallback could not run");
    expect(r.stderr).toContain("the refusal stands");
  });

  it("REFUSES an unstamped prod by default, and says how to proceed", async () => {
    serve({ ok: true, git_sha: null });
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no git sha");
    expect(r.stderr).toContain("ALLOW_UNSTAMPED=1");
  });

  it("proceeds past an unstamped prod only with the explicit override", async () => {
    serve({ ok: true, git_sha: null });
    const r = await run({ ALLOW_UNSTAMPED: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("unstamped");
  });

  // Found by running the check against real prod right after deploying it:
  // the first read reported the OLD sha and the next three the new one.
  // Worker versions propagate across edge isolates rather than flipping
  // atomically, so a single sample is not evidence of what is live. The
  // dangerous direction is a stale isolate reporting an older sha that
  // happens to BE an ancestor, which would clear a deploy the true live sha
  // would have blocked.
  it("REFUSES when prod answers with two different versions mid-rollout", async () => {
    const a = git("rev-parse", "HEAD~1");
    const b = git("rev-parse", "HEAD~2");
    serve(null, [{ ok: true, git_sha: a }, { ok: true, git_sha: b }, { ok: true, git_sha: b }]);
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("more than one version");
    expect(r.stderr).toMatch(/Wait for it to settle/);
  });

  it("treats a stamped/unstamped split as disagreement too", async () => {
    serve(null, [{ ok: true, git_sha: git("rev-parse", "HEAD~1") }, { ok: true, git_sha: null }, { ok: true, git_sha: null }]);
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("more than one version");
    expect(r.stderr).toContain("unstamped");
  });

  it("REFUSES when /healthz is unreachable rather than assuming the best", async () => {
    const r = await run({ HEALTH_URL: "http://127.0.0.1:1/healthz" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Not deploying blind");
  });

  it("REFUSES on a non-200 from /healthz", async () => {
    serve({ error: "boom" });
    status = 500;
    const r = await run();
    status = 200;
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("answered 500");
  });
});
