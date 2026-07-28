// /api/v0 feed — the board activity feed (reads over statusChangeCache, the
// audit rows every mutation writes) plus the per-board SSE stream proxied
// from the BoardDO fanout.
//
// A statusChange row's kind is inferred from which nullable pair is set —
// see PLAN.md "Activity feed semantics" for the discriminator table.
// Newest-first keyset pagination on (occurred_at_ms, id), cursor anchored on
// a statusChange id. Issue titles are merged in from a second D1 read (no
// SQL JOIN): audit rows outlive their issue, so a deleted issue reads back
// with issue_title null.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Data, Effect, Exit, Option } from "effect";
import { Db, DbError, bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { assertOwnBoard, callerPubkey, type BoardOwnershipError } from "../authz";
import { parseStatusChangeRow, type StatusChangeShape } from "../shapes";
import { SSE_HEADERS } from "../durable-objects/BoardDO";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

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
  readonly actor_pubkey: string;
  readonly kind: FeedKind;
  readonly from: string | null;
  readonly to: string | null;
  readonly occurred_at_ms: number;
}

const toFeedItem = (s: StatusChangeShape, issue_title: string | null): FeedItem => {
  const kind = kindOf(s);
  return {
    id: s.id,
    issue_id: s.issue_id,
    issue_title,
    actor_pubkey: s.actor_pubkey,
    kind,
    from: kind === "container" ? s.from_container : s.from_status,
    to: kind === "container" ? s.to_container : s.to_status,
    occurred_at_ms: s.occurred_at_ms,
  };
};

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}

type FeedFailure = ValidationError | BoardOwnershipError | DbError;

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<FeedFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "BoardOwnershipError":
        return c.json({ error: "not-found", reason: f.reason }, 404);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

export const makeFeedRouter = (layerFor: LayerFor = bootstrap) => {
  const feed = new Hono<AppHonoEnv>();

  const runExit = async <A>(
    c: Context<AppHonoEnv>,
    program: Effect.Effect<A, FeedFailure, Db>,
  ) => Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));

  // ── GET /boards/:slug/activity — newest-first feed with keyset ──────────
  feed.get("/boards/:slug/activity", async (c) => {
    const claims = c.get("claims");
    const type = c.req.query("type");
    const limitRaw = c.req.query("limit");
    const after = c.req.query("after");

    const program = Effect.gen(function* () {
      const board = yield* assertOwnBoard(c.req.param("slug"), callerPubkey(claims));

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

      // Enrich with issue titles in code — deleted issues resolve to null.
      const issueIds = [...new Set(changes.map((s) => s.issue_id))];
      const titles = new Map<string, string>();
      if (issueIds.length > 0) {
        const placeholders = issueIds.map(() => "?").join(", ");
        const titleRows = yield* db.queryAll<{ id: string; title: string }>(
          `SELECT id, title FROM issueCache WHERE id IN (${placeholders})`,
          issueIds,
        );
        for (const t of titleRows) titles.set(t.id, t.title);
      }

      return {
        activity: changes.map((s) => toFeedItem(s, titles.get(s.issue_id) ?? null)),
        has_more: rows.length > limit,
      };
    });

    const exit = await runExit(c, program);
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── GET /boards/:slug/stream — SSE, proxied from the board's DO ─────────
  feed.get("/boards/:slug/stream", async (c) => {
    const claims = c.get("claims");
    const exit = await runExit(
      c,
      assertOwnBoard(c.req.param("slug"), callerPubkey(claims)),
    );
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);

    const ns = c.env.BOARD;
    if (ns === undefined) return c.json({ error: "internal", reason: "no-board-binding" }, 500);
    const stub = ns.get(ns.idFromName(exit.value.id));
    const doResponse = await stub.fetch("https://board-do/subscribe");
    return new Response(doResponse.body, { status: doResponse.status, headers: SSE_HEADERS });
  });

  return feed;
};
