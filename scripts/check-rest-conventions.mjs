#!/usr/bin/env node
/**
 * EFB-98: mechanical enforcement of docs/REST_CONVENTIONS.md.
 *
 * Runs against src/routes-manifest.ts — the declaration — rather than against
 * route-file text. That is the whole point: `check:boundary` scans source as
 * text and so could never see a route registered through a computed path,
 * which is how three `promote_to_*` routes stayed invisible to it. A rule that
 * reads the manifest sees every route by construction, because a route that is
 * not in the manifest is not served.
 *
 * Exit 0 = clean. Exit 1 = at least one violation, printed with the entry id.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LOG = "[check:rest-conventions]";

/**
 * Collections are plural; a segment that addresses ONE thing is singular. The
 * failure mode this catches is `/boards/:slug`, which reads as "the slug of
 * the boards" and was the single most common violation (77 of 105 routes).
 */
const PLURAL_SEGMENTS = new Set([
  "boards",
  "issues",
  "sprints",
  "comments",
  "keys",
  "attachments",
  "invites",
  "webhooks",
  "orgs",
  "members",
  "audiences",
  "columns",
  "labels",
  "profiles",
  "notifications",
  "imports",
]);

/**
 * Words that mean "create/read/update/delete" and therefore must be expressed
 * by the HTTP method instead of by a path segment.
 */
const CRUD_VERBS = [
  "add",
  "remove",
  "create",
  "delete",
  "update",
  "edit",
  "set",
  "get",
  "list",
  "fetch",
  "move-to",
  "move",
  "rename",
  "duplicate",
];

/** Trailing segments that mean removal — these must be DELETE, never POST. */
const REMOVAL_WORDS = ["unarchive", "remove", "delete", "detach", "revoke", "clear", "disconnect"];

const isParam = (segment) => segment.startsWith(":");
const segmentsOf = (p) => p.split("/").filter((s) => s.length > 0);

const violations = [];
const fail = (entry, rule, message) =>
  violations.push({ id: entry.id, rule, message, path: `${entry.method} ${entry.path}` });

const check = (entries) => {
  const seen = new Map();

  for (const entry of entries) {
    const segments = segmentsOf(entry.path);

    // Rule 1 — plural immediately followed by a parameter.
    for (let i = 0; i < segments.length - 1; i++) {
      if (PLURAL_SEGMENTS.has(segments[i]) && isParam(segments[i + 1])) {
        fail(
          entry,
          "plural-followed-by-id",
          `"${segments[i]}/${segments[i + 1]}" addresses one thing through a plural. ` +
            `Use the singular: "${segments[i].replace(/e?s$/, "")}/${segments[i + 1]}".`,
        );
      }
    }

    // Rule 2 — a CRUD verb in the path. `stateAction: true` is the opt-in
    // escape hatch for genuine transitions (start, complete, transition).
    if (entry.stateAction !== true) {
      for (const segment of segments) {
        if (isParam(segment)) continue;
        // A segment ending in "-of" names a RELATION, not an action:
        // "duplicate-of" is the noun "the thing this duplicates", addressable
        // with PUT and DELETE. Without this carve-out the verb rule reads the
        // "duplicate" prefix and rejects a correctly-shaped sub-resource.
        if (segment.endsWith("-of")) continue;
        const verb = CRUD_VERBS.find((v) => segment === v || segment.startsWith(`${v}-`));
        if (verb !== undefined) {
          fail(
            entry,
            "verb-in-url",
            `Segment "${segment}" names a CRUD operation. Express it with the HTTP method, ` +
              `or declare stateAction: true if it is a real state transition.`,
          );
        }
      }
    }

    // Rule 3 — a GET that declares a body. A read does not take one, and a
    // GET that needs a body is really a POST.
    if (entry.method === "GET" && entry.body !== undefined && entry.body !== null) {
      fail(entry, "get-with-body", "GET routes must not declare a request body.");
    }

    // Rule 4 — a POST whose trailing segment means removal. This is the rule
    // that catches `POST /boards/:slug/unarchive` directly.
    const last = segments[segments.length - 1];
    if (entry.method === "POST" && last !== undefined && !isParam(last)) {
      if (REMOVAL_WORDS.some((w) => last === w || last.startsWith(`${w}-`))) {
        fail(
          entry,
          "post-that-should-be-delete",
          `POST ending in "${last}" removes something. Use DELETE on the resource instead.`,
        );
      }
    }

    // Rule 5 — snake_case in a literal segment. Parameters keep snake_case
    // (`:org_slug`, `:board_id`) because they mirror field names; paths are
    // kebab-case.
    for (const segment of segments) {
      if (isParam(segment)) continue;
      if (segment.includes("_")) {
        fail(
          entry,
          "snake-case-segment",
          `Segment "${segment}" uses snake_case. Paths are kebab-case: "${segment.replace(/_/g, "-")}".`,
        );
      }
    }

    // Rule 6 — the org parameter has exactly one spelling. Before EFB-98 the
    // same concept was `:slug`, `:handle` and `:org_slug` in different files.
    for (const segment of segments) {
      if (!isParam(segment)) continue;
      const name = segment.slice(1);
      if ((name === "slug" || name === "handle") && segments[segments.indexOf(segment) - 1] === "org") {
        fail(entry, "org-param-spelling", `The org parameter must be ":org_slug", not "${segment}".`);
      }
      if (name === "handle") {
        fail(entry, "org-param-spelling", `":handle" is a third spelling of the org id. Use ":org_slug".`);
      }
    }

    // Rule 7 — no two entries may serve the same (method, effective path).
    // This is what catches an entry colliding with another entry's ORG TWIN,
    // which is invisible if you only compare declared paths.
    for (const effective of effectivePathsOf(entry)) {
      const key = `${entry.method} ${effective}`;
      const prior = seen.get(key);
      if (prior !== undefined) {
        fail(entry, "duplicate-route", `Collides with "${prior}" — both serve ${key}.`);
      } else {
        seen.set(key, entry.id);
      }
    }
  }
};

// Mirrors effectivePaths() in the manifest. Kept as a local copy so the checker
// can run over a plain parsed manifest without importing TypeScript.
const effectivePathsOf = (entry) => {
  const prefix = entry.mount === "auth" ? "/auth" : entry.mount === "root" ? "" : "/api/v0";
  const base = `${prefix}${entry.path}`;
  return entry.orgScoped ? [base, `${prefix}/org/:org_slug${entry.path}`] : [base];
};

/**
 * Read the manifest without a TypeScript toolchain: strip the type layer and
 * evaluate the ROUTES array. Parsing beats importing here because this script
 * runs in CI before any build step.
 */
const loadRoutes = () => {
  const file = path.join(ROOT, "src", "routes-manifest.ts");
  const src = fs.readFileSync(file, "utf8");
  const start = src.indexOf("export const ROUTES = [");
  if (start === -1) throw new Error(`${LOG} could not find ROUTES in ${file}`);
  const open = src.indexOf("[", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`${LOG} unterminated ROUTES array`);
  const literal = src.slice(open, end + 1);
  return new Function(`return ${literal};`)();
};

const routes = loadRoutes();
check(routes);

const orgScoped = routes.filter((r) => r.orgScoped).length;
const effective = routes.reduce((n, r) => n + effectivePathsOf(r).length, 0);

if (violations.length > 0) {
  console.error(`${LOG} ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.id}  (${v.path})`);
    console.error(`    [${v.rule}] ${v.message}\n`);
  }
  console.error(`${LOG} see docs/REST_CONVENTIONS.md`);
  process.exit(1);
}

console.log(
  `${LOG} clean. ${routes.length} declared routes, ${orgScoped} org-scoped, ` +
    `${effective} effective paths.`,
);
