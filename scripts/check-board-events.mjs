// EFB-104 — every board-mutating route must emit a BoardEvent.
//
// THE BUG THIS CLOSES
//
// 2026-08-04: EFB-102 was transitioned Done through `POST /issue/:id/transition`.
// The API and the database agreed it was Done. Evan's board still showed it in
// In Progress four minutes later. A route that changes what a board renders and
// tells nobody leaves every open tab on the snapshot it had at page load, and
// the only thing that notices is a human seeing a card in the wrong column.
//
// The 60s poll added in the same ticket heals that drift whatever caused it.
// This check attacks one specific cause: an emit that was never written.
//
// ── WHY ONLY THE BOARD DOMAIN ───────────────────────────────────────────────
//
// 67 routes in the manifest mutate. Only the 30 whose scope domain is `board`
// can change what a board renders; the rest create orgs, rotate API keys, edit
// profiles, write storage config. Requiring an emit from all 67 would mean ~37
// exemptions for routes that were never bugs, and an allowlist full of non-bugs
// is how a checker gets switched off in its second month — the failure mode
// check-boundary-query.mjs's own header warns about at length.
//
// The domain comes from `derivedRequirement` in src/scopes.ts, the same
// function check:scopes uses. A new route file lands in this check's scope by
// being classified once, in one place, rather than by somebody remembering to
// add it to a list here.
//
// ── WHY THE TYPESCRIPT AST AND NOT THE SHARED TEXT SCANNER ──────────────────
//
// The first version of this check reused scripts/lib/route-scan.mjs, which the
// two boundary checks share. It reported `board.archive.set` and
// `board.archive.clear` as emitting nothing. Both emit `board.updated`, ten
// lines below their UPDATE.
//
// The reason is worth recording, because it will bite the next person who
// reaches for a text scan here. Actions in this codebase are curried:
//
//     export const setBoardArchived =
//       (archive: boolean) =>
//       (input: ActionInput): Effect.Effect<…> =>
//       Effect.gen(function* () { … emitSecureBoardEvent(…) … });
//
// resolveIdentifierBody extends a declaration through ONE arrow body. The
// second arrow is where the emit lives, so the span stopped short and the
// function read as silent. Widening the span to the next top-level `export`
// would have traded a false SILENT for something worse — a neighbouring
// function's emit counting as this one's, which is a false CLEAN on exactly
// the question this check exists to answer.
//
// A VariableDeclaration node covers the whole curried chain by construction,
// so the AST has no span to get wrong. `typescript` is already a dependency.
//
// ── WHAT IT CAN AND CANNOT SEE ──────────────────────────────────────────────
//
// Reachability is a call-graph walk over identifiers, not a type-aware
// resolution: two different functions sharing a name are both followed. That
// biases toward reporting a route as EMITTING, so the honest reading of a
// green run is "no route was proven silent", and every SILENT report is a
// route a human then reads. Anything genuinely emit-free is declared in
// NO_EMIT with a reason.
//
// Run with --json for machine output, or plain for the table.

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ROUTES } from "../src/routes-manifest.ts";
import { derivedRequirement } from "../src/scopes.ts";

const LOG = "[board-events]";
const jsonOut = process.argv.includes("--json");

/**
 * Injection points, so the check can be run against synthetic fixtures and
 * PROVEN to fail — the discipline tests/boundary-query.test.ts states: a check
 * that has only ever been observed passing is indistinguishable from one that
 * cannot fail. Defaults are the real tree, which is the run CI performs.
 */
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

const ROUTES_DIR = flag("--routes-dir") ?? "src/routes";
const SRC_DIR = flag("--src-dir") ?? "src";
/** A JSON array of manifest-shaped entries, for fixtures. */
const MANIFEST_JSON = flag("--manifest-json");
/** The one call that publishes to a board's SSE stream. */
const EMIT_MARKER = "emitSecureBoardEvent";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const VERBS = new Set(["post", "put", "patch", "delete"]);

/**
 * Routes that mutate board-domain state and legitimately emit nothing.
 *
 * Each entry states WHY, because "this one doesn't emit" is the finding the
 * check exists to produce — an exemption with no reason is indistinguishable
 * from the bug. Adding a route here claims no open board renders differently
 * because of it, and that claim is what a reviewer checks.
 */
const NO_EMIT = {
  "search.board": "Not a mutation. POST because the query travels as a body — the manifest entry says so at its declaration. Reads nothing into board state.",
  "webhook.create": "Webhook subscriptions are delivery plumbing, not board content. They render only in board settings, which loads fresh on open.",
  "webhook.update": "Same surface as webhook.create.",
  "webhook.delete": "Same surface as webhook.create.",
  "audience.regrantRequest.create": "Key-management side channel: records a request for a re-grant. Publishes no board-visible state, and the requester cannot yet read the board it concerns.",
};

// ── source index ────────────────────────────────────────────────────────────

/**
 * Every .ts under src/, parsed once.
 *
 * Route files are indexed too, and that is load-bearing rather than
 * incidental. `board.archive.set` registers as
 * `boards.post(path("board.archive.set"), archiveHandler(true))`, where
 * archiveHandler is a const in the route file itself. Excluding src/routes
 * from the index made both archive routes unresolvable, and the check reported
 * them silent when they emit `board.updated`. A route-local helper is part of
 * the call graph exactly like an action is.
 */
const sourceFiles = () => {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
      out.push(abs);
    }
  };
  walk(SRC_DIR);
  return out.map((abs) => ({
    abs,
    sf: ts.createSourceFile(abs, fs.readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true),
  }));
};

/** name → every declaration of that name, across the source tree. */
const declarationIndex = () => {
  const index = new Map();
  const add = (name, node) => {
    const list = index.get(name);
    if (list === undefined) index.set(name, [node]);
    else list.push(node);
  };
  for (const { sf } of sourceFiles()) {
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) add(node.name.text, node);
      else if (ts.isFunctionDeclaration(node) && node.name !== undefined) add(node.name.text, node);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return index;
};

const INDEX = declarationIndex();

/**
 * Does anything reachable from `start` call the emit?
 *
 * Breadth-first over called identifiers. `seen` visits each NAME once, which
 * both terminates cycles and bounds the walk without an arbitrary depth cap.
 */
const reachesEmit = (start) => {
  const queue = [start];
  const seen = new Set();
  while (queue.length > 0) {
    const node = queue.shift();
    const callees = [];
    let found = false;
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (ts.isIdentifier(callee)) {
          if (callee.text === EMIT_MARKER) found = true;
          else callees.push(callee.text);
        } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === EMIT_MARKER) {
          found = true;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    if (found) return true;
    for (const name of callees) {
      if (seen.has(name)) continue;
      seen.add(name);
      for (const decl of INDEX.get(name) ?? []) queue.push(decl);
    }
  }
  return false;
};

// ── route side: manifest id → handler node ──────────────────────────────────

/**
 * Every `router.<verb>(path("route.id"), …)` registration, by manifest id.
 *
 * Keying on the id rather than on the URL is what makes this check immune to
 * the drift EFB-98 closed: the manifest is the single source of truth for
 * paths, and matching on a rendered path string would reintroduce a second
 * place where a route's identity is written down.
 */
const handlersById = () => {
  const found = new Map();
  for (const name of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
    const abs = path.join(ROUTES_DIR, name);
    const sf = ts.createSourceFile(abs, fs.readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        VERBS.has(node.expression.name.text) &&
        node.arguments.length >= 2
      ) {
        const first = node.arguments[0];
        if (
          ts.isCallExpression(first) &&
          ts.isIdentifier(first.expression) &&
          first.expression.text === "path" &&
          first.arguments.length >= 1 &&
          ts.isStringLiteralLike(first.arguments[0])
        ) {
          const id = first.arguments[0].text;
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          // Every argument after the path: middleware can sit between the path
          // and the handler, and middleware can emit just as a handler can.
          found.set(id, { file: `${ROUTES_DIR}/${name}`, line, nodes: node.arguments.slice(1) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
};

const HANDLERS = handlersById();

// ── which routes are in scope ───────────────────────────────────────────────

const MANIFEST =
  MANIFEST_JSON === null ? ROUTES : JSON.parse(fs.readFileSync(MANIFEST_JSON, "utf8"));

const inScope = [];
for (const entry of MANIFEST) {
  if (!MUTATING.has(entry.method)) continue;
  let requirement;
  try {
    requirement = derivedRequirement(entry);
  } catch {
    // A route file with no domain already fails check:scopes loudly. Reporting
    // it twice would be the second-opinion drift BOUNDARY_DISCIPLINE warns of.
    continue;
  }
  if (requirement.kind !== "scope" || requirement.domain !== "board") continue;
  inScope.push(entry);
}

// ── verdicts ────────────────────────────────────────────────────────────────

const rows = [];
const failures = [];
for (const entry of inScope) {
  const declared = Object.hasOwn(NO_EMIT, entry.id);
  const handler = HANDLERS.get(entry.id);
  const state =
    handler === undefined
      ? "unmatched"
      : handler.nodes.some((n) => reachesEmit(n))
        ? "emits"
        : "silent";
  rows.push({
    id: entry.id,
    method: entry.method,
    path: entry.path,
    file: handler?.file ?? entry.file,
    line: handler?.line ?? null,
    state,
    declared,
  });

  if (state === "emits") {
    if (declared) {
      failures.push(
        `${entry.id} — declared in NO_EMIT but DOES emit. Delete the declaration: ` +
          `a stale exemption silently un-checks this route the day someone removes its emit.`,
      );
    }
    continue;
  }
  if (declared) continue;
  if (state === "unmatched") {
    failures.push(
      `${entry.id} — in the manifest, but no \`router.<verb>(path("${entry.id}"), …)\` ` +
        `registration was found under ${ROUTES_DIR}. Either it is registered in a shape ` +
        `this check cannot read, or it is not registered at all.`,
    );
    continue;
  }
  failures.push(
    `${entry.id} (${handler.file}:${handler.line}) — mutates board-domain state and never ` +
      `reaches ${EMIT_MARKER}.\n` +
      `      Every open board keeps rendering the old value until the 60s poll heals it.\n` +
      `      Emit the matching BoardEvent, or declare it in NO_EMIT (scripts/check-board-events.mjs) with a reason.`,
  );
}

const mutatingTotal = MANIFEST.filter((r) => MUTATING.has(r.method)).length;
const counts = {
  inScope: inScope.length,
  emitting: rows.filter((r) => r.state === "emits").length,
  declared: rows.filter((r) => r.declared && r.state !== "emits").length,
  failing: failures.length,
  mutatingTotal,
  outOfScope: mutatingTotal - inScope.length,
};

if (jsonOut) {
  console.log(JSON.stringify({ counts, rows, failures }, null, 2));
} else {
  const width = Math.max(...rows.map((r) => r.id.length), 8);
  for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const mark = r.state === "emits" ? "emits" : r.declared ? "declared" : "SILENT";
    console.log(`${LOG} ${r.id.padEnd(width)}  ${r.method.padEnd(6)} ${mark.padEnd(9)} ${r.file}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${LOG} ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

// Printed on success too. `emitting + declared === inScope` is the invariant a
// reader checks at a glance, and naming how many mutating routes were EXCLUDED
// keeps the narrowed scope visible instead of implied — a count nobody can see
// is a scope nobody can question.
// Suppressed under --json, where the report above is the whole of stdout and
// a trailing prose line would make it unparseable.
if (!jsonOut) {
  console.log(
    `${LOG} ${counts.emitting}/${counts.inScope} board-domain mutating routes emit a BoardEvent ` +
      `(${counts.declared} declared emit-free). ` +
      `${counts.outOfScope} of ${mutatingTotal} mutating routes are outside the board domain and not checked.`,
  );
}
