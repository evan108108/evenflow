// EFB-71 — boundary discipline check, query-string half.
//
// Sibling to check-boundary-discipline.mjs, same ratchet shape, different
// question: every route handler that reads a QUERY PARAM must read it through
// `parseRouteQuery` (src/lib/route-body.ts), which decodes the whole query
// string against an Effect Schema and 400s on any key the schema does not
// name.
//
// The bug this closes: `c.req.query("status")` answers what you asked for and
// is structurally incapable of noticing what else the caller sent. A handler
// reading seven params from a request carrying eight cannot see the eighth, so
// a caller who misremembers a field name gets 200 and a result computed as
// though they had filtered nothing. On 2026-08-01 that was not hypothetical:
//
//   GET /boards/evan-s-flow-board/issues?status_id=deadbeef&limit=3 → 200, 3 issues
//   GET /boards/evan-s-flow-board/issues?limit=3                    → 200, 3 issues
//
// Identical. `status_id` is not a field (the real one is `column_id`), and the
// endpoint said yes anyway. The caller then reasoned from a filtered-looking
// answer that was never filtered.
//
// ── WHY THIS DOES NOT REQUIRE A `noQuery` DECLARATION LIST ────────────────
//
// The body checker refuses to infer "reads no body" from "I found no body
// read", and makes a human declare it, because reads hide behind helpers the
// scanner cannot follow. That doctrine is right, and the same risk exists here.
//
// Applying it literally on day one would mean ~50 declarations written in one
// commit — because query params ride every verb, not just the body-bearing
// three. One person adding fifty entries in one sitting is not fifty routes
// getting read; it is a checkbox. And it is WORSE than honest silence, because
// it launders an inference as a human declaration and would be cited forever
// after as "these were verified". A declaration's evidentiary weight cannot
// exceed what the process that produced it could have earned.
//
// So: detected reads must migrate or be allowlisted — that is the ratchet, and
// it is exactly what the ticket asked for. Undetected silence is COUNTED and
// REPORTED on every single run, in the success line, so it is never mistaken
// for a clean bill of health. The declarations land in the per-subsystem
// migration tickets named in the allowlist's `$declarationDebt`, where someone
// is actually reading the route.

import fs from "node:fs";
import path from "node:path";
import { countOpaqueRegistrations, scanRoutes, withHelpers } from "./lib/route-scan.mjs";

const LOG = "[boundary-query]";
const DEFAULT_ROUTES_DIR = "src/routes";
const DEFAULT_ALLOWLIST_PATH = "scripts/boundary-query-allowlist.json";
const MIGRATED_MARKER = "parseRouteQuery";

/**
 * Every way this codebase can read a query param.
 *
 * `c.req.url` is deliberately NOT on this list, though it was on the first
 * draft. Several handlers build absolute redirect URLs from `c.req.url` and
 * never read a param — the OAuth start/callback pair in auth.ts among them —
 * so making it a marker would force allowlist entries for routes that have no
 * bug. An allowlist full of non-bugs is how a checker gets switched off in its
 * second month. `new URL(c.req.url)` is not a query read; `.searchParams` is,
 * and that is the precise line.
 *
 * `c.req.valid("query"` is Hono's validator-middleware form. Nothing uses it
 * today. It is listed anyway, on the body checker's own hard-won principle
 * that a marker list which is only "the patterns I happened to think of"
 * reproduces the bug class the checker exists to catch.
 */
const QUERY_MARKERS = [
  "c.req.query(",
  "c.req.queries(",
  "searchParams",
  'c.req.valid("query',
];

/**
 * Every verb, unlike the body check's post/patch/put.
 *
 * A query string rides any request. Restricting this to the body-bearing verbs
 * would exempt every GET in the app — which is where nearly all the query
 * reading actually happens, including the route that motivated the ticket.
 */
const VERBS = ["get", "post", "patch", "put", "delete"];
const MAX_SUNSET_HORIZON_DAYS = 180;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
};
const jsonOut = argv.includes("--json");

// Overrides exist so the check's own "it can fail" claim is testable, mirroring
// the BOUNDARY_TODAY precedent in the body checker. tests/boundary-query.test.ts
// points these at synthetic fixtures and asserts this script exits non-zero on
// an un-migrated handler — so the proof re-runs on every CI, instead of being a
// transcript pasted into a PR once and decaying quietly from there.
const ROUTES_DIR = flag("--routes-dir") ?? process.env["BOUNDARY_QUERY_ROUTES_DIR"] ?? DEFAULT_ROUTES_DIR;
const ALLOWLIST_PATH =
  flag("--allowlist") ?? process.env["BOUNDARY_QUERY_ALLOWLIST"] ?? DEFAULT_ALLOWLIST_PATH;

function classify(handlerSrc, fileSrc) {
  const src = withHelpers(handlerSrc, fileSrc);
  const migrated = src.includes(MIGRATED_MARKER);
  const reads = QUERY_MARKERS.some((m) => src.includes(m));
  if (migrated && !reads) return "migrated";
  if (migrated && reads) return "mixed";
  if (reads) return "unmigrated";
  return "no-query";
}

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return { byId: new Map() };
  const doc = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8"));
  if (!Array.isArray(doc.unmigrated)) {
    throw new Error(`${ALLOWLIST_PATH} must have an "unmigrated" array`);
  }
  const byId = new Map();
  for (const e of doc.unmigrated) {
    if (!e.route || !e.sunset) {
      throw new Error(
        `${ALLOWLIST_PATH}: every entry needs "route" and "sunset" (got ${JSON.stringify(e)})`,
      );
    }
    byId.set(e.route, e);
  }
  return { byId };
}

function main() {
  const handlers = scanRoutes(ROUTES_DIR, { verbs: VERBS, classify, middlewareAware: true });
  const { byId } = loadAllowlist();
  const today = new Date(process.env["BOUNDARY_TODAY"] ?? Date.now());
  const horizon = new Date(today.getTime() + MAX_SUNSET_HORIZON_DAYS * 86400_000);

  const errors = [];
  const warnings = [];

  for (const h of handlers.filter((x) => x.state === "unparsed")) {
    errors.push(
      `${h.file}:${h.line} ${h.id} — could not determine how this handler reads its query string. ` +
        `Refusing to assume it is fine; teach ${path.basename(import.meta.url)} this shape.`,
    );
  }

  for (const h of handlers.filter((x) => x.state === "mixed")) {
    errors.push(
      `${h.file}:${h.line} ${h.id} — calls BOTH parseRouteQuery and a raw query read. ` +
        `Half-migrated is worse than unmigrated: the schema implies the key set is closed, ` +
        `and the raw read reopens it without saying so.`,
    );
  }

  for (const h of handlers.filter((x) => x.state === "unmigrated")) {
    const entry = byId.get(h.id);
    if (!entry) {
      errors.push(
        `${h.file}:${h.line} ${h.id} — reads a query param without parseRouteQuery and is not on the allowlist.\n` +
          `    Migrate it (see docs/BOUNDARY_DISCIPLINE.md), or if it is pre-existing debt add it to ` +
          `${ALLOWLIST_PATH} with a sunset date. New routes may not be added.`,
      );
      continue;
    }
    const sunset = new Date(`${entry.sunset}T00:00:00Z`);
    if (Number.isNaN(sunset.getTime())) {
      errors.push(
        `${ALLOWLIST_PATH}: ${h.id} has an unparseable sunset "${entry.sunset}" (want YYYY-MM-DD)`,
      );
    } else if (sunset > horizon) {
      errors.push(
        `${ALLOWLIST_PATH}: ${h.id} sunsets ${entry.sunset}, more than ${MAX_SUNSET_HORIZON_DAYS} days out. ` +
          `A distant sunset is an amnesty, not a ratchet.`,
      );
    } else if (sunset < today) {
      errors.push(
        `${h.file}:${h.line} ${h.id} — allowlist entry expired ${entry.sunset}. Migrate it or justify a new date.`,
      );
    } else {
      warnings.push(`${h.id} (${h.file}) — unmigrated, sunset ${entry.sunset}`);
    }
  }

  const unmigratedIds = new Set(
    handlers.filter((h) => h.state === "unmigrated").map((h) => h.id),
  );
  for (const [id] of byId) {
    if (!unmigratedIds.has(id)) {
      warnings.push(
        `${id} — allowlisted but already migrated (or gone). Prune it from ${ALLOWLIST_PATH}.`,
      );
    }
  }

  const counts = {
    total: handlers.length,
    migrated: handlers.filter((h) => h.state === "migrated").length,
    unmigrated: handlers.filter((h) => h.state === "unmigrated").length,
    noQuery: handlers.filter((h) => h.state === "no-query").length,
  };

  if (jsonOut) {
    console.log(JSON.stringify({ counts, handlers, errors, warnings }, null, 2));
  }

  if (warnings.length > 0) {
    console.warn(
      `${LOG} ${warnings.length} acknowledged item(s):\n` +
        warnings.map((w) => `- ${w}`).join("\n"),
    );
  }

  if (errors.length > 0) {
    console.error(`${LOG} ${errors.length} problem(s):\n` + errors.map((e) => `- ${e}`).join("\n"));
    console.error(
      `${LOG} ${counts.migrated}/${counts.migrated + counts.unmigrated} query-reading routes migrated.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `${LOG} OK — ${counts.migrated} migrated, ${counts.unmigrated} allowlisted, ` +
      `${counts.total} handlers scanned.`,
  );
  // Printed on every successful run, deliberately. This number is the check's
  // blind spot stated out loud: no query read was DETECTED in these handlers,
  // and detection resolves same-file helpers one level deep, so that is not the
  // same as there being none. Silence stays visible rather than being resolved
  // into a clean bill of health nobody earned.
  console.log(
    `${LOG} ${counts.noQuery} handler(s) had no detected query read — that is not proof they read none. ` +
      `See "$declarationDebt" in ${ALLOWLIST_PATH}.`,
  );
  // The other blind spot, also stated rather than left implicit: a route
  // registered with a bare-identifier path (`issues.post(path, …)`) is not
  // matched by the registration regex at all, so it is absent from `total`
  // instead of being counted as unchecked.
  const opaque = countOpaqueRegistrations(ROUTES_DIR, VERBS);
  if (opaque > 0) {
    console.log(
      `${LOG} ${opaque} registration(s) use a non-literal path and are invisible to this scan entirely — ` +
        `not included in the ${counts.total} above.`,
    );
  }
}

main();
