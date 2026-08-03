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
// THE FALLBACK (EFB-90)
//
//   Ancestry is a PROXY. The question that matters is "does prod contain work
//   I would revert"; the proxy answers "is the deployed sha in my history".
//   Those diverge on exactly one very ordinary event: a squash-merge. GitHub
//   rewrites the branch into a new commit, orphaning the sha that was deployed
//   — the content shipped, the sha did not survive. This repo squash-merges by
//   default, so every deploy-from-branch was going to hit a false refusal on
//   the next ship (it did: PR #54's dc148f28, worked around by hand via a
//   --no-ff merge in PR #57).
//
//   So when the proxy refuses, ask the real question directly before believing
//   it. Three content checks, cheapest first, each reported on its own line so
//   the log names WHICH one cleared the deploy:
//
//     tree      live's tree == HEAD's tree. Deploying ships byte-identical
//               content; there is nothing a revert could even touch.
//     squash    live's cumulative diff already landed in HEAD's history as one
//               commit — patch-identical, different sha. The squash-merge.
//     replay    every commit live carries has a patch-equivalent in HEAD.
//               Covers rebase-merge and cherry-picks, one `gh` flag away.
//
//   All three are "is live's work already in what I am shipping", answered by
//   content rather than by identity. Only if all three say no is the refusal
//   real. Anything that errors mid-check — no merge base, unreadable object,
//   git failing — refuses, same posture as the rest of this script.
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

const short = (sha) => sha.slice(0, 7);

const fail = (headline, ...lines) => {
  console.error(`\n✘ predeploy: ${headline}\n`);
  for (const l of lines) console.error(`  ${l}`);
  console.error("");
  process.exit(1);
};

const head = git("rev-parse", "HEAD");

/**
 * Sample /healthz several times and require the answers to agree.
 *
 * Worker versions propagate across edge isolates rather than flipping at
 * once: for a window after a deploy, some locations still answer from the
 * previous version. Observed live while building this — the first read after
 * a deploy reported the OLD sha and the next three the new one.
 *
 * One sample is therefore not evidence. The dangerous direction is subtle: a
 * stale isolate reporting an older sha that happens to BE an ancestor would
 * clear a deploy that the true live sha would have blocked. So disagreement
 * is treated as its own refusal — mid-rollout, "what is live" has no single
 * answer, and that is precisely when you should not be deploying over it.
 *
 * The cache-buster is belt-and-braces: this route sends no cf-cache-status
 * today, but CDN config is not a stable assumption to build a safety check on.
 */
const SAMPLES = 3;
const sample = async (i) => {
  const url = `${HEALTH_URL}${HEALTH_URL.includes("?") ? "&" : "?"}_pd=${Date.now()}-${i}`;
  const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) fail(`${HEALTH_URL} answered ${res.status}.`, "Cannot establish what is live. Not deploying blind.");
  return res.json();
};

let observed = [];
try {
  for (let i = 0; i < SAMPLES; i++) observed.push(await sample(i));
} catch (e) {
  fail(
    `could not reach ${HEALTH_URL} (${e.message}).`,
    "Cannot establish what is live. Not deploying blind.",
    "If prod is genuinely down and you are deploying to fix it, re-run with ALLOW_UNSTAMPED=1.",
  );
}

const seen = [...new Set(observed.map((o) => o?.git_sha ?? null))];
if (seen.length > 1) {
  fail(
    "prod is answering with more than one version right now.",
    `Saw: ${seen.map((s) => (s === null ? "unstamped" : s.slice(0, 7))).join(", ")}`,
    "",
    "A deploy is still propagating across the edge, so there is no single",
    "answer to what is live. Wait for it to settle and re-run — deploying into",
    "a rollout means you cannot know what you are replacing.",
  );
}

const liveSha = seen[0] ?? null;

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

if (isAncestor) {
  const behind = git("rev-list", "--count", `${liveSha}..${head}`);
  console.log(`✓ predeploy: ancestry — live ${short(liveSha)} is an ancestor of HEAD ${short(head)}.`);
  console.log(`  Shipping ${behind} commit(s) — nothing live will be reverted.`);
  process.exit(0);
}

// ── Ancestry says no. Ask the question ancestry was standing in for. ────────
//
// Reported rather than silent even when a later check clears the deploy: an
// allow that skipped the fast path is worth a line in the log, because the
// reader needs to know the deploy went out on content evidence.
console.log(`· predeploy: ancestry — live ${short(liveSha)} is NOT an ancestor of HEAD ${short(head)}.`);
console.log("  A squash-merge orphans the deployed sha, so this alone is not evidence.");
console.log("  Checking whether HEAD already contains live's content.");

const proceed = (check, ...lines) => {
  console.log(`✓ predeploy: ${check} — ${lines[0]}`);
  for (const l of lines.slice(1)) console.log(`  ${l}`);
  console.log(`  Ancestry refused, content cleared it. Shipping ${short(head)}.`);
  process.exit(0);
};

/**
 * Every content check below is one `git` call away from a bad answer, and a
 * bad answer here re-opens the 34-hour hole. So the whole fallback runs inside
 * one refusal boundary: anything that throws — unreadable object, no merge
 * base, git missing — lands in the catch and refuses. There is no path where a
 * failed probe reads as "fine".
 */
const contentChecks = () => {
  // Tree equality. The strongest evidence there is, and free: if the trees
  // match, the deploy is a content no-op and no diff exists to revert.
  const liveTree = git("rev-parse", `${liveSha}^{tree}`);
  const headTree = git("rev-parse", `${head}^{tree}`);
  if (liveTree === headTree) {
    return { check: "tree", why: [`live tree == HEAD tree (${short(headTree)}).`, "Byte-for-byte what is already live — a revert has nothing to touch."] };
  }

  // Everything past here is "is live's WORK in HEAD", which is only a
  // meaningful question against a common base.
  const mergeBase = git("merge-base", liveSha, head);

  /**
   * Commits in `mergeBase..rev` with no patch-equivalent anywhere in
   * `mergeBase..HEAD`. This is git's own merged-ness test — patch-id, so a
   * commit counts as present when its DIFF landed, whatever sha or message it
   * landed under. The limit is passed explicitly: `git cherry` infers one when
   * omitted, and this is not a place to depend on an inferred range.
   */
  const unapplied = (rev) =>
    git("cherry", head, rev, mergeBase)
      .split("\n")
      .filter((l) => l.startsWith("+"))
      .map((l) => l.slice(2).trim());

  // The squash-merge. One commit on main carries the branch's whole diff, so
  // compare against live's cumulative change rather than its commits: mint a
  // commit holding live's tree directly on the merge base, and ask whether
  // that patch already landed.
  //
  // The identity and dates are pinned so the object is a pure function of
  // (tree, base) — the same deploy checked twice mints the same sha instead of
  // littering a fresh dangling commit each run. Unreferenced either way; git
  // gc collects it. Nothing about the repo's refs or working tree moves.
  const synthetic = execFileSync(
    "git",
    ["commit-tree", liveTree, "-p", mergeBase, "-m", "predeploy: live content as a single commit"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "predeploy",
        GIT_AUTHOR_EMAIL: "predeploy@localhost",
        GIT_AUTHOR_DATE: "@0 +0000",
        GIT_COMMITTER_NAME: "predeploy",
        GIT_COMMITTER_EMAIL: "predeploy@localhost",
        GIT_COMMITTER_DATE: "@0 +0000",
      },
    },
  ).trim();

  if (unapplied(synthetic).length === 0) {
    return {
      check: "squash",
      why: [
        `live's cumulative diff already landed in HEAD's history (base ${short(mergeBase)}).`,
        `The deployed sha ${short(liveSha)} was orphaned by a squash-merge; its content shipped.`,
      ],
    };
  }

  // Rebase-merge / cherry-pick: no single commit carries the whole diff, but
  // each of live's commits was replayed under a new sha.
  const stragglers = unapplied(liveSha);
  if (stragglers.length === 0) {
    return {
      check: "replay",
      why: [
        `every commit live carries has a patch-equivalent in HEAD (base ${short(mergeBase)}).`,
        `The deployed sha ${short(liveSha)} was rewritten by a rebase-merge; its content shipped.`,
      ],
    };
  }

  return { check: null, mergeBase, stragglers };
};

const contentVerdict = (() => {
  try {
    return contentChecks();
  } catch (e) {
    // No merge base (unrelated histories), an object that will not read, git
    // itself failing — every one of these means the content question went
    // unanswered, and an unanswered question is not an answer of "safe".
    return fail(
      `the live sha ${short(liveSha)} is NOT an ancestor of HEAD ${short(head)}, and the content fallback could not run.`,
      `  ${e.message.split("\n")[0]}`,
      "",
      "Ancestry refused and nothing was able to overturn it, so the refusal stands.",
      "If live and HEAD have no common history at all, prod is running something",
      "from another repository entirely — find out what before deploying.",
    );
  }
})();

if (contentVerdict.check !== null) proceed(contentVerdict.check, ...contentVerdict.why);

// Ancestry refused and content agrees. This is the real thing.
const subject = (() => {
  try {
    return git("log", "-1", "--format=%s", liveSha);
  } catch {
    return "(unknown)";
  }
})();
const lost = contentVerdict.stragglers.map((sha) => {
  try {
    return `    ${short(sha)}  ${git("log", "-1", "--format=%s", sha)}`;
  } catch {
    return `    ${short(sha)}`;
  }
});
fail(
  `the live sha ${short(liveSha)} is NOT an ancestor of HEAD ${short(head)}, and its content is not in HEAD either.`,
  "Prod contains commits your branch does not have. Deploying would silently",
  "revert them — this is exactly how EFB-14's search endpoint died for 34 hours.",
  "",
  `  live: ${liveSha}`,
  `        ${subject}`,
  `  HEAD: ${head}`,
  "",
  "  ancestry: ✘ not in HEAD's history",
  `  content:  ✘ ${contentVerdict.stragglers.length} live commit(s) have no equivalent in HEAD`,
  ...lost,
  "",
  "So this is not a squash-merge orphan — the work is live and nowhere in what",
  "you are shipping. Someone has unmerged code live. Identify whose branch it is",
  "in channel and get it merged, or rebase onto it, before deploying.",
);
