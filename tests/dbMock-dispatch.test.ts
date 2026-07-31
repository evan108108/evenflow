// EFB-35 — fail loud when one DbMock handler shadows another.
//
// The trap this closes: DbMock dispatches by walking an if-chain of
// `sql.startsWith(...)` guards and returning on the first hit. Register a
// GENERIC prefix above a more SPECIFIC one that extends it and the specific
// handler becomes unreachable — the generic body runs instead, binds the
// wrong params, and no-ops silently. The test does not error; it fails later
// and elsewhere with an undefined the author has to trace backwards.
//
// The file already carries six "MUST precede" comments warning about exactly
// this, and EFB-24 hit it anyway. Comments document the hazard; they cannot
// enforce it. This test does.
//
// WHY STATIC, not a runtime check inside the dispatcher. Shadowing is a
// property of the ORDERED GUARD LIST, not of any particular query — handler
// B is dead the moment it is written below A, whether or not a test happens
// to issue SQL that reaches it. Checking the list catches every such pair on
// every run; checking at dispatch time would only catch the pairs some test
// actually exercises, and would report the bug at the point of silent-swallow
// rather than at the point of registration. The ticket asks for the latter.
//
// Reading dbMock's own source is the price of that, and it is the reason the
// extraction below is deliberately conservative: it only understands the
// exact shape the file is written in, and it fails loudly (see the
// sanity-check test) rather than silently finding nothing if that shape
// changes.

import { describe, expect, it } from "vitest";
// `?raw` hands us dbMock's source as a string. node:fs would do the same but
// does not typecheck here — the Worker tsconfig pins `types` to
// @cloudflare/workers-types and there is no @types/node in this program.
// See tests/raw.d.ts for the declaration.
import SOURCE from "./dbMock.ts?raw";

/** One dispatch guard: the literal it matches on, and where it lives. */
interface Guard {
  readonly method: string;
  readonly line: number;
  readonly prefix: string;
  /**
   * True when the guard carries extra conditions beyond the bare prefix
   * (`&& sql.includes(...)`, `&& !sql.includes(...)`). Two guards sharing a
   * prefix are NOT ambiguous if either discriminates further — that is how
   * the orgCache 'personal'/'team' pair is legitimately disambiguated — so
   * compound guards are excluded from the shadowing rule rather than
   * special-cased by name.
   */
  readonly compound: boolean;
}

/**
 * Pull the ordered dispatch guards out of dbMock's source, grouped by the
 * DbService method they sit in. Only top-level guards count: the file indents
 * them at exactly eight spaces inside each method's Effect.sync body, so the
 * anchored pattern skips helper functions and nested conditionals.
 */
const extractGuards = (src: string): Guard[] => {
  const lines = src.split("\n");
  const guards: Guard[] = [];
  let method = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const methodStart = /^    (execute|queryFirst|queryAll):/.exec(line);
    if (methodStart !== null) {
      method = methodStart[1] ?? "";
      continue;
    }
    if (method === "") continue;
    // Top-level guard, possibly wrapped across lines by the formatter.
    if (!/^        if \($/.test(line) && !/^        if \(sql/.test(line)) continue;
    // Re-join a wrapped condition so the prefix literal is visible.
    let condition = line;
    let j = i;
    while (!condition.includes("{") && j + 1 < lines.length) {
      j += 1;
      condition += lines[j] ?? "";
    }
    const prefixMatch = /sql\.startsWith\(\s*"((?:[^"\\]|\\.)*)"/.exec(condition);
    if (prefixMatch === null) continue; // includes()-only guard; not a prefix rule
    const prefix = (prefixMatch[1] ?? "").replace(/\\"/g, '"');
    guards.push({
      method,
      line: i + 1,
      prefix,
      compound: condition.includes("&&"),
    });
  }
  return guards;
};

const GUARDS = extractGuards(SOURCE);

describe("DbMock dispatch guards", () => {
  // If a refactor changes dbMock's shape, the extractor above could quietly
  // match nothing and every assertion below would vacuously pass. Pin the
  // scale so that failure is loud.
  it("extracts guards from all three DbService methods", () => {
    const byMethod = (m: string) => GUARDS.filter((g) => g.method === m).length;
    expect(byMethod("execute")).toBeGreaterThan(50);
    expect(byMethod("queryFirst")).toBeGreaterThan(30);
    expect(byMethod("queryAll")).toBeGreaterThan(20);
  });

  // The rule itself. For each method, walking in registration order, a later
  // guard is unreachable if an earlier one matches everything it matches —
  // i.e. the later prefix starts with the earlier prefix. Equal prefixes are
  // the degenerate case and are caught by the same comparison.
  it("registers no handler that an earlier handler already shadows", () => {
    const shadowed: string[] = [];
    for (const method of ["execute", "queryFirst", "queryAll"]) {
      const inMethod = GUARDS.filter((g) => g.method === method);
      for (let j = 0; j < inMethod.length; j++) {
        const later = inMethod[j]!;
        if (later.compound) continue;
        for (let i = 0; i < j; i++) {
          const earlier = inMethod[i]!;
          if (earlier.compound) continue;
          if (!later.prefix.startsWith(earlier.prefix)) continue;
          shadowed.push(
            `${method}: handler at line ${later.line} is unreachable — ` +
              `"${later.prefix}" is already matched by the handler at line ${earlier.line} ` +
              `("${earlier.prefix}"). Move the more specific handler ABOVE the more ` +
              `general one, or make the prefixes disjoint.`,
          );
          break; // one report per shadowed handler is enough to act on
        }
      }
    }
    expect(shadowed).toEqual([]);
  });

  // Proves the rule above can actually fail. A check that has never been seen
  // to go red is not yet evidence of anything.
  it("detects a shadowing pair when one is introduced", () => {
    const synthetic: Guard[] = [
      { method: "execute", line: 1, prefix: "UPDATE issueCache SET ", compound: false },
      { method: "execute", line: 2, prefix: "UPDATE issueCache SET substrate_event_id = ?", compound: false },
    ];
    const hits = synthetic.filter(
      (later, j) =>
        !later.compound &&
        synthetic.some((earlier, i) => i < j && !earlier.compound && later.prefix.startsWith(earlier.prefix)),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
  });

  // Compound guards share a prefix on purpose (orgCache 'personal' vs 'team',
  // inviteCache RETURNING vs not). Confirm the exemption is load-bearing and
  // not just unused branch coverage.
  it("exempts guards that discriminate beyond the prefix", () => {
    const compound = GUARDS.filter((g) => g.compound);
    expect(compound.length).toBeGreaterThan(0);
    const duplicatedPrefixes = compound.filter((g) =>
      GUARDS.some((o) => o !== g && o.method === g.method && o.prefix === g.prefix),
    );
    expect(duplicatedPrefixes.length).toBeGreaterThan(0);
  });
});
