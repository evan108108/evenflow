// predeploy-ancestry-check — refuses to deploy over code you do not have.
//
// THE FAILURE THIS EXISTS FOR (EFB-82)
//
//   2026-08-02 03:23  EFB-14 (FTS5 search) deployed from an UNMERGED branch.
//   2026-08-02 04:55  someone deployed from main — which lacked EFB-14.
//                     Search silently died and stayed dead for ~34 hours.
//
//   Nobody did anything wrong at the second deploy. Once unmerged code is
//   live, every later deploy is going to revert it, and — before this check —
//   no deployer had any way to find that out. Two people stepped on it, and
//   the first one to notice got blamed for a regression that predated them by
//   22 hours.
//
// THE CHECK
//
//   Read the sha the live Worker reports on /healthz, then assert it is an
//   ANCESTOR of what you are about to ship. If it is not, prod contains
//   commits that are not in your history — someone's unmerged branch is live,
//   and deploying would silently revert it.
//
//   Note the axis. "Is main ahead of my branch?" is a different and mostly
//   uninteresting question: it false-alarms on innocent merges (a test-only PR
//   landing on main) while completely missing this failure, because unmerged
//   deployed code is invisible to any comparison between main and your base.
//   What matters is deployed-vs-deploying, not merged-vs-base.
//
// WHY /healthz RATHER THAN THE WRANGLER API
//
//   It needs no credentials, so it runs anywhere, and it reports what the
//   running Worker actually contains rather than what a deploy record claims.
//
// USAGE
//
//   node scripts/predeploy-ancestry-check.mjs      (npm runs it before `npm run deploy`)
//
//   HEALTH_URL=https://…/healthz   override the target
//   ALLOW_UNSTAMPED=1              proceed when prod reports no sha at all
//
// Exit 0 = safe to deploy. Exit 1 = stop and read the message.

import { execFileSync } from "node:child_process";

const HEALTH_URL = process.env["HEALTH_URL"] ?? "https://evenflow.work/healthz";
const ALLOW_UNSTAMPED = process.env["ALLOW_UNSTAMPED"] === "1";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/**
 * git for the probe calls whose failure is expected and handled. Silences the
 * child's stderr: this script's entire value is one legible message, and a raw
 * `fatal: Not a valid object name` printed above it makes the reader think the
 * tool broke rather than that it caught something.
 */
const gitQuiet = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const fail = (headline, ...lines) => {
  console.error(`\n✘ predeploy: ${headline}\n`);
  for (const l of lines) console.error(`  ${l}`);
  console.error("");
  process.exit(1);
};

const head = git("rev-parse", "HEAD");

let live;
try {
  const res = await fetch(HEALTH_URL, { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) fail(`${HEALTH_URL} answered ${res.status}.`, "Cannot establish what is live. Not deploying blind.");
  live = await res.json();
} catch (e) {
  fail(
    `could not reach ${HEALTH_URL} (${e.message}).`,
    "Cannot establish what is live. Not deploying blind.",
    "If prod is genuinely down and you are deploying to fix it, re-run with ALLOW_UNSTAMPED=1.",
  );
}

const liveSha = live?.git_sha ?? null;

// Refuse-by-default rather than warn-and-continue. An unstamped prod means
// someone deployed outside the wrapper, which is the same class of unknown
// this check exists to eliminate — treating it as "probably fine" would put
// the hole straight back. The escape hatch is explicit and self-documenting,
// and the first deploy that introduces stamping legitimately needs it.
if (liveSha === null) {
  if (!ALLOW_UNSTAMPED) {
    fail(
      "the live Worker reports no git sha.",
      "It was deployed either before EFB-82 or with a bare `wrangler deploy`,",
      "bypassing `npm run deploy`. Its contents cannot be verified from here.",
      "",
      "Ask in channel whether anyone has an undeployed branch live, then:",
      "  ALLOW_UNSTAMPED=1 npm run deploy",
      "",
      "Once this deploy lands, prod is stamped and later runs verify normally.",
    );
  }
  console.log("⚠ predeploy: live Worker is unstamped; proceeding under ALLOW_UNSTAMPED=1.");
  console.log(`  Shipping ${head.slice(0, 7)} — the next check will verify against it.`);
  process.exit(0);
}

if (liveSha === head) {
  console.log(`✓ predeploy: live sha == HEAD (${head.slice(0, 7)}). Redeploying the same commit.`);
  process.exit(0);
}

// The live commit must exist locally before ancestry means anything. Fetch
// once — a live sha we have never seen is the signature of a branch deploy.
try {
  gitQuiet("cat-file", "-e", `${liveSha}^{commit}`);
} catch {
  try {
    gitQuiet("fetch", "origin", "--quiet");
    gitQuiet("cat-file", "-e", `${liveSha}^{commit}`);
  } catch {
    fail(
      `the live sha ${liveSha.slice(0, 7)} does not exist in this repository.`,
      "Prod is running a commit that has never been pushed — someone deployed",
      "from a local branch. Deploying would erase work that exists nowhere else.",
      "",
      "Find whose branch is live before proceeding.",
    );
  }
}

const isAncestor = (() => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", liveSha, head], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (!isAncestor) {
  const subject = (() => {
    try {
      return git("log", "-1", "--format=%s", liveSha);
    } catch {
      return "(unknown)";
    }
  })();
  fail(
    `the live sha ${liveSha.slice(0, 7)} is NOT an ancestor of HEAD ${head.slice(0, 7)}.`,
    "Prod contains commits your branch does not have. Deploying would silently",
    "revert them — this is exactly how EFB-14's search endpoint died for 34 hours.",
    "",
    `  live: ${liveSha}`,
    `        ${subject}`,
    `  HEAD: ${head}`,
    "",
    "Someone has unmerged code live. Identify whose branch it is in channel and",
    "get it merged, or rebase onto it, before deploying.",
  );
}

const behind = git("rev-list", "--count", `${liveSha}..${head}`);
console.log(`✓ predeploy: live ${liveSha.slice(0, 7)} is an ancestor of HEAD ${head.slice(0, 7)}.`);
console.log(`  Shipping ${behind} commit(s) — nothing live will be reverted.`);
