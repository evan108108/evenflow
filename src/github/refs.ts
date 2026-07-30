// Ticket-ref extraction: which evenflow issues does this PR belong to?
//
// Pure string work, no DB — the caller resolves the returned short ids
// against issueCache scoped to the board. Two sources, in precedence order:
//
//   1. EXPLICIT override — an `evenflow: EFB-42` line in the PR body. When
//      present it WINS OUTRIGHT and inference is skipped entirely; that is
//      the escape hatch for a PR whose branch name lies.
//   2. INFERRED — PREFIX-\d+ anywhere in title, body, or branch name.
//
// Deliberately NOT implemented in v1 (Evan-approved): resolving GitHub
// `Closes #N` to a ticket. issueCache.github_links holds {repo, pr, state}
// — PR numbers, not GH issue numbers — so there is no table mapping a GH
// issue to a ticket, and inventing one silently would match the wrong
// thing. When a real link table lands, it plugs in here as source 3.

import { SHORT_ID_RE } from "../slug";

/** `evenflow: EFB-42` / `Evenflow: efb-42, EFB-9` — the explicit override. */
const OVERRIDE_RE = /^[ \t]*evenflow[ \t]*:[ \t]*(.+)$/gim;

/**
 * Candidate short ids in free text. Intentionally looser than SHORT_ID_RE
 * (which anchors) and re-validated against it below.
 *
 * The boundaries are the fiddly part, and each one is load-bearing:
 *   * leading `(?<![A-Za-z0-9-])` — stops "B-12" matching inside "SUB-12".
 *   * trailing `(?![A-Za-z0-9])` — stops "EFB-4" matching inside "EFB-42".
 *   * trailing `(?!-\d)` — rejects date-shaped text. "2026-07-30" would
 *     otherwise yield the perfectly valid-looking short id "2026-07".
 *
 * A following `-<letter>` is deliberately ALLOWED, because that is exactly
 * how branch names are written: feature/KB-7-external-state must yield
 * KB-7. Forbidding a trailing dash outright (the obvious first cut) makes
 * the matcher blind to every branch-name ref, which is the single most
 * common way a PR names its ticket.
 */
const CANDIDATE_RE = /(?<![A-Za-z0-9-])([A-Za-z0-9]{2,5}-\d+)(?![A-Za-z0-9])(?!-\d)/g;

const collect = (text: string | null | undefined, into: Set<string>): void => {
  if (typeof text !== "string" || text === "") return;
  for (const m of text.matchAll(CANDIDATE_RE)) {
    const candidate = m[1]?.toUpperCase();
    if (candidate !== undefined && SHORT_ID_RE.test(candidate)) into.add(candidate);
  }
};

export interface RefSources {
  readonly title?: string | null;
  readonly body?: string | null;
  readonly branch?: string | null;
}

export interface RefMatch {
  /** Uppercased short ids, de-duplicated, in discovery order. */
  readonly shortIds: ReadonlyArray<string>;
  /** True when an `evenflow:` line decided it and inference was skipped. */
  readonly explicit: boolean;
}

/**
 * Extract ticket refs from a PR's text. An explicit `evenflow:` line short
 * -circuits inference; otherwise title, body and branch are all scanned.
 *
 * Multiple matches are all returned — the caller applies the action to
 * every matched ticket, per the approved design.
 */
export const extractTicketRefs = (sources: RefSources): RefMatch => {
  const explicitIds = new Set<string>();
  if (typeof sources.body === "string") {
    for (const m of sources.body.matchAll(OVERRIDE_RE)) {
      collect(m[1], explicitIds);
    }
  }
  if (explicitIds.size > 0) {
    return { shortIds: [...explicitIds], explicit: true };
  }

  const inferred = new Set<string>();
  collect(sources.title, inferred);
  collect(sources.body, inferred);
  // Branch names use slashes and dashes: feature/EFB-42-do-the-thing.
  collect(sources.branch, inferred);
  return { shortIds: [...inferred], explicit: false };
};
