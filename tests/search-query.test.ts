// EFB-14 — the pure half of search: turning user text into an FTS5 MATCH
// expression.
//
// WHY THIS IS A UNIT TEST AND THE REST IS NOT
//
// Everything else about search — does the index populate, does BM25 order
// results, does the board filter hold — is a claim about SQLite's FTS5, and
// tests/dbMock.ts does not implement FTS5. Asserting those here would assert
// the mock's behaviour and nothing else, which is precisely the failure EFB-35
// found and tests/integration/ exists to prevent. Those live in
// tests/integration/search.test.ts, against a real D1.
//
// `ftsMatchExpression` is the exception: it is pure string→string, it has no
// database in it, and it is the piece with the nastiest failure mode. An
// escaping bug here does not throw — it silently searches for something other
// than what the user typed, or turns a search box into a way to hand FTS5
// arbitrary query syntax. So it gets tested at the level it lives at.

import { describe, expect, it } from "vitest";
import { ftsMatchExpression } from "../src/routes/search";

describe("ftsMatchExpression — user text to FTS5 MATCH", () => {
  it("quotes each term and joins with implicit AND", () => {
    expect(ftsMatchExpression("search ranking")).toBe('"search" "ranking"');
  });

  it("treats a single word as a single quoted phrase", () => {
    expect(ftsMatchExpression("ranking")).toBe('"ranking"');
  });

  // The operators. Each of these, passed through unescaped, is either a SQL
  // error the user sees as a broken search box, or a query that quietly means
  // something other than what they typed.
  it.each([
    ["bare AND", "foo AND bar", '"foo" "AND" "bar"'],
    ["bare OR", "foo OR bar", '"foo" "OR" "bar"'],
    ["bare NOT", "foo NOT bar", '"foo" "NOT" "bar"'],
    ["NEAR", "NEAR(foo bar)", '"NEAR" "foo" "bar"'],
    ["column filter", "title : foo", '"title" "foo"'],
    ["prefix star", "foo*", '"foo"'],
    ["initial token", "^foo", '"foo"'],
    ["parens", "(foo OR bar)", '"foo" "OR" "bar"'],
    ["double quotes", 'say "hello"', '"say" "hello"'],
    ["unbalanced quote", 'foo"', '"foo"'],
    ["C++", "C++ generics", '"C" "generics"'],
  ])("neutralizes %s", (_label, input, expected) => {
    expect(ftsMatchExpression(input)).toBe(expected);
  });

  // Operators become literal terms rather than being dropped — "foo AND bar"
  // searches for the word "and" too. That is the deliberate trade: a search
  // box is not a query language, and a user who types AND almost certainly
  // means the word. Asserted so a future change to drop stopwords is a
  // decision someone makes, not a silent drift.
  it("keeps operator words as ordinary search terms", () => {
    expect(ftsMatchExpression("AND")).toBe('"AND"');
  });

  it("returns null when there is no searchable term", () => {
    expect(ftsMatchExpression("")).toBeNull();
    expect(ftsMatchExpression("   ")).toBeNull();
    expect(ftsMatchExpression("???")).toBeNull();
    expect(ftsMatchExpression("*")).toBeNull();
    expect(ftsMatchExpression('"')).toBeNull();
  });

  it("keeps digits, underscores and non-ASCII letters", () => {
    expect(ftsMatchExpression("EFB_14 ships")).toBe('"EFB_14" "ships"');
    expect(ftsMatchExpression("café naïve")).toBe('"café" "naïve"');
    expect(ftsMatchExpression("日本語 search")).toBe('"日本語" "search"');
  });

  it("caps term count so a pasted stack trace cannot build a huge conjunction", () => {
    const many = Array.from({ length: 40 }, (_, i) => `term${i}`).join(" ");
    const expr = ftsMatchExpression(many);
    expect(expr).not.toBeNull();
    expect(expr?.split(" ").length).toBe(16);
    // The terms kept are the leading ones — what the user typed first.
    expect(expr?.startsWith('"term0" "term1"')).toBe(true);
    expect(expr).not.toContain("term16");
  });

  // No input may produce a bare (unquoted) token, because a bare token is the
  // only way FTS5 syntax gets in. This is the invariant the whole function
  // exists for, asserted directly rather than via the case list above.
  it("never emits an unquoted token, for any input", () => {
    const nasty = [
      'a" OR "b',
      "foo AND (bar NEAR baz)",
      "col:val*",
      "\\\"escaped\\\"",
      "'; DROP TABLE issueCache; --",
      "{ } [ ] < > | & ! @ # $ % ^ & *",
    ];
    for (const input of nasty) {
      const expr = ftsMatchExpression(input);
      if (expr === null) continue;
      for (const token of expr.split(" ")) {
        expect(token.startsWith('"')).toBe(true);
        expect(token.endsWith('"')).toBe(true);
        // Exactly two quotes: the wrapping pair, nothing inside to close it
        // early and reopen as syntax.
        expect(token.split('"').length - 1).toBe(2);
      }
    }
  });
});
