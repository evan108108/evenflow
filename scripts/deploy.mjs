// deploy — wrangler deploy with the git sha stamped into the Worker (EFB-82).
//
// The stamp is what makes `predeploy-ancestry-check.mjs` possible: it is read
// back from /healthz on the next deploy to prove what is actually live. See
// that file's header for the 34-hour FTS5 outage this pair exists to prevent.
//
// Wrangler 3's `deploy` has no `--message`/annotation flag (only
// `versions upload` does, a different gradual-rollout workflow), so the sha
// travels as a plain var compiled into the running Worker. That is the better
// channel anyway: deploy metadata records what someone meant to ship, a var
// inside the Worker proves what it IS.
//
// USAGE
//
//   npm run deploy              (npm runs the predeploy check first)
//   npm run deploy -- --dry-run (flags pass through to wrangler)
//
// Refuses on a dirty tree: a stamp that claims a commit the build does not
// match is worse than no stamp, because the next check would trust it.
// DEPLOY_ALLOW_DIRTY=1 overrides for genuine emergencies.

import { execFileSync, spawnSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const sha = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain");

if (dirty !== "" && process.env["DEPLOY_ALLOW_DIRTY"] !== "1") {
  console.error(
    `\n✘ deploy: working tree is dirty — the stamp would claim ${sha.slice(0, 7)},\n` +
      `  but that is not what would ship. A stamp that lies is worse than none:\n` +
      `  the next predeploy check would trust it and clear a deploy it should stop.\n\n` +
      `  Commit or stash first, or set DEPLOY_ALLOW_DIRTY=1 if you accept the risk.\n`,
  );
  console.error(dirty.split("\n").map((l) => `    ${l}`).join("\n"));
  console.error("");
  process.exit(1);
}

const passthrough = process.argv.slice(2);

// Rebuild the SPA before wrangler picks up ./dist/web. Skipping this is how the
// Worker ships against a stale bundle: /healthz agrees, the SPA hash on the
// served HTML still points at the pre-fix chunk, and prod stays broken while
// the deploy looks green. dist/web is gitignored, so this cannot dirty the
// tree — the ancestry check above stays honest.
console.log(`→ building web SPA`);
const webBuild = spawnSync("npm", ["--prefix", "web", "run", "build"], { stdio: "inherit" });
if (webBuild.status !== 0) {
  console.error("\n✘ deploy: web build failed — aborting before wrangler runs.");
  process.exit(webBuild.status ?? 1);
}

const args = ["wrangler", "deploy", "--var", `GIT_SHA:${sha}`, ...passthrough];

console.log(`→ deploying ${sha.slice(0, 7)}${dirty === "" ? "" : " (DIRTY — stamp is approximate)"}`);

const res = spawnSync("npx", args, { stdio: "inherit" });
if (res.status !== 0) process.exit(res.status ?? 1);

console.log(`\n✓ deployed ${sha.slice(0, 7)}. Verify: curl -s https://evenflow.work/healthz`);
