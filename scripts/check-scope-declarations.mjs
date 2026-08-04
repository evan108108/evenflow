// EFB-100 — every route's scope requirement, derived and printed.
//
// WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT
//
// It does NOT check that enforcement happened. Enforcement is a property of
// routing: the auth middleware resolves the matched route to its manifest
// entry and fails CLOSED when there is none, so a route that is not declared
// is unreachable by a scoped key whether or not this script ever runs. A
// checker that re-verified that would be a second opinion about the same
// question, which is the drift shape docs/BOUNDARY_DISCIPLINE.md and EFB-87
// both exist to warn about.
//
// What it checks is that the DERIVATION IS TOTAL — that every route in the
// manifest resolves to a requirement without throwing — and then it PRINTS the
// whole table. The printing is the point. The requirement for 107 routes is
// computed by one function from (route file, auth level, method); reviewing
// that function means reading ~20 lines, and reviewing its OUTPUT means
// reading 107 rows that a human can scan for "wait, why is that admin?".
// Neither is a diff of 107 hand-typed annotations, which is what this design
// exists to avoid: 107 chances to typo a security field that nobody notices
// until the wrong key gets in.
//
// Run with --json for machine output, or plain for the table.

import { ROUTES, effectivePaths } from "../src/routes-manifest.ts";
import { derivedRequirement, GRANTABLE_DOMAINS, SCOPE_DOMAINS } from "../src/scopes.ts";

const LOG = "[scopes]";
const jsonOut = process.argv.includes("--json");

const rows = [];
const failures = [];

for (const entry of ROUTES) {
  let requirement;
  try {
    requirement = derivedRequirement(entry);
  } catch (err) {
    // A file with no domain. The derivation throws at module load in the
    // server too, so this cannot ship — but the message is much more useful
    // here, next to the route that caused it.
    failures.push({ id: entry.id, file: entry.file, error: String(err.message ?? err) });
    continue;
  }
  rows.push({
    id: entry.id,
    method: entry.method,
    paths: effectivePaths(entry),
    file: entry.file,
    auth: entry.auth,
    requirement:
      requirement.kind === "scope"
        ? `${requirement.domain}:${requirement.access}`
        : requirement.kind === "never"
          ? "— never (JWT only)"
          : "— public",
  });
}

if (jsonOut) {
  console.log(JSON.stringify({ rows, failures }, null, 2));
} else {
  const w = (s, n) => String(s).padEnd(n);
  console.log(`${LOG} scope requirement for every declared route, derived from (file, auth, method).\n`);
  console.log(`${w("REQUIREMENT", 18)}${w("METHOD", 7)}${w("AUTH", 13)}${w("ROUTE ID", 34)}PATH`);
  console.log("-".repeat(120));
  // Grouped by requirement so an outlier stands out: one `org:admin` sitting
  // among the board reads is exactly what a reviewer needs to catch, and it is
  // invisible in file order.
  for (const row of [...rows].sort((a, b) =>
    a.requirement === b.requirement ? a.id.localeCompare(b.id) : a.requirement.localeCompare(b.requirement),
  )) {
    console.log(`${w(row.requirement, 18)}${w(row.method, 7)}${w(row.auth, 13)}${w(row.id, 34)}${row.paths[0]}`);
  }

  const byRequirement = new Map();
  for (const row of rows) byRequirement.set(row.requirement, (byRequirement.get(row.requirement) ?? 0) + 1);
  console.log(`\n${LOG} totals`);
  for (const [req, n] of [...byRequirement].sort()) console.log(`  ${w(req, 18)} ${n}`);

  console.log(`\n${LOG} vocabulary`);
  console.log(`  domains     ${SCOPE_DOMAINS.join(", ")}`);
  console.log(`  grantable   ${GRANTABLE_DOMAINS.join(", ")}`);
  // Naming the gap explicitly rather than letting a reader diff the two lists.
  const ungrantable = SCOPE_DOMAINS.filter((d) => !GRANTABLE_DOMAINS.includes(d));
  console.log(
    `  NOT grantable to a key: ${ungrantable.join(", ")} — the key surface is JWT-only so a leaked key cannot mint or revoke keys`,
  );
}

if (failures.length > 0) {
  console.error(`\n${LOG} FAILED — ${failures.length} route(s) have no derivable scope requirement:`);
  for (const f of failures) console.error(`  ${f.id} (${f.file}): ${f.error}`);
  process.exit(1);
}

if (!jsonOut) {
  console.log(`\n${LOG} OK — ${rows.length} routes, every one resolved to a requirement.`);
}
