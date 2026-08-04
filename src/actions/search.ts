// Search actions — board-scoped full-text search over issueCache and
// commentCache, backed by the FTS5 indexes migration 0027 creates.
//
// MVP shape (EFB-14): text in, ranked matches out, scoped to one board. No
// cross-board search, no filter chips, no recency or assignee boosts — BM25
// as FTS5 computes it, and nothing on top. The migration's header explains
// why the index stores its own copy of the text rather than using
// `content=`; this file explains the two things the SEARCH is responsible for.
//
// EFB-98 split this out of src/routes/search.ts. The body moved VERBATIM; the
// only edits read the board slug, the org and the decoded body off `input`
// instead of off a Context. The route keeps the body parse and the
// failure-to-status mapping.
//
// ── 1. AUTHORIZATION HAPPENS BEFORE THE INDEX IS TOUCHED ────────────────
//
// The FTS tables hold plaintext from every board, private ones included —
// they have to, because `issueCache.body` is plaintext on every board and an
// index that skipped private boards would buy no confidentiality while making
// search useless (migration 0027 has the full argument, including why
// kind:30556 does not make these rows encrypted at rest).
//
// So the board gate is the whole of the access control here, and it runs
// FIRST: `resolveBoardScope(..., "viewer", input.grants)` resolves the slug and authorizes
// the caller before a single FTS row is read. A caller who cannot see the
// board gets 404 — the codebase's standing posture for invisible resources
// (src/authz.ts header: existence must not leak), so a private board is
// indistinguishable from one that does not exist. Because the gate is on the
// BOARD and the query is scoped to that one board, there is no per-row
// membership filtering to get wrong, and no result count or rank value that
// could act as a side channel for a board the caller cannot see.
//
// Anything added here that reaches issueCacheFts/commentCacheFts on a path
// that does not run that gate first — a cross-board endpoint especially — is
// a plaintext leak across board boundaries. That is the review question for
// the follow-up ticket, not an implementation detail.
//
// ── 2. USER TEXT NEVER REACHES FTS5 AS QUERY SYNTAX ─────────────────────
//
// `MATCH` takes an expression language, not a string: `AND`, `OR`, `NOT`,
// `NEAR`, `*`, `^`, `:`, parentheses and double quotes are all operators. Two
// consequences, and they point the same way. A user typing `C++ AND` gets a
// SQL error rather than results, and a user typing `title : foo` is silently
// running a different query than they think. `ftsMatchExpression` therefore
// does not escape the input — it EXTRACTS from it, keeping only letter/digit
// runs and re-emitting each as a quoted phrase. Nothing a caller can type
// survives as an operator.

import { Effect, Schema } from "effect";

import { Db, DbError } from "../effects";
import type { ValidationError } from "../lib/errors";
import {
  ForbiddenError,
  UnauthorizedError,
  callerPubkey,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { parseCommentRow, parseIssueRow, type CommentShape, type IssueShape } from "../shapes";
import { NonEmptyString } from "../lib/route-body";
import type { PublicActionInput } from "./types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Ceiling on how many terms one query contributes to the MATCH expression.
 * A pasted stack trace is a legitimate accident, not an attack, and FTS5
 * degrades badly on hundred-term conjunctions. Extra terms are dropped, not
 * rejected: the first terms are the ones the user meant.
 */
const MAX_TERMS = 16;

/**
 * Build a safe FTS5 MATCH expression from arbitrary user text.
 *
 * Extraction, not escaping — see the header. Unicode letters and digits (plus
 * `_`) form terms; everything else is a separator and is discarded, so no
 * input can produce an FTS5 operator. Each term is emitted as a quoted phrase
 * and terms are joined by space, which is FTS5's implicit AND: every term
 * must appear, which is what a search box is understood to mean.
 *
 * Returns null when the text carries no searchable term at all (empty,
 * whitespace, or pure punctuation like `???`). That is a query with no
 * matches rather than a malformed request, and the action answers it with
 * empty results instead of a 400.
 *
 * Exported for unit test: this is the one piece of search that is pure, and
 * the one where a regression is a silent behaviour change rather than a
 * failure — an escaping bug does not throw, it quietly searches for the
 * wrong thing.
 */
export const ftsMatchExpression = (q: string): string | null => {
  const terms = q.match(/[\p{L}\p{N}_]+/gu);
  if (terms === null || terms.length === 0) return null;
  return terms
    .slice(0, MAX_TERMS)
    .map((t) => `"${t}"`)
    .join(" ");
};

export const SearchBody = Schema.Struct({
  q: NonEmptyString,
  limit: Schema.optional(Schema.Int.pipe(Schema.greaterThanOrEqualTo(1))),
});

/**
 * The body arrives UN-PARSED, as the Effect that will parse it.
 *
 * This route gated before it parsed, and the order is load-bearing: a caller
 * who cannot see the board has always been told 404, malformed body or not.
 * A shell that parsed first would answer 400 there instead — a status-code
 * change, which BOUNDARY_DISCIPLINE.md (§"Existing behavior must not change")
 * says needs its own ticket rather than riding along inside a migration.
 *
 * Effects are lazy, so the route can build `parseRouteBody(c, SearchBody)`
 * without running it — check:boundary still sees the marker where it always
 * has — and the action runs it at the exact line the parse used to sit on.
 * The odd-looking type is the point: it says out loud that this parse is
 * deferred deliberately, so the next reader does not flatten it back.
 */
export type DeferredSearchBody = Effect.Effect<typeof SearchBody.Type, ValidationError>;

/**
 * The failure union this route answers. `ValidationError` is the shared
 * vocabulary from src/lib/errors.ts — the same tag the body parse raises.
 */
export type SearchFailure =
  | ValidationError
  | BoardOwnershipError
  | UnauthorizedError
  | ForbiddenError
  | DbError;

/** Services the search action needs. */
export type SearchServices = Db;

/** An issue hit: the issue as other endpoints return it, plus its BM25 score. */
interface IssueHit {
  readonly issue: IssueShape;
  readonly rank: number;
}

/**
 * A comment hit carries its issue's title and short id. A comment body on its
 * own is unlinkable — the client needs somewhere to navigate to, and the
 * alternative is a second round trip per result.
 */
interface CommentHit {
  readonly comment: CommentShape;
  readonly issue_id: string;
  readonly issue_title: string | null;
  readonly issue_short_id: string | null;
  readonly rank: number;
}

/**
 * POST /board/:slug/search — anonymous-readable, like every other viewer read.
 *
 * POST rather than GET because the query is a body, not a path component:
 * search text routinely contains `/`, `#`, `?` and `&`, and a body keeps
 * the terms out of access logs and browser history. The route parses it with
 * `parseRouteBody` per Boundary Discipline (EFB-54).
 */
export const searchBoard = (
  input: PublicActionInput<DeferredSearchBody>,
): Effect.Effect<
  { issues: IssueHit[]; comments: CommentHit[] },
  SearchFailure,
  SearchServices
> =>
  Effect.gen(function* () {
    // FIRST. Nothing below reads the FTS tables until this returns.
    const { board } = yield* resolveBoardScope(
      { org_slug: input.orgSlug ?? undefined, slug: input.params["slug"] ?? "" },
      input.claims === null ? null : callerPubkey(input.claims),
      "viewer", input.grants,);

    // AFTER the board gate, deliberately — see DeferredSearchBody. A caller who
    // cannot see this board gets the gate's 404, not a 400 about their body.
    const body = yield* input.body;
    const limit = Math.min(body.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const match = ftsMatchExpression(body.q);
    // No searchable term — an answerable query with no matches.
    if (match === null) {
      return { issues: [] as IssueHit[], comments: [] as CommentHit[] };
    }

    const db = yield* Db;

    // `ORDER BY rank` is FTS5's BM25, ascending: more negative is a better
    // match, so ascending is best-first. No tie-break column is added —
    // BM25 ties are genuine ties and inventing an ordering for them would
    // be exactly the kind of unstated ranking tweak this MVP excludes.
    const issueHits = yield* db.queryAll<{ id: string; rank: number }>(
      "SELECT id, bm25(issueCacheFts) AS rank FROM issueCacheFts WHERE issueCacheFts MATCH ? AND board_id = ? ORDER BY rank LIMIT ?",
      [match, board.id, limit],
    );
    const commentHits = yield* db.queryAll<{ id: string; issue_id: string; rank: number }>(
      "SELECT id, issue_id, bm25(commentCacheFts) AS rank FROM commentCacheFts WHERE commentCacheFts MATCH ? AND board_id = ? ORDER BY rank LIMIT ?",
      [match, board.id, limit],
    );

    // Hydration reads the source rows so a result is byte-identical to what
    // GET on that issue returns. The index's copy of the text is for
    // matching only and is deliberately never rendered — if the two ever
    // disagree, the source table wins and the drift stays invisible to
    // users rather than showing them a stale body.
    //
    // The board_id predicate is repeated here rather than trusted from the
    // index. It is redundant while the triggers are correct, and it is the
    // thing that keeps a trigger bug from becoming a cross-board leak.
    const issueIds = issueHits.map((h) => h.id);
    const issues = new Map<string, IssueShape>();
    if (issueIds.length > 0) {
      const rows = yield* db.queryAll<Record<string, unknown>>(
        `SELECT * FROM issueCache WHERE board_id = ? AND id IN (${issueIds.map(() => "?").join(", ")})`,
        [board.id, ...issueIds],
      );
      for (const row of rows) {
        const issue = parseIssueRow(row);
        issues.set(issue.id, issue);
      }
    }

    const commentIds = commentHits.map((h) => h.id);
    const comments = new Map<string, CommentShape>();
    if (commentIds.length > 0) {
      const rows = yield* db.queryAll<Record<string, unknown>>(
        `SELECT * FROM commentCache WHERE id IN (${commentIds.map(() => "?").join(", ")})`,
        commentIds,
      );
      for (const row of rows) {
        const comment = parseCommentRow(row);
        comments.set(comment.id, comment);
      }
    }

    // Comment hits need their parent issue for a title and a link target.
    // Scoped by board_id for the same reason as above: a comment whose
    // issue is not on this board resolves to nothing and drops out below.
    const parentIds = [...new Set(commentHits.map((h) => h.issue_id))];
    const parents = new Map<string, { title: string; short_id: string | null }>();
    if (parentIds.length > 0) {
      const rows = yield* db.queryAll<{ id: string; title: string; short_id: string | null }>(
        `SELECT id, title, short_id FROM issueCache WHERE board_id = ? AND id IN (${parentIds.map(() => "?").join(", ")})`,
        [board.id, ...parentIds],
      );
      for (const row of rows) parents.set(row.id, { title: row.title, short_id: row.short_id });
    }

    // Rank order is preserved by mapping over the hit list, not the
    // hydrated rows — `IN (...)` returns no meaningful order. A hit whose
    // source row is gone (deleted between the two reads) drops out.
    return {
      issues: issueHits.flatMap((h): IssueHit[] => {
        const issue = issues.get(h.id);
        return issue === undefined ? [] : [{ issue, rank: h.rank }];
      }),
      comments: commentHits.flatMap((h): CommentHit[] => {
        const comment = comments.get(h.id);
        if (comment === undefined) return [];
        const parent = parents.get(h.issue_id);
        if (parent === undefined) return [];
        return [
          {
            comment,
            issue_id: h.issue_id,
            issue_title: parent.title,
            issue_short_id: parent.short_id,
            rank: h.rank,
          },
        ];
      }),
    };
  });
