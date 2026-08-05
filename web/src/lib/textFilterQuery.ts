// EFB-112 — text-filter query language.
//
// Grammar:
//   - Bare text (no prefix)  → matches title OR body
//   - `title:foo`            → title only
//   - `body:foo` / `description:foo` / `desc:foo` → body only
//   - `type:bug`             → issue.type match (exact, case-insensitive)
//   - Bare `EFB-115` (any `EFB-\d+`) → short_id match
//   - `-clause`              → negation (must NOT match)
//   - `"quoted phrase"`      → phrase, tolerates spaces
//   - Multiple clauses AND'd together
//
// Case-insensitive on prefix keyword and on the search term. Parse errors
// (a stray colon, an unclosed quote) degrade gracefully — the raw string
// falls through as a bare-text clause rather than throwing, since the input
// is user typing and shouldn't produce a hard failure.
//
// NOTE the assignee/label prefixes were intentionally left out — they
// duplicate what the dedicated chips already offer, and the text bar is for
// dimensions the chips DON'T cover.

import type { Issue } from "./types";

export type ClauseScope = "any" | "title" | "body" | "type" | "short_id";

export interface Clause {
  readonly scope: ClauseScope;
  /** Lower-cased search term. */
  readonly term: string;
  readonly negate: boolean;
}

const SHORT_ID_RE = /^EFB-\d+$/i;

const PREFIX_ALIASES: Record<string, ClauseScope> = {
  title: "title",
  body: "body",
  description: "body",
  desc: "body",
  type: "type",
};

/**
 * Tokenise a raw query string into clauses.
 *
 * The tokeniser walks the string once, gathering whitespace-delimited pieces
 * and folding double-quoted spans into a single token so a phrase with
 * spaces stays intact.
 */
export const parseTextFilter = (raw: string): ReadonlyArray<Clause> => {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const tokens: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    const c = trimmed[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    // Optional leading `-` for negation stays part of the token.
    let start = i;
    let inQuote = false;
    while (i < trimmed.length) {
      const ch = trimmed[i]!;
      if (ch === '"') {
        inQuote = !inQuote;
        i++;
        continue;
      }
      if (!inQuote && (ch === " " || ch === "\t")) break;
      i++;
    }
    tokens.push(trimmed.slice(start, i));
  }
  return coalescePrefixSpace(tokens)
    .map((tok) => toClause(tok))
    .filter((c): c is Clause => c !== null);
};

// Users often type `title: foo` with a space after the colon — matches
// natural English cadence. The whitespace tokeniser would split that into
// `title:` and `foo`, so we walk the token list and glue any bare
// `[-]?prefix:` (with nothing after the colon) onto its next neighbour.
const PREFIX_ONLY_RE = /^-?(?:title|body|description|desc|type):$/i;
const coalescePrefixSpace = (tokens: readonly string[]): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (PREFIX_ONLY_RE.test(t) && i + 1 < tokens.length) {
      out.push(t + tokens[i + 1]);
      i += 2;
      continue;
    }
    out.push(t);
    i++;
  }
  return out;
};

const stripQuotes = (s: string): string => {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
};

const toClause = (rawTok: string): Clause | null => {
  let tok = rawTok;
  let negate = false;
  if (tok.startsWith("-") && tok.length > 1) {
    negate = true;
    tok = tok.slice(1);
  }
  // `short_id` shorthand — a bare EFB-\d+ (with or without quotes) is a
  // short_id match. Case-insensitive.
  const unquoted = stripQuotes(tok);
  if (SHORT_ID_RE.test(unquoted)) {
    return { scope: "short_id", term: unquoted.toLowerCase(), negate };
  }
  // Prefix form `key:value`. Split on the FIRST colon so a value can itself
  // contain colons (e.g. a URL in a title:… search).
  const colonAt = tok.indexOf(":");
  if (colonAt > 0) {
    const key = tok.slice(0, colonAt).toLowerCase();
    const value = stripQuotes(tok.slice(colonAt + 1));
    const scope = PREFIX_ALIASES[key];
    if (scope !== undefined && value !== "") {
      return { scope, term: value.toLowerCase(), negate };
    }
    // Unrecognised prefix — fall through to bare-text.
  }
  const term = stripQuotes(tok);
  if (term === "") return null;
  return { scope: "any", term: term.toLowerCase(), negate };
};

const matchesClause = (issue: Issue, clause: Clause): boolean => {
  const { scope, term } = clause;
  if (scope === "any") {
    const title = issue.title.toLowerCase();
    const body = (issue.body ?? "").toLowerCase();
    return title.includes(term) || body.includes(term);
  }
  if (scope === "title") return issue.title.toLowerCase().includes(term);
  if (scope === "body") return (issue.body ?? "").toLowerCase().includes(term);
  if (scope === "type") return issue.type.toLowerCase() === term;
  // short_id
  return (issue.short_id ?? "").toLowerCase() === term;
};

/** All clauses must pass. Negated clauses invert. */
export const matchesTextFilter = (
  issue: Issue,
  clauses: ReadonlyArray<Clause>,
): boolean => {
  for (const c of clauses) {
    const hit = matchesClause(issue, c);
    if (c.negate ? hit : !hit) return false;
  }
  return true;
};
