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

/**
 * Closing keywords, GitHub's own set. A body ref only means "this PR is about
 * that ticket" when one of these introduces it.
 *
 * `[:\s]+` and the optional `#` accept the spellings people actually write:
 * `Closes EFB-83`, `Closes: EFB-83`, `Fixes #EFB-83`.
 */
const CLOSING_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[:\s]+#?([A-Za-z0-9]{2,5}-\d+)(?![A-Za-z0-9])(?!-\d)/gi;

/**
 * Blank out regions whose ticket refs are not claims about this PR.
 *
 * Replaced with spaces rather than removed so every surviving offset is
 * unchanged — the scan below is offset-insensitive today, but a masker that
 * silently reflows text is a trap for whoever adds an offset-aware rule next.
 *
 * Three regions, and each one was verified to match BEFORE this existed:
 *   * fenced blocks and inline code — a ref inside a sample is illustrating
 *     something, not claiming a relationship.
 *   * URLs — a link to `/issue/EFB-72` points at that ticket's PAGE. The
 *     ticket UI already shows its PRs from the other direction, so reading a
 *     hyperlink as "this PR touches that ticket" invents an association the
 *     author did not make.
 *
 * This is why the two workarounds normally suggested for citing a ticket
 * without triggering automation — put it in backticks, or link to it — both
 * failed: nothing stripped either region, so both matched exactly like prose.
 */
const mask = (text: string): string => {
  const blank = (s: string) => " ".repeat(s.length);
  return text
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/\bhttps?:\/\/\S+/gi, blank);
};

const collect = (text: string | null | undefined, into: Set<string>): void => {
  if (typeof text !== "string" || text === "") return;
  for (const m of mask(text).matchAll(CANDIDATE_RE)) {
    const candidate = m[1]?.toUpperCase();
    if (candidate !== undefined && SHORT_ID_RE.test(candidate)) into.add(candidate);
  }
};

/** Refs a closing keyword introduces, in the body only. */
const collectClosing = (text: string | null | undefined, into: Set<string>): void => {
  if (typeof text !== "string" || text === "") return;
  for (const m of mask(text).matchAll(CLOSING_RE)) {
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
  /**
   * Every ticket this PR MENTIONS. Drives the github_links panel — a PR that
   * names a ticket should show up on that ticket's card whether or not it is
   * closing it.
   */
  readonly shortIds: ReadonlyArray<string>;
  /**
   * The subset this PR is ABOUT. Drives lifecycle automation — transitions,
   * container moves, external state.
   *
   * Always a subset of `shortIds`.
   */
  readonly closingIds: ReadonlyArray<string>;
  /** True when an `evenflow:` line decided it and inference was skipped. */
  readonly explicit: boolean;
}

/**
 * Extract ticket refs from a PR's text. An explicit `evenflow:` line short
 * -circuits inference; otherwise title, body and branch are all scanned.
 *
 * TWO SETS, because two different questions were being answered by one:
 *
 *   shortIds  — which tickets does this PR MENTION?  (informational)
 *   closingIds — which tickets is this PR ABOUT?     (lifecycle)
 *
 * Everything used to be the first set, and the automation consumed it. So a
 * body that cited prior work for a reviewer — "follow-up to EFB-61", "see the
 * doc from EFB-98" — transitioned every ticket it named. One batch of four PRs
 * dragged eight finished tickets back onto the board.
 *
 * WHAT COUNTS AS "ABOUT", and the asymmetry is the whole fix:
 *   * an `evenflow:` override — an explicit declaration of intent
 *   * the BRANCH name — `feature/EFB-42-do-the-thing`
 *   * the TITLE
 *   * in the BODY, only behind a closing keyword — `Closes EFB-42`
 *
 * Branch and title count on their own because they are how a PR says what it
 * IS; nobody names an unrelated ticket in a branch. A body is prose, and prose
 * cites things. Requiring the keyword everywhere — the obvious reading of
 * "match GitHub's convention" — would have broken the common case (a PR whose
 * only ref is its branch name) to fix the rare one.
 */
export const extractTicketRefs = (sources: RefSources): RefMatch => {
  const explicitIds = new Set<string>();
  if (typeof sources.body === "string") {
    for (const m of sources.body.matchAll(OVERRIDE_RE)) {
      collect(m[1], explicitIds);
    }
  }
  if (explicitIds.size > 0) {
    // An override says outright which tickets this PR is for, so it settles
    // both questions at once.
    const ids = [...explicitIds];
    return { shortIds: ids, closingIds: ids, explicit: true };
  }

  const inferred = new Set<string>();
  collect(sources.title, inferred);
  collect(sources.body, inferred);
  // Branch names use slashes and dashes: feature/EFB-42-do-the-thing.
  collect(sources.branch, inferred);

  const closing = new Set<string>();
  collect(sources.title, closing);
  collect(sources.branch, closing);
  collectClosing(sources.body, closing);

  return { shortIds: [...inferred], closingIds: [...closing], explicit: false };
};
