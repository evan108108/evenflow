// Shared route-handler scanner for the boundary-discipline checks.
//
// Extracted verbatim from check-boundary-discipline.mjs (EFB-54) when EFB-71
// added a second check over the same registrations. The two checks ask
// different questions — "how does this handler read its BODY" vs "how does it
// read its QUERY STRING" — but locating handlers is identical work, and two
// copies of a 200-line regex-and-brace-matching scanner would diverge on the
// first fix applied to one of them.
//
// Nothing here decides anything. This module finds route registrations and
// hands back their source text; what counts as migrated, what counts as debt,
// and what fails the build all live in the caller. That split is deliberate:
// the scanner is the part with no policy in it, so it is the part that can be
// shared without the two checks quietly becoming one.
//
// The comments below are the original EFB-54 rationale, kept because each one
// records a bug this scanner shipped and then fixed.

import fs from "node:fs";
import path from "node:path";

/**
 * Registration: `<router>.<verb>("<path>", <handler...` — or the same with a
 * template literal for the path.
 *
 * EFB-17: the first form of this pattern accepted ONLY a double-quoted
 * literal, which silently excluded `sprints.post(\`…/${verb}\`, …)` — a
 * factory registering `add-issue` and `remove-issue`, both of which read a
 * body through `readJsonBody` with a hand-rolled typeof check. Two
 * body-reading routes were therefore invisible to the ratchet: not migrated,
 * not allowlisted, not reported. The tool said "47 handlers scanned, 0
 * problems" and meant "47 of the 49 registration sites I know how to see".
 *
 * That is this file's own meta-lesson recurring (see the bottom of
 * docs/BOUNDARY_DISCIPLINE.md): a detector's silence is ambiguous, and the
 * pattern list is an implicit contract — here, over how a route may be
 * REGISTERED rather than how its body is read.
 *
 * A template path keeps its `${…}` verbatim in the reported id, because the
 * substitution is not resolvable without an AST walk and inventing a
 * concrete-looking route name would be a worse lie than an honest one.
 *
 * EFB-98 added the third form, `router.post(path("route.id"), …)`, and with it
 * the declaration-based enumeration this comment used to file as follow-up.
 * The id resolves through src/routes-manifest.ts, so the scanner sees a
 * concrete path again — and because the manifest is now the ONLY place a route
 * may be spelled, the bare-identifier hole that hid two body-reading routes in
 * EFB-17 cannot reopen: a computed path no longer reaches Hono at all.
 */
export const registrationPattern = (verbs) =>
  new RegExp(
    String.raw`\b([A-Za-z_$][\w$]*)\.(${verbs.join("|")})\(\s*(?:"([^"]+)"|\x60([^\x60]+)\x60|path\(\s*"([^"]+)"\s*\))\s*,`,
    "g",
  );

/**
 * Route id -> canonical path, read from the manifest.
 *
 * Parsed rather than imported: these checks run in CI before any TypeScript
 * build step, so they cannot import a .ts module.
 */
let manifestPaths = null;
export const resolveManifestPath = (id) => {
  if (manifestPaths === null) {
    manifestPaths = new Map();
    const file = path.join(process.cwd(), "src", "routes-manifest.ts");
    if (fs.existsSync(file)) {
      const src = fs.readFileSync(file, "utf8");
      const open = src.indexOf("[", src.indexOf("export const ROUTES = ["));
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
      if (end !== -1) {
        for (const entry of new Function(`return ${src.slice(open, end + 1)};`)()) {
          manifestPaths.set(entry.id, entry.path);
        }
      }
    }
  }
  return manifestPaths.get(id) ?? null;
};

/**
 * Span of the balanced (), starting at the index of an opening paren.
 * Quote- and comment-aware: a brace inside a string literal must not move the
 * depth counter, or a handler containing `"("` truncates and the check reads
 * the wrong span — silently passing a route it never actually looked at.
 */
export function balancedSpan(src, openIdx, open = "(", close = ")") {
  let depth = 0;
  let i = openIdx;
  let quote = null;
  let inLine = false;
  let inBlock = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (ch === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { start: openIdx, end: i };
    }
  }
  return null;
}

/**
 * Body of a same-file `const <name> = ...` declaration.
 *
 * Balanced to the end of the declaration's own block rather than sliced to the
 * next `const`. The slice-to-next-const version over-captured: an unrelated
 * neighbouring function containing a body read got pulled in, and helpers were
 * misreported as reading bodies they never touch. Over-reporting is cheaper
 * than under-reporting here, but a checker nobody trusts gets switched off.
 */
export function resolveIdentifierBody(src, name) {
  const decl = new RegExp(String.raw`\bconst\s+${name}\s*[=:]`).exec(src);
  if (!decl) return null;
  const brace = src.indexOf("{", decl.index);
  const paren = src.indexOf("(", decl.index);
  // Whichever opens first delimits the declaration's body: `= (c) => …` opens
  // on a paren, `= { … }` and `=> { … }` on a brace.
  const useBrace = brace !== -1 && (paren === -1 || brace < paren);
  const openIdx = useBrace ? brace : paren;
  if (openIdx === -1) return null;
  const span = useBrace
    ? balancedSpan(src, openIdx, "{", "}")
    : balancedSpan(src, openIdx, "(", ")");
  if (span === null) return null;
  // For an arrow declared `= (args) => { body }`, the balanced paren span only
  // covers the ARGS. Extend through the arrow body when one follows.
  const after = src.slice(span.end + 1, span.end + 400);
  const arrow = /^\s*(:[^=]*)?=>\s*\{/.exec(after);
  if (!useBrace && arrow) {
    const bodyOpen = src.indexOf("{", span.end + arrow[0].length - 1);
    const bodySpan = balancedSpan(src, bodyOpen, "{", "}");
    if (bodySpan !== null) return src.slice(decl.index, bodySpan.end + 1);
  }
  // EFB-71: a CONCISE arrow body — `= (c) => Effect.gen(function* () { … })`
  // — has no brace after the `=>`, so the block form above does not match and
  // the resolver used to return the ARGUMENT LIST alone. The helper's body was
  // therefore never searched.
  //
  // That was not theoretical. `requestedDays` in sprints.ts is declared exactly
  // this way and reads `c.req.query("days")`; both GET tide routes call it, and
  // both were classified as reading no query at all. A helper-shaped blind spot
  // is the precise failure the withHelpers pass exists to prevent, so the
  // resolver has to see through this form too.
  const call = /^\s*(:[^=]*)?=>\s*[\w$.]+\s*\(/.exec(after);
  if (!useBrace && call) {
    const callOpen = src.indexOf("(", span.end + call[0].length - 1);
    const callSpan = balancedSpan(src, callOpen, "(", ")");
    if (callSpan !== null) return src.slice(decl.index, callSpan.end + 1);
  }
  return src.slice(decl.index, span.end + 1);
}

/**
 * Reads hide behind helpers. `POST .../attachments` reads multipart via
 * `readUpload(c)`, and five route files keep private `readJsonBody` copies —
 * none of which contain a marker at the call site. So before classifying, pull
 * in the source of every same-file helper the handler calls (one level deep,
 * which is all this codebase needs) and classify against the union.
 *
 * Cross-file helpers are still invisible to this, which is why a handler with
 * no detected read is NOT assumed safe — see each check's declaration rules.
 */
export function withHelpers(handlerSrc, fileSrc) {
  const called = new Set();
  // The lookbehind is load-bearing: `\b` alone matches AFTER A DOT, so a raw
  // `c.req.query(...)` read contributed the bare identifier `query`, and a
  // same-file `const query = …` then got concatenated into this handler's
  // source. A handler reading no schema at all was reported as calling both a
  // schema parse and a raw read, and the check exited 1 on a route that was
  // fine.
  //
  // `.param(`, `.get(` and `.json(` leak the same way, so any file pairing a
  // raw read with a same-named local trips it. The bug is older than EFB-98;
  // src/routes/issues.ts is simply the first file to collide.
  //
  // A dot-preceded name is a method call on some object, never a free function
  // declared in this file, so excluding it strictly removes false pull-ins and
  // cannot drop a real helper: a same-file helper is called bare.
  for (const m of handlerSrc.matchAll(/(?<![.\w$])([a-z][\w$]*)\s*\(/g)) called.add(m[1]);
  let combined = handlerSrc;
  for (const name of called) {
    if (name === "if" || name === "for" || name === "while" || name === "switch") continue;
    const body = resolveIdentifierBody(fileSrc, name);
    if (body !== null) combined += "\n" + body;
  }
  return combined;
}

/**
 * Every route registration in one file, with the handler's source text.
 *
 * `classify(handlerSrc, fileSrc)` is the caller's policy: it receives the
 * handler span and the whole file (for helper resolution) and returns a state
 * string. A registration whose handler span cannot be determined is reported
 * as `"unparsed"` WITHOUT consulting classify — refusing to guess is the
 * scanner's one opinion, because a checker that silently skips what it cannot
 * read is the bug class these checks exist to catch.
 */
export function scanFile(absPath, relPath, { verbs, classify, middlewareAware = false }) {
  const src = fs.readFileSync(absPath, "utf8");
  const registration = registrationPattern(verbs);
  const found = [];
  let m;
  while ((m = registration.exec(src)) !== null) {
    const [, , verb, quotedPath, templatePath, manifestId] = m;
    const routePath =
      quotedPath ??
      templatePath ??
      // An id that resolves to nothing falls back to the id itself rather than
      // to undefined, so a typo surfaces as an unmatched route rather than as
      // a route that quietly stops being scanned.
      (manifestId === undefined ? undefined : (resolveManifestPath(manifestId) ?? manifestId));
    const openIdx = src.indexOf("(", m.index);
    const span = balancedSpan(src, openIdx);
    const line = src.slice(0, m.index).split("\n").length;
    if (!span) {
      found.push({
        id: `${verb.toUpperCase()} ${routePath}`,
        file: relPath,
        line,
        state: "unparsed",
      });
      continue;
    }
    let handlerSrc = src.slice(m.index, span.end + 1);
    // Non-inline handler: `router.post("/x", someHandler(true))` — the body
    // lives in a const, so follow it. Without this the span holds no body
    // read and the route is misreported as "no-body".
    const afterComma = handlerSrc.slice(handlerSrc.indexOf(",") + 1).trim();
    let inline = /^(async\s*)?\(/.test(afterComma) || afterComma.startsWith("async");
    // EFB-71: middleware can sit between the path and the handler —
    // `auth.get("/whoami", requireAuth(layerFor), async (c) => { … })`. The
    // argument after the path is then a CALL, not the handler, and resolving it
    // as a same-file const fails, so the route reported as "unparsed".
    //
    // Off by default: the body check's verbs never hit this shape, and its
    // output is pinned byte-for-byte. The query check scans every verb, where
    // the shape is real. When it applies, the whole registration span is the
    // classification unit — which is also the honest choice, since middleware
    // in that span can read the request just as the handler can.
    if (!inline && middlewareAware) {
      inline = /,\s*(async\s*)?\([^)]*\)\s*(:[^=]*)?=>/.test(handlerSrc);
    }
    if (!inline) {
      const ident = /^([A-Za-z_$][\w$]*)/.exec(afterComma);
      if (ident) {
        const resolved = resolveIdentifierBody(src, ident[1]);
        if (resolved === null) {
          found.push({
            id: `${verb.toUpperCase()} ${routePath}`,
            file: relPath,
            line,
            state: "unparsed",
          });
          continue;
        }
        handlerSrc = resolved;
      }
    }
    found.push({
      id: `${verb.toUpperCase()} ${routePath}`,
      file: relPath,
      line,
      state: classify(handlerSrc, src),
    });
  }
  return found;
}

/** Every `.ts` route file under `routesDir`, scanned and flattened. */
export function scanRoutes(routesDir, options) {
  return fs
    .readdirSync(routesDir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .flatMap((f) => scanFile(path.join(routesDir, f), `${routesDir}/${f}`, options));
}

/**
 * Registration sites this scanner CANNOT see, for a check to report out loud.
 *
 * `router.post(path, handler)` with a bare-identifier path is invisible to the
 * registration regex — resolving it needs an AST walk. Counting the calls whose
 * first argument is neither a string nor a template literal at least turns an
 * unknown-unknown into a number a human can compare against the scanned total.
 *
 * EFB-98: `path("route.id")` is explicitly NOT opaque. It resolves through the
 * manifest, so the scanner sees a concrete path for it. Counting it here would
 * report every route in the codebase as invisible and make the number that
 * exists to measure a blind spot the loudest lie in the output.
 */
export function countOpaqueRegistrations(routesDir, verbs) {
  const pattern = new RegExp(
    String.raw`\b[A-Za-z_$][\w$]*\.(${verbs.join("|")})\(\s*(?!["\x60]|path\(\s*")[A-Za-z_$]`,
    "g",
  );
  let n = 0;
  for (const f of fs.readdirSync(routesDir).filter((x) => x.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(routesDir, f), "utf8");
    n += [...src.matchAll(pattern)].length;
  }
  return n;
}
