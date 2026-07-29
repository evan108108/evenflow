#!/usr/bin/env node
// One-shot backfill for migration 0003 (short issue ids): derives an
// issue_prefix for every board that lacks one, then numbers that board's
// short_id-less issues in created_at_ms order starting from the board's
// current next_issue_number, and advances the counter.
//
// Prefix derivation mirrors src/slug.ts — SQL migrations can't run string
// logic, which is why this lives out-of-band. Safe to re-run: it only
// touches NULL prefixes / NULL short_ids, and the counter update is
// MAX-guarded against concurrent creates.
//
// Usage (needs the CF creds in the environment):
//   set -a; source /Users/evan/projects/4a/.env; set +a
//   node scripts/backfill-short-ids.mjs [--local]

import { execFileSync } from "node:child_process";

const REMOTE_FLAG = process.argv.includes("--local") ? "--local" : "--remote";

const PREFIX_MIN_LEN = 2;
const PREFIX_MAX_LEN = 5;
const STOPWORDS = new Set(["THE", "A", "AN", "MY"]);

const derivePrefix = (title) => {
  const words = title
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w !== "");
  if (words.length > 1 && STOPWORDS.has(words[0])) words.shift();
  const usable = words.filter((w) => w.length >= 2);
  let prefix =
    usable.length >= 2
      ? usable.slice(0, PREFIX_MAX_LEN).map((w) => w[0]).join("")
      : (usable[0] ?? words.join("")).slice(0, 3);
  if (prefix.length < PREFIX_MIN_LEN) {
    const letters = words.join("");
    prefix = (prefix + letters.slice(prefix.length)).slice(0, PREFIX_MAX_LEN);
  }
  return prefix.slice(0, PREFIX_MAX_LEN).padEnd(PREFIX_MIN_LEN, "X");
};

const uniquePrefix = (base, taken) => {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, PREFIX_MAX_LEN - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
};

const d1 = (sql) => {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "evenflow", REMOTE_FLAG, "--json", "--command", sql],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" },
  );
  const parsed = JSON.parse(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first?.success === false) throw new Error(`D1 statement failed: ${sql}`);
  return first?.results ?? [];
};

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const boards = d1(
  "SELECT id, title, issue_prefix, next_issue_number FROM boardCache ORDER BY created_at_ms ASC",
);
console.log(`[backfill] boards: ${JSON.stringify(boards)}`);

const taken = new Set(boards.map((b) => b.issue_prefix).filter((p) => p != null));

for (const board of boards) {
  let prefix = board.issue_prefix;
  if (prefix == null) {
    prefix = uniquePrefix(derivePrefix(board.title), taken);
    taken.add(prefix);
    d1(
      `UPDATE boardCache SET issue_prefix = ${q(prefix)} WHERE id = ${q(board.id)} AND issue_prefix IS NULL`,
    );
    console.log(`[backfill] board ${board.id} "${board.title}" → prefix ${prefix}`);
  }

  const pending = d1(
    `SELECT id FROM issueCache WHERE board_id = ${q(board.id)} AND short_id IS NULL ORDER BY created_at_ms ASC, id ASC`,
  );
  if (pending.length === 0) continue;

  let n = Number(board.next_issue_number ?? 1);
  const updates = [];
  for (const issue of pending) {
    updates.push(`UPDATE issueCache SET short_id = ${q(`${prefix}-${n}`)} WHERE id = ${q(issue.id)} AND short_id IS NULL`);
    n += 1;
  }
  updates.push(
    `UPDATE boardCache SET next_issue_number = MAX(next_issue_number, ${n}) WHERE id = ${q(board.id)}`,
  );
  d1(updates.join("; "));
  console.log(`[backfill] board ${board.id}: numbered ${pending.length} issues, counter → ${n}`);
}

console.log("[backfill] done");
