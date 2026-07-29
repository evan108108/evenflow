#!/usr/bin/env node
// One-shot backfill for migration 0005 (structured columns): every
// boardCache row whose `columns` is still a legacy string[] gets a
// Column[] — UUID ids, order from original position, enabled true,
// category inferred by the same case-insensitive substring rules as
// src/columns.ts inferCategory — and every issueCache row resolves its
// status name against its board's new Column[] to populate column_id.
//
// Safe to re-run: boards already carrying object-shaped columns are
// skipped, and the issue update only touches column_id IS NULL rows.
// An issue whose status matches no column (drift) falls back to the
// board's first enabled column and has its status mirror re-pointed —
// logged loudly, because it means the cache had drifted already.
//
// Usage (needs the CF creds in the environment):
//   set -a; source /Users/evan/projects/4a/.env; set +a
//   node scripts/backfill-columns-v5.mjs [--local]

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const REMOTE_FLAG = process.argv.includes("--local") ? "--local" : "--remote";

// Mirrors CATEGORY_RULES in src/columns.ts — mjs can't import the TS module.
const CATEGORY_RULES = [
  ["todo", ["todo", "backlog"]],
  ["in_progress", ["progress", "doing", "wip"]],
  ["in_review", ["review", "pr", "qa"]],
  ["done", ["done", "shipped", "completed", "closed", "finished"]],
  ["blocked", ["blocked", "stuck", "waiting"]],
];

const inferCategory = (name) => {
  const lower = String(name).toLowerCase();
  for (const [category, needles] of CATEGORY_RULES) {
    if (needles.some((n) => lower.includes(n))) return category;
  }
  return "todo";
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

const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

// ── boards: string[] → Column[] ───────────────────────────────────────────

const boards = d1("SELECT id, slug, columns FROM boardCache");
let boardsConverted = 0;
const columnsByBoard = new Map();

for (const board of boards) {
  let parsed;
  try {
    parsed = JSON.parse(board.columns);
  } catch {
    throw new Error(`board ${board.slug} (${board.id}): columns is not JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`board ${board.slug} (${board.id}): columns is not an array`);
  }
  if (parsed.every((c) => typeof c === "object" && c !== null)) {
    columnsByBoard.set(board.id, parsed); // already Column[] — re-run, skip
    continue;
  }
  const columns = parsed.map((name, order) => ({
    id: randomUUID(),
    name: String(name),
    order,
    enabled: true,
    category: inferCategory(name),
  }));
  d1(
    `UPDATE boardCache SET columns = ${sqlString(JSON.stringify(columns))} WHERE id = ${sqlString(board.id)}`,
  );
  columnsByBoard.set(board.id, columns);
  boardsConverted += 1;
  console.log(
    `board ${board.slug}: ${columns.map((c) => `${c.name}→${c.category}`).join(", ")}`,
  );
}

// ── issues: status name → column_id ───────────────────────────────────────

const issues = d1("SELECT id, board_id, status FROM issueCache WHERE column_id IS NULL");
let issuesResolved = 0;
let issuesFallback = 0;

for (const issue of issues) {
  const columns = columnsByBoard.get(issue.board_id);
  if (columns === undefined) {
    // Orphaned issue (board deleted) — nothing to resolve against; point it
    // at nothing rather than invent a column. Logged for the verify step.
    console.warn(`issue ${issue.id}: board ${issue.board_id} missing, column_id left NULL`);
    continue;
  }
  const match =
    columns.find((c) => c.enabled && c.name === issue.status) ??
    columns.find((c) => c.name === issue.status) ??
    columns.find((c) => c.name.toLowerCase() === String(issue.status).toLowerCase());
  if (match !== undefined) {
    d1(
      `UPDATE issueCache SET column_id = ${sqlString(match.id)} WHERE id = ${sqlString(issue.id)} AND column_id IS NULL`,
    );
    issuesResolved += 1;
  } else {
    const fallback = columns.filter((c) => c.enabled).sort((a, b) => a.order - b.order)[0];
    d1(
      `UPDATE issueCache SET column_id = ${sqlString(fallback.id)}, status = ${sqlString(fallback.name)} WHERE id = ${sqlString(issue.id)} AND column_id IS NULL`,
    );
    issuesFallback += 1;
    console.warn(
      `issue ${issue.id}: status ${JSON.stringify(issue.status)} matched no column, re-pointed at ${fallback.name}`,
    );
  }
}

const remaining = d1(
  "SELECT COUNT(*) AS n FROM issueCache WHERE column_id IS NULL",
)[0];

console.log(
  `done: ${boardsConverted} board(s) converted, ${issuesResolved} issue(s) resolved, ` +
    `${issuesFallback} fallback(s), ${remaining?.n ?? "?"} issue(s) still NULL`,
);
