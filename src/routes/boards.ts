// /api/v0/boards — board CRUD against the D1 boardCache.
//
// MVP phase: handlers write boardCache directly. The 4a event-publish side
// (kind 30550 fa:KanbanBoard) lands in a later "event publisher" phase —
// cache-side first so the read/write path is testable end-to-end before we
// couple to the substrate. Two consequences, both temporary:
//   * id is a generated uuid, not a 4a event id. The publisher phase will
//     mint real event ids.
//   * TODO(kms-backfill): pubkey is "<provider>:<oauth_id>" — the same
//     tuple KMS derives real pubkeys from — NOT a Nostr pubkey. When
//     KmsClient.Live lands, derive here and backfill existing rows.
//
// Auth: mounted under /api/v0 in index.ts, which already applies
// requireAuth() to /api/v0/* — handlers can read c.get("claims") directly.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { AuditLog, Db, DbError, bootstrap, type Claims } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { parseBoardRow, type BoardShape } from "../shapes";

const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MEMBER_POLICIES = ["open", "invite"] as const;
const DEFAULT_COLUMNS = ["Backlog", "Todo", "In Progress", "In Review", "Done"];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly reason: string;
}> {}
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}

type BoardsFailure = ValidationError | ConflictError | NotFoundError | DbError;

// TODO(kms-backfill): provider-qualified stand-in, not a Nostr pubkey (see
// header comment). Provider-qualified — bare oauth_id would collide across
// providers ("123" on Google vs GitHub).
const callerPubkey = (claims: Claims): string => `${claims.provider}:${claims.oauth_id}`;

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<BoardsFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "ConflictError":
        return c.json({ error: "conflict", reason: f.reason }, 409);
      case "NotFoundError":
        return c.json({ error: "not-found", reason: f.reason }, 404);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

// ── field validators — each returns the parsed value or fails typed ───────

const validateTitle = (v: unknown) =>
  typeof v === "string" && v.trim() !== ""
    ? Effect.succeed(v)
    : Effect.fail(new ValidationError({ reason: "title" }));

const validateDescription = (v: unknown) =>
  v === null || typeof v === "string"
    ? Effect.succeed(v as string | null)
    : Effect.fail(new ValidationError({ reason: "description" }));

const validateColumns = (v: unknown) =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim() !== "")
    ? Effect.succeed(v as string[])
    : Effect.fail(new ValidationError({ reason: "columns" }));

const validateLabels = (v: unknown) =>
  Array.isArray(v)
    ? Effect.succeed(v as unknown[])
    : Effect.fail(new ValidationError({ reason: "labels" }));

const validateMemberPolicy = (v: unknown) =>
  typeof v === "string" && (MEMBER_POLICIES as ReadonlyArray<string>).includes(v)
    ? Effect.succeed(v)
    : Effect.fail(new ValidationError({ reason: "member_policy" }));

const readJsonBody = (c: Context<AppHonoEnv>) =>
  Effect.tryPromise({
    try: () => c.req.json() as Promise<Record<string, unknown>>,
    catch: () => new ValidationError({ reason: "expected-json" }),
  }).pipe(
    Effect.filterOrFail(
      (b): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b),
      () => new ValidationError({ reason: "expected-json-object" }),
    ),
  );

const fetchOwnBoardRow = (pubkey: string, slug: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst(
      "SELECT * FROM boardCache WHERE pubkey = ? AND slug = ?",
      [pubkey, slug],
    );
    if (row === null) return yield* new NotFoundError({ reason: "board" });
    return row;
  });

export const makeBoardsRouter = (layerFor: LayerFor = bootstrap) => {
  const boards = new Hono<AppHonoEnv>();

  // ── POST /boards — create ───────────────────────────────────────────────
  boards.post("/boards", async (c) => {
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const body = yield* readJsonBody(c);

      const slug = body["slug"];
      if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
        return yield* new ValidationError({ reason: "slug" });
      }
      const title = yield* validateTitle(body["title"]);
      const description =
        body["description"] === undefined ? null : yield* validateDescription(body["description"]);
      const columns =
        body["columns"] === undefined ? DEFAULT_COLUMNS : yield* validateColumns(body["columns"]);
      const labels =
        body["labels"] === undefined ? [] : yield* validateLabels(body["labels"]);
      const member_policy =
        body["member_policy"] === undefined
          ? "invite"
          : yield* validateMemberPolicy(body["member_policy"]);

      const db = yield* Db;
      const audit = yield* AuditLog;
      const pubkey = callerPubkey(claims);

      const existing = yield* db.queryFirst(
        "SELECT id FROM boardCache WHERE pubkey = ? AND slug = ?",
        [pubkey, slug],
      );
      if (existing !== null) return yield* new ConflictError({ reason: "slug-in-use" });

      const now = yield* Clock.currentTimeMillis;
      const id = crypto.randomUUID();
      const board: BoardShape = {
        id,
        pubkey,
        slug,
        title,
        description,
        columns,
        labels,
        member_policy,
        is_encrypted: false,
        created_at_ms: now,
        updated_at_ms: now,
      };
      yield* db.execute(
        "INSERT INTO boardCache (id, pubkey, slug, title, description, columns, labels, member_policy, is_encrypted, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          pubkey,
          slug,
          title,
          description === null ? null : JSON.stringify(description),
          JSON.stringify(columns),
          JSON.stringify(labels),
          member_policy,
          0,
          now,
          now,
        ],
      );
      yield* audit.record({
        event_type: "board_created",
        actor: claims.login,
        details: { slug },
      });
      return board;
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json({ board: exit.value }, 201);
  });

  // ── GET /boards — list caller's boards, newest-updated first ────────────
  boards.get("/boards", async (c) => {
    const claims = c.get("claims");
    const limitRaw = c.req.query("limit");
    const after = c.req.query("after");

    const program = Effect.gen(function* () {
      let limit = DEFAULT_LIMIT;
      if (limitRaw !== undefined) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n < 1) return yield* new ValidationError({ reason: "limit" });
        limit = Math.min(n, MAX_LIMIT);
      }

      const db = yield* Db;
      const pubkey = callerPubkey(claims);

      let rows: ReadonlyArray<unknown>;
      if (after !== undefined) {
        const anchor = yield* db.queryFirst<Record<string, unknown>>(
          "SELECT * FROM boardCache WHERE pubkey = ? AND id = ?",
          [pubkey, after],
        );
        if (anchor === null) return yield* new ValidationError({ reason: "after" });
        rows = yield* db.queryAll(
          "SELECT * FROM boardCache WHERE pubkey = ? AND (updated_at_ms < ? OR (updated_at_ms = ? AND id < ?)) ORDER BY updated_at_ms DESC, id DESC LIMIT ?",
          [pubkey, anchor["updated_at_ms"], anchor["updated_at_ms"], after, limit],
        );
      } else {
        rows = yield* db.queryAll(
          "SELECT * FROM boardCache WHERE pubkey = ? ORDER BY updated_at_ms DESC, id DESC LIMIT ?",
          [pubkey, limit],
        );
      }

      const count = yield* db.queryFirst<{ n: number }>(
        "SELECT COUNT(*) AS n FROM boardCache WHERE pubkey = ?",
        [pubkey],
      );
      return { boards: rows.map(parseBoardRow), total: count?.n ?? 0 };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── GET /boards/:slug — fetch one of the caller's boards ────────────────
  boards.get("/boards/:slug", async (c) => {
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const row = yield* fetchOwnBoardRow(callerPubkey(claims), c.req.param("slug"));
      return { board: parseBoardRow(row) };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── PATCH /boards/:slug — partial update of mutable fields ──────────────
  boards.patch("/boards/:slug", async (c) => {
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const body = yield* readJsonBody(c);
      for (const immutable of ["slug", "pubkey", "id", "is_encrypted"]) {
        if (body[immutable] !== undefined) {
          return yield* new ValidationError({ reason: `${immutable}-immutable` });
        }
      }
      const hasPatch = ["title", "description", "columns", "labels", "member_policy"].some(
        (k) => body[k] !== undefined,
      );
      if (!hasPatch) return yield* new ValidationError({ reason: "empty-patch" });

      const current = parseBoardRow(
        yield* fetchOwnBoardRow(callerPubkey(claims), c.req.param("slug")),
      );

      const title = body["title"] === undefined ? current.title : yield* validateTitle(body["title"]);
      const description =
        body["description"] === undefined
          ? current.description
          : yield* validateDescription(body["description"]);
      const columns =
        body["columns"] === undefined ? current.columns : yield* validateColumns(body["columns"]);
      const labels =
        body["labels"] === undefined ? current.labels : yield* validateLabels(body["labels"]);
      const member_policy =
        body["member_policy"] === undefined
          ? current.member_policy
          : yield* validateMemberPolicy(body["member_policy"]);

      const db = yield* Db;
      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      yield* db.execute(
        "UPDATE boardCache SET title = ?, description = ?, columns = ?, labels = ?, member_policy = ?, updated_at_ms = ? WHERE id = ?",
        [
          title,
          description === null ? null : JSON.stringify(description),
          JSON.stringify(columns),
          JSON.stringify(labels),
          member_policy,
          now,
          current.id,
        ],
      );
      yield* audit.record({
        event_type: "board_updated",
        actor: claims.login,
        details: { slug: current.slug },
      });
      const board: BoardShape = {
        ...current,
        title,
        description,
        columns,
        labels,
        member_policy,
        updated_at_ms: now,
      };
      return { board };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── DELETE /boards/:slug — remove the caller's board ────────────────────
  // Deliberately does NOT cascade to issueCache (soft FKs): issues orphan;
  // a v2 cleanup path reaps them.
  boards.delete("/boards/:slug", async (c) => {
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const current = parseBoardRow(
        yield* fetchOwnBoardRow(callerPubkey(claims), c.req.param("slug")),
      );
      const db = yield* Db;
      const audit = yield* AuditLog;
      yield* db.execute("DELETE FROM boardCache WHERE id = ?", [current.id]);
      yield* audit.record({
        event_type: "board_deleted",
        actor: claims.login,
        details: { slug: current.slug },
      });
      return { deleted: true };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  return boards;
};
