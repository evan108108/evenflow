/**
 * Feed actions — the board activity feed (reads over statusChangeCache, the
 * audit rows every mutation writes).
 *
 * A statusChange row's kind is inferred from which nullable pair is set — see
 * PLAN.md "Activity feed semantics" for the discriminator table. Newest-first
 * keyset pagination on (occurred_at_ms, id), cursor anchored on a statusChange
 * id. Issue titles are merged in from a second D1 read (no SQL JOIN): audit
 * rows outlive their issue, so a deleted issue reads back with issue_title
 * null.
 *
 * EFB-98: bodies moved VERBATIM from src/routes/feed.ts.
 *
 * ORDER IS LOAD-BEARING HERE TOO, in the query direction rather than the body
 * direction. Both feeds authorize BEFORE they validate `type` and `limit`, so
 * a bad `?limit=0` against a board the caller cannot see answers 404, not 400
 * — the board's existence is not disclosed by the shape of the complaint. The
 * statements below are in the pre-split order for that reason.
 *
 * The SSE stream route keeps only its authorization here. Its response is a
 * piped `Response` from the board's Durable Object, which cannot go through
 * `runJson` — that ends in `c.json` — so the proxy stays in the route.
 */

import { Effect } from "effect";

import { Db, DbError } from "../effects";
import {
  ForbiddenError,
  UnauthorizedError,
  authorizeBoardById,
  callerPubkeyOrNull,
  notVisible,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { parseIssueRow, parseStatusChangeRow, type BoardShape, type StatusChangeShape } from "../shapes";
import { asShortId } from "../slug";
import { NotFoundError, ValidationError } from "../lib/errors";
import type { PublicActionInput } from "./types";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const ISSUE_ACTIVITY_DEFAULT_LIMIT = 10;
const ISSUE_ACTIVITY_MAX_LIMIT = 50;

const FEED_KINDS = ["creation", "status", "container"] as const;
type FeedKind = (typeof FEED_KINDS)[number];

// SQL predicates mirroring kindOf — creation rows carry both "to" sides,
// status rows only to_status, container rows only to_container.
const KIND_SQL: Record<FeedKind, string> = {
  creation: " AND to_status IS NOT NULL AND to_container IS NOT NULL",
  status: " AND to_status IS NOT NULL AND to_container IS NULL",
  container: " AND to_status IS NULL",
};

const kindOf = (s: StatusChangeShape): FeedKind => {
  if (s.to_status !== null && s.to_container !== null) return "creation";
  if (s.to_status !== null) return "status";
  return "container";
};

interface FeedItem {
  readonly id: string;
  readonly issue_id: string;
  readonly issue_title: string | null;
  readonly issue_short_id: string | null;
  readonly actor_pubkey: string;
  readonly kind: FeedKind;
  readonly from: string | null;
  readonly to: string | null;
  // Set when this row is a move to Done — velocity math counts only
  // completions whose container was "active" (PLAN.md, estimation section).
  readonly container_at_completion: string | null;
  readonly occurred_at_ms: number;
}

const toFeedItem = (
  s: StatusChangeShape,
  issue_title: string | null,
  issue_short_id: string | null,
): FeedItem => {
  const kind = kindOf(s);
  return {
    id: s.id,
    issue_id: s.issue_id,
    issue_title,
    issue_short_id,
    actor_pubkey: s.actor_pubkey,
    kind,
    from: kind === "container" ? s.from_container : s.from_status,
    to: kind === "container" ? s.to_container : s.to_status,
    container_at_completion: s.container_at_completion,
    occurred_at_ms: s.occurred_at_ms,
  };
};

export type FeedFailure =
  | ValidationError
  | NotFoundError
  | BoardOwnershipError
  | UnauthorizedError
  | ForbiddenError
  | DbError;

/** Services every feed action needs. */
export type FeedServices = Db;

/** The caller's pubkey, or null — every feed read is anonymous-tolerant. */
const pubkeyOf = (input: PublicActionInput) =>
  callerPubkeyOrNull(input.claims ?? undefined);

/** GET /boards/:slug/activity — newest-first feed with keyset. */
export const boardActivity = (
  input: PublicActionInput,
): Effect.Effect<unknown, FeedFailure, FeedServices> =>
  Effect.gen(function* () {
    const type = input.query["type"];
    const limitRaw = input.query["limit"];
    const after = input.query["after"];

    const { board } = yield* resolveBoardScope(
      { org_slug: input.orgSlug ?? undefined, slug: input.params["slug"] ?? "" },
      pubkeyOf(input),
      "viewer", input.grants,);

    let kindSql = "";
    if (type !== undefined) {
      if (!(FEED_KINDS as ReadonlyArray<string>).includes(type)) {
        return yield* new ValidationError({ reason: "type" });
      }
      kindSql = KIND_SQL[type as FeedKind];
    }

    let limit = DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1) return yield* new ValidationError({ reason: "limit" });
      limit = Math.min(n, MAX_LIMIT);
    }

    const db = yield* Db;
    let cursorSql = "";
    const cursorParams: unknown[] = [];
    if (after !== undefined) {
      const anchor = yield* db.queryFirst<Record<string, unknown>>(
        "SELECT * FROM statusChangeCache WHERE board_id = ? AND id = ?",
        [board.id, after],
      );
      if (anchor === null) return yield* new ValidationError({ reason: "after" });
      cursorSql = " AND (occurred_at_ms < ? OR (occurred_at_ms = ? AND id < ?))";
      cursorParams.push(anchor["occurred_at_ms"], anchor["occurred_at_ms"], after);
    }

    // limit+1 probe answers has_more without a count query.
    const rows = yield* db.queryAll(
      `SELECT * FROM statusChangeCache WHERE board_id = ?${kindSql}${cursorSql} ORDER BY occurred_at_ms DESC, id DESC LIMIT ?`,
      [board.id, ...cursorParams, limit + 1],
    );
    const changes = rows.slice(0, limit).map(parseStatusChangeRow);

    // Enrich with issue titles + short ids in code — deleted issues
    // resolve to null on both.
    const issueIds = [...new Set(changes.map((s) => s.issue_id))];
    const refs = new Map<string, { title: string; short_id: string | null }>();
    if (issueIds.length > 0) {
      const placeholders = issueIds.map(() => "?").join(", ");
      const refRows = yield* db.queryAll<{ id: string; title: string; short_id: string | null }>(
        `SELECT id, title, short_id FROM issueCache WHERE id IN (${placeholders})`,
        issueIds,
      );
      for (const t of refRows) refs.set(t.id, { title: t.title, short_id: t.short_id });
    }

    return {
      activity: changes.map((s) => {
        const ref = refs.get(s.issue_id);
        return toFeedItem(s, ref?.title ?? null, ref?.short_id ?? null);
      }),
      has_more: rows.length > limit,
    };
  });

/** GET /issues/:id/activity — one issue's recent audit rows. */
export const issueActivity = (
  input: PublicActionInput,
): Effect.Effect<unknown, FeedFailure, FeedServices> =>
  Effect.gen(function* () {
    const limitRaw = input.query["limit"];

    const db = yield* Db;
    const ref = input.params["id"] ?? "";
    const pubkey = pubkeyOf(input);
    const shortId = asShortId(ref);
    const issueRow =
      shortId === null
        ? yield* db.queryFirst("SELECT * FROM issueCache WHERE id = ?", [ref])
        : yield* db.queryFirst("SELECT * FROM issueCache WHERE short_id = ?", [shortId]);
    if (issueRow === null) return yield* notVisible(pubkey, new NotFoundError({ reason: "issue" }));
    const issue = parseIssueRow(issueRow);
    // Same non-leaking posture as issues.ts: for an authenticated caller a
    // missing issue and an invisible board are indistinguishable (404
    // "issue"); for an anonymous one both are 401 (EFB-76).
    yield* authorizeBoardById(issue.board_id, pubkey, "viewer", input.grants).pipe(
      Effect.mapError((e) =>
        e._tag === "BoardOwnershipError" ? new NotFoundError({ reason: "issue" }) : e,
      ),
    );

    let limit = ISSUE_ACTIVITY_DEFAULT_LIMIT;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isInteger(n) || n < 1) return yield* new ValidationError({ reason: "limit" });
      limit = Math.min(n, ISSUE_ACTIVITY_MAX_LIMIT);
    }

    const rows = yield* db.queryAll(
      "SELECT * FROM statusChangeCache WHERE issue_id = ? ORDER BY occurred_at_ms DESC, id DESC LIMIT ?",
      [issue.id, limit + 1],
    );
    const changes = rows.slice(0, limit).map(parseStatusChangeRow);
    return {
      activity: changes.map((s) => toFeedItem(s, issue.title, issue.short_id)),
      has_more: rows.length > limit,
    };
  });

/**
 * GET /boards/:slug/stream — the authorization half only.
 *
 * The route pipes the board's Durable Object SSE response through untouched,
 * which is transport that cannot be expressed as a JSON action. What IS
 * business logic is the question this answers: may this caller subscribe to
 * this board? Returning the board rather than void is what lets the route
 * address the right DO without resolving the scope a second time.
 */
export const authorizeBoardStream = (
  input: PublicActionInput,
): Effect.Effect<{ board: BoardShape }, FeedFailure, FeedServices> =>
  Effect.gen(function* () {
    const { board } = yield* resolveBoardScope(
      { org_slug: input.orgSlug ?? undefined, slug: input.params["slug"] ?? "" },
      pubkeyOf(input),
      "viewer", input.grants,);
    return { board };
  });
