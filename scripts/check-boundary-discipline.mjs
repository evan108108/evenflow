// EFB-54 — boundary discipline check.
//
// Every route handler that reads a request body must read it through
// `parseRouteBody` (src/lib/route-body.ts), which validates against an Effect
// Schema: unknown keys rejected, wrong types rejected, required-missing
// rejected, canonical form out. A handler that calls `readJsonBody` instead
// gets an untyped `Record<string, unknown>` and hand-checks whatever it
// remembers to — the shape that produced the eight silent-success bugs listed
// in docs/BOUNDARY_DISCIPLINE.md.
//
// Modelled on adaptengine-worker's contracts/check-breaking-changes.mjs: plain
// .mjs so it runs with no build step, one greppable log prefix, and a two-tier
// outcome where acknowledged debt warns and unacknowledged debt fails.
//
// The allowlist is a RATCHET, not an amnesty. Entries carry sunset dates; an
// entry past its sunset fails the build, and an entry for a route that has
// since been migrated is reported as prunable. Sunsets more than
// MAX_SUNSET_HORIZON_DAYS out are rejected outright, because "sunset: 2099"
// is an amnesty wearing a ratchet's clothes.
//
// EFB-87: every entry is RE-AUDITED against detection on every run, and a
// mismatch fails rather than warns.
//
// The hole that closed. Detection and the allowlist were checked in only one
// direction — detection found debt, the allowlist excused it. Nothing checked
// that an entry still described anything real. So for an UNallowlisted route,
// losing the marker (rename `readJsonBody` → `readRequestBody` and forget this
// list) errored loudly; for an allowlisted one it passed in silence. The
// allowlist quietly downgraded those routes from detected debt to declared
// debt, and the check went on printing OK for a scan that had stopped looking.
// Detection drifting from safety to placebo is the same silent-success disease
// the whole ticket family is about, wearing the tool's own clothes.
//
// So an entry must now be backed by DETECTED debt. When it is not, the two
// live explanations are opposite and both matter: the route got migrated (prune
// the entry) or the marker got renamed (fix UNMIGRATED_MARKERS, then re-audit
// every entry it was silently covering). The check cannot tell which, so it
// names the entry and says both.
//
// The escape hatch is `scanner_blind_reason`, and it is deliberately narrow: an
// entry may carry a written reason why DETECTION cannot see debt that is really
// there — a body read behind a helper the resolver won't follow, or a route
// registered with a non-literal path the regex can't match. That downgrades the
// failure to an acknowledged warning. It is a declaration, so it costs a
// sentence a human has to write and a reviewer can dispute, which is the only
// thing separating it from the silence it replaces.
//
// This script deliberately FAILS on route shapes it cannot parse rather than
// skipping them. A checker that silently ignores what it does not understand
// is the very bug class it exists to catch.

import fs from "node:fs";
import path from "node:path";
// EFB-71 extracted the handler-locating machinery here so the query-param
// check could reuse it. Policy — what counts as migrated, what the allowlist
// means, what fails — stayed in this file.
import { scanRoutes, withHelpers } from "./lib/route-scan.mjs";

const LOG = "[boundary]";

const DEFAULT_ROUTES_DIR = "src/routes";

const DEFAULT_ALLOWLIST_PATH = "scripts/boundary-allowlist.json";

const MIGRATED_MARKER = "parseRouteBody";

/**
 * Every way this codebase currently gets at a request body.
 *
 * The first draft listed only `readJsonBody` and `c.req.json(`, and it
 * misreported POST /signin/nostr (`c.req.arrayBuffer()` + JSON.parse) and the
 * GitHub webhook (`c.req.text()`) as reading no body at all — silently
 * exempting two of the most security-sensitive routes in the app. A checker
 * whose allowlist is "the patterns I happened to think of" reproduces the bug
 * class it exists to catch. Add to this list before adding to the allowlist.
 */
const UNMIGRATED_MARKERS = [
  "readJsonBody",
  "c.req.json(",
  "c.req.text(",
  "c.req.arrayBuffer(",
  "c.req.parseBody(",
  "c.req.formData(",
  "c.req.blob(",
];

/** Body-bearing verbs. GET/DELETE carry no body in this API. */
const VERBS = ["post", "patch", "put"];

const MAX_SUNSET_HORIZON_DAYS = 180;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const jsonOut = argv.includes("--json");

// EFB-87: the same overrides the query check has carried since EFB-71, and for
// the same reason — the check's "it can fail" claim has to be testable against
// synthetic fixtures. Without them the only way to prove the re-audit fires is
// to break the real allowlist, which is a transcript pasted into a PR once
// rather than a proof that re-runs on every CI.
const ROUTES_DIR = flag("--routes-dir") ?? process.env["BOUNDARY_ROUTES_DIR"] ?? DEFAULT_ROUTES_DIR;
const ALLOWLIST_PATH =
  flag("--allowlist") ?? process.env["BOUNDARY_ALLOWLIST"] ?? DEFAULT_ALLOWLIST_PATH;

function classify(handlerSrc, fileSrc) {
  const src = withHelpers(handlerSrc, fileSrc);
  const migrated = src.includes(MIGRATED_MARKER);
  const unmigrated = UNMIGRATED_MARKERS.some((m) => src.includes(m));
  if (migrated && !unmigrated) return "migrated";
  if (migrated && unmigrated) return "mixed";
  if (unmigrated) return "unmigrated";
  return "no-body";
}

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) {
    return { entries: [], byId: new Map(), noBody: new Map() };
  }
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
    // An empty blind reason is worse than none: it silences the re-audit while
    // recording nothing a reviewer could argue with.
    if ("scanner_blind_reason" in e && String(e.scanner_blind_reason ?? "").trim() === "") {
      throw new Error(
        `${ALLOWLIST_PATH}: ${e.route} has an empty "scanner_blind_reason". ` +
          `Write why detection cannot see this route's debt, or drop the field.`,
      );
    }
    byId.set(e.route, e);
  }
  const noBody = new Map();
  for (const e of doc.noBody ?? []) {
    if (!e.route || !e.reason) {
      throw new Error(
        `${ALLOWLIST_PATH}: every noBody entry needs "route" and "reason" (got ${JSON.stringify(e)})`,
      );
    }
    noBody.set(e.route, e);
  }
  return { entries: doc.unmigrated, byId, noBody };
}

function main() {
  const handlers = scanRoutes(ROUTES_DIR, { verbs: VERBS, classify });

  const { byId, noBody } = loadAllowlist();
  const today = new Date(process.env["BOUNDARY_TODAY"] ?? Date.now());
  const horizon = new Date(today.getTime() + MAX_SUNSET_HORIZON_DAYS * 86400_000);

  const errors = [];
  const warnings = [];

  // A human declaration outranks detection, in BOTH directions.
  //
  // Detection is a heuristic over a language it does not parse; the allowlist
  // is somebody who read the code. So a route listed as unmigrated debt stays
  // unmigrated debt even when the scanner finds no body read — that is exactly
  // POST .../attachments, whose multipart read hides inside `readUpload`'s
  // Effect.gen. Only positive evidence of migration (the parseRouteBody marker)
  // overrides the declaration, because that evidence is the thing we can
  // actually see.
  //
  // EFB-87: what detection actually SAW is kept as `detected` before the flip
  // overwrites it. The flip is the declaration winning, and the re-audit below
  // is the check asking what it won against — a question that cannot be asked
  // once the two values are the same field.
  for (const h of handlers) h.detected = h.state;
  for (const h of handlers) {
    if (h.state === "no-body" && byId.has(h.id)) h.state = "unmigrated";
  }

  const unparsed = handlers.filter((h) => h.state === "unparsed");
  for (const h of unparsed) {
    errors.push(
      `${h.file}:${h.line} ${h.id} — could not determine how this handler reads its body. ` +
        `Refusing to assume it is fine; teach ${path.basename(import.meta.url)} this shape.`,
    );
  }

  for (const h of handlers.filter((x) => x.state === "mixed")) {
    errors.push(
      `${h.file}:${h.line} ${h.id} — calls BOTH parseRouteBody and a raw body reader. ` +
        `Half-migrated is worse than unmigrated: the schema implies a guarantee the raw read bypasses.`,
    );
  }

  for (const h of handlers.filter((x) => x.state === "unmigrated")) {
    const entry = byId.get(h.id);
    if (!entry) {
      errors.push(
        `${h.file}:${h.line} ${h.id} — reads its body without parseRouteBody and is not on the allowlist.\n` +
          `    Migrate it (see docs/BOUNDARY_DISCIPLINE.md), or if it is pre-existing debt add it to ` +
          `${ALLOWLIST_PATH} with a sunset date. New routes may not be added.`,
      );
      continue;
    }
    const sunset = new Date(`${entry.sunset}T00:00:00Z`);
    if (Number.isNaN(sunset.getTime())) {
      errors.push(`${ALLOWLIST_PATH}: ${h.id} has an unparseable sunset "${entry.sunset}" (want YYYY-MM-DD)`);
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
      // One line per route. A blind declaration is reported ON the debt line
      // rather than beside it: two warnings for one route reads as two items of
      // debt, and the count at the bottom is the number people actually track.
      const declared = entry.scanner_blind_reason
        ? ` — no marker detected, declared: ${entry.scanner_blind_reason}`
        : "";
      warnings.push(`${h.id} (${h.file}) — unmigrated, sunset ${entry.sunset}${declared}`);
    }
  }

  // "Reads no body" is a CLAIM, never an inference.
  //
  // Detection resolves same-file helpers one level deep, and that is provably
  // incomplete — `readUpload` hides its multipart read inside an `Effect.gen`
  // the resolver doesn't follow, and any cross-file helper is invisible. If a
  // route with no detected body read were auto-exempted, the failure mode
  // would be a route silently skipping validation forever, which is the exact
  // bug this whole ticket exists to close. So the tool refuses to conclude
  // "safe" from "I didn't find anything" and makes a human say it once.
  for (const h of handlers.filter((x) => x.state === "no-body")) {
    if (!noBody.has(h.id)) {
      errors.push(
        `${h.file}:${h.line} ${h.id} — no body read detected, but that is not proof there is none.\n` +
          `    Body reads hide behind helpers this script cannot follow. Declare it in ${ALLOWLIST_PATH} ` +
          `under "noBody" with a reason, or migrate it to parseRouteBody.`,
      );
    }
  }
  for (const [id] of noBody) {
    const h = handlers.find((x) => x.id === id);
    if (h && h.state !== "no-body") {
      errors.push(
        `${ALLOWLIST_PATH}: ${id} is declared as reading no body, but a body read was detected ` +
          `(${h.state}). The declaration is now false — remove it and migrate the route.`,
      );
    }
  }

  // ── EFB-87: re-audit. Every entry must still describe real, DETECTED debt ──
  //
  // This used to be a warning that an entry looked prunable. A warning was the
  // wrong tier, because the interesting case is not the tidy one. An entry
  // whose marker has vanished is either a route someone already fixed or a
  // marker someone renamed — and in the rename case every OTHER entry on this
  // list stopped being checked at the same moment, silently. That is a failure
  // of the tool, reported by the tool, and it belongs where failures go.
  for (const [id, entry] of byId) {
    const h = handlers.find((x) => x.id === id);
    const blind = entry.scanner_blind_reason;

    // Not a route this scan can see at all: renamed, deleted, or registered
    // with a non-literal path the registration regex cannot match.
    if (!h) {
      if (blind) {
        warnings.push(`${id} — invisible to the scan, declared: ${blind}`);
      } else {
        errors.push(
          `${ALLOWLIST_PATH}: ${id} matches no route this scan can see.\n` +
            `    The route was renamed or deleted (prune the entry), or it is registered with a ` +
            `non-literal path (declare that with "scanner_blind_reason"). An entry that describes ` +
            `nothing protects nothing.`,
        );
      }
      continue;
    }

    // Positive evidence of migration. The ticket's falsification case, and the
    // one an ordinary migration produces when step 4 gets skipped.
    if (h.detected === "migrated") {
      errors.push(
        `${h.file}:${h.line} ${id} — allowlisted as unmigrated debt, but it reads its body through ` +
          `${MIGRATED_MARKER}.\n` +
          `    The route is migrated; remove it from ${ALLOWLIST_PATH}. A ratchet that keeps ` +
          `entries it no longer needs cannot report how much debt is actually left.`,
      );
      continue;
    }

    // The drift class EFB-61 named: no marker found, so the entry is excusing
    // debt nobody can currently see.
    if (h.detected === "no-body" && !blind) {
      errors.push(
        `${h.file}:${h.line} ${id} — allowlisted as unmigrated debt, but none of the ` +
          `${UNMIGRATED_MARKERS.length} body-read markers appear in it.\n` +
          `    Either the route was fixed without ${MIGRATED_MARKER} (prune the entry), or a marker ` +
          `was renamed and UNMIGRATED_MARKERS is now stale — in which case every entry on this list ` +
          `stopped being checked, and all of them need re-auditing, not just this one.\n` +
          `    If the read is real but hidden from detection, say where in "scanner_blind_reason".`,
      );
      continue;
    }
    // A declared blind spot needs no line of its own: the sunset warning above
    // already carries the reason, so the route is reported exactly once.
  }

  const counts = {
    total: handlers.length,
    migrated: handlers.filter((h) => h.state === "migrated").length,
    unmigrated: handlers.filter((h) => h.state === "unmigrated").length,
    noBody: handlers.filter((h) => h.state === "no-body").length,
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
    console.error(
      `${LOG} ${errors.length} problem(s):\n` + errors.map((e) => `- ${e}`).join("\n"),
    );
    console.error(
      `${LOG} ${counts.migrated}/${counts.migrated + counts.unmigrated} body-reading routes migrated.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `${LOG} OK — ${counts.migrated} migrated, ${counts.unmigrated} allowlisted, ` +
      `${counts.noBody} read no body, ${counts.total} handlers scanned.`,
  );
}

main();
