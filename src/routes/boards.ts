// /api/v0/boards — board CRUD against the D1 boardCache, org-scoped since
// phase 16.
//
// Mounted twice by index.ts: at /api/v0 (legacy compat — no org_slug param,
// boards resolve against the caller's own/visible set) and at
// /api/v0/orgs/:org_slug (canonical — boards resolve inside that org).
// Handlers branch on the presence of the org_slug param.
//
// MVP posture unchanged: handlers write boardCache directly; the kind-30550
// board event publish lands in the event-publisher phase (uuid ids, and
// TODO(kms-backfill): pubkey is the "<provider>:<oauth_id>" stand-in).
// TODO(board-audience-republish): the visibility toggle should republish
// the board's audience event once board events publish at all.
//
// Auth: /api/v0/* runs behind optionalAuth — reads allow anonymous on
// public boards; every mutation calls requireCaller first.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { AuditLog, Audience, Db, DbError, bootstrap } from "../effects";
import { AudienceKeyError, initializeBoardAudience } from "../audiences";
import type { AppHonoEnv, LayerFor } from "../http";
import {
  ForbiddenError,
  UnauthorizedError,
  authorizeOrgAccess,
  callerPubkey,
  callerPubkeyOrNull,
  requireCaller,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { ensurePersonalOrg, upsertMembership } from "../membership";
import { parseBoardRow, type BoardShape, type OrgShape } from "../shapes";
import { PREFIX_RE, derivePrefix, uniquePrefix } from "../slug";
import { VISIBILITIES } from "../roles";
import {
  coerceStringColumns,
  columnArrayProblem,
  columnById,
  defaultColumns,
  type Column,
} from "../columns";

const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MEMBER_POLICIES = ["open", "invite"] as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_SPRINT_DAYS = 14;
const MIN_SPRINT_DAYS = 1;
const MAX_SPRINT_DAYS = 90;

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly reason: string;
}> {}
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly reason: string;
}> {}

type BoardsFailure =
  | ValidationError
  | ConflictError
  | NotFoundError
  | BoardOwnershipError
  | UnauthorizedError
  | ForbiddenError
  | DbError;

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<BoardsFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "UnauthorizedError":
        return c.json({ error: "unauthorized", reason: f.reason }, 401);
      case "ForbiddenError":
        return c.json({ error: "forbidden", reason: f.reason }, 403);
      case "NotFoundError":
      case "BoardOwnershipError":
        return c.json({ error: "not-found", reason: f.reason }, 404);
      case "ConflictError":
        return c.json({ error: "conflict", reason: f.reason }, 409);
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

// Status columns are lifecycle only (Todo → In Progress → In Review →
// Done). "Backlog" is intentionally NOT a status — it lives on the
// CONTAINER axis (icebox / backlog / active), a separate dimension. See
// PLAN.md "Icebox, Backlog, Active — two orthogonal dimensions".
//
// Since phase 17, columns are structured (Column[]); a bare string[] is
// still accepted from older clients and coerced with inferred categories.
const validateColumns = (v: unknown): Effect.Effect<Column[], ValidationError> => {
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) {
    return v.every((x) => (x as string).trim() !== "" && (x as string).length <= 30)
      ? Effect.succeed(coerceStringColumns(v as string[], () => crypto.randomUUID()))
      : Effect.fail(new ValidationError({ reason: "columns" }));
  }
  const problem = columnArrayProblem(v);
  return problem === null
    ? Effect.succeed(v as Column[])
    : Effect.fail(new ValidationError({ reason: `columns-${problem}` }));
};

const validateLabels = (v: unknown) =>
  Array.isArray(v)
    ? Effect.succeed(v as unknown[])
    : Effect.fail(new ValidationError({ reason: "labels" }));

const validateMemberPolicy = (v: unknown) =>
  typeof v === "string" && (MEMBER_POLICIES as ReadonlyArray<string>).includes(v)
    ? Effect.succeed(v)
    : Effect.fail(new ValidationError({ reason: "member_policy" }));

const validateVisibility = (v: unknown) =>
  typeof v === "string" && (VISIBILITIES as ReadonlyArray<string>).includes(v)
    ? Effect.succeed(v as (typeof VISIBILITIES)[number])
    : Effect.fail(new ValidationError({ reason: "visibility" }));

const validateSprintDays = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= MIN_SPRINT_DAYS && v <= MAX_SPRINT_DAYS
    ? Effect.succeed(v)
    : Effect.fail(new ValidationError({ reason: "default_sprint_days" }));

const validatePrefix = (v: unknown) =>
  typeof v === "string" && PREFIX_RE.test(v.toUpperCase())
    ? Effect.succeed(v.toUpperCase())
    : Effect.fail(new ValidationError({ reason: "issue_prefix" }));

/**
 * Resolve the requested (or title-derived) prefix against every prefix
 * already in use — global scope, because short_ids are globally unique.
 * A conflict auto-suffixes (FLOW → FLOW2) rather than failing; the caller
 * reads the finalized value off the response.
 */
const finalizePrefix = (requested: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db.queryAll<{ issue_prefix: string }>(
      "SELECT issue_prefix FROM boardCache WHERE issue_prefix IS NOT NULL",
    );
    return uniquePrefix(requested, new Set(rows.map((r) => r.issue_prefix)));
  });

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

/** The org fields riding along on board responses since phase 16. */
const orgView = (org: OrgShape | null) =>
  org === null
    ? null
    : { slug: org.slug, display_name: org.display_name, avatar_url: org.avatar_url, kind: org.kind };

export const makeBoardsRouter = (layerFor: LayerFor = bootstrap) => {
  const boards = new Hono<AppHonoEnv>();

  // ── POST /boards — create (in :org_slug when present, else personal) ────
  boards.post("/boards", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);

      const slug = body["slug"];
      if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
        return yield* new ValidationError({ reason: "slug" });
      }
      const title = yield* validateTitle(body["title"]);
      const description =
        body["description"] === undefined ? null : yield* validateDescription(body["description"]);
      const columns =
        body["columns"] === undefined
          ? defaultColumns(() => crypto.randomUUID())
          : yield* validateColumns(body["columns"]);
      const labels =
        body["labels"] === undefined ? [] : yield* validateLabels(body["labels"]);
      const member_policy =
        body["member_policy"] === undefined
          ? "invite"
          : yield* validateMemberPolicy(body["member_policy"]);
      const derived =
        body["issue_prefix"] === undefined
          ? derivePrefix(title)
          : null;
      if (derived === "") {
        return yield* new ValidationError({ reason: "issue_prefix" });
      }
      const requestedPrefix =
        derived !== null
          ? derived
          : yield* validatePrefix(body["issue_prefix"] as string);

      // Target org: the mounted org (must administer it) or the caller's
      // personal org (auto-created — bootstrap may not have run yet).
      const orgSlugParam = c.req.param("org_slug");
      let org: OrgShape;
      if (orgSlugParam !== undefined) {
        const authorized = yield* authorizeOrgAccess(orgSlugParam, pubkey, "admin");
        org = authorized.org;
      } else {
        const ensured = yield* ensurePersonalOrg(claims, token);
        org = ensured.org;
      }

      const db = yield* Db;
      const audit = yield* AuditLog;

      // Board slugs are unique per org since phase 16.
      const existing = yield* db.queryFirst(
        "SELECT id FROM boardCache WHERE org_id = ? AND slug = ?",
        [org.id, slug],
      );
      if (existing !== null) return yield* new ConflictError({ reason: "slug-in-use" });

      const issue_prefix = yield* finalizePrefix(requestedPrefix);
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
        audience_epoch: 1,
        audience_pubkey: null,
        issue_prefix,
        next_issue_number: 1,
        org_id: org.id,
        visibility: "private",
        default_sprint_days: DEFAULT_SPRINT_DAYS,
        archived_at_ms: null,
        created_at_ms: now,
        updated_at_ms: now,
      };
      yield* db.execute(
        "INSERT INTO boardCache (id, pubkey, slug, title, description, columns, labels, member_policy, is_encrypted, issue_prefix, next_issue_number, org_id, visibility, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          issue_prefix,
          1,
          org.id,
          "private",
          now,
          now,
        ],
      );
      yield* upsertMembership({
        table: "boardMemberCache",
        scopeId: id,
        pubkey,
        role: "admin",
        addedBy: pubkey,
        token,
        grant: { scope: "board", target: `${org.slug}/${slug}` },
      });
      yield* audit.record({
        event_type: "board_created",
        actor: claims.login,
        details: { slug, org_slug: org.slug },
      });
      return { board, org: orgView(org) };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, 201);
  });

  // ── GET /boards — every board the caller can see, newest-updated first ──
  // (Org-scoped listing lives on the orgs router: GET /orgs/:slug/boards.)
  boards.get("/boards", async (c) => {
    const limitRaw = c.req.query("limit");
    const after = c.req.query("after");
    const includeArchived = c.req.query("include_archived") === "1";

    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      let limit = DEFAULT_LIMIT;
      if (limitRaw !== undefined) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n < 1) return yield* new ValidationError({ reason: "limit" });
        limit = Math.min(n, MAX_LIMIT);
      }

      const db = yield* Db;

      // Visible = member of the board's org ∪ explicit board grant ∪ created
      // (pre-backfill compat). Positional params, so pubkey binds three
      // times per use of the predicate.
      const VISIBLE_PREDICATE =
        "(boardCache.org_id IN (SELECT org_id FROM orgMemberCache WHERE pubkey = ?) OR boardCache.id IN (SELECT board_id FROM boardMemberCache WHERE pubkey = ?) OR boardCache.pubkey = ?)" +
        (includeArchived ? "" : " AND archived_at_ms IS NULL");
      const visibleParams = [pubkey, pubkey, pubkey];

      let rows: ReadonlyArray<unknown>;
      if (after !== undefined) {
        const anchor = yield* db.queryFirst<Record<string, unknown>>(
          `SELECT * FROM boardCache WHERE ${VISIBLE_PREDICATE} AND id = ?`,
          [...visibleParams, after],
        );
        if (anchor === null) return yield* new ValidationError({ reason: "after" });
        rows = yield* db.queryAll(
          `SELECT * FROM boardCache WHERE ${VISIBLE_PREDICATE} AND (updated_at_ms < ? OR (updated_at_ms = ? AND id < ?)) ORDER BY updated_at_ms DESC, id DESC LIMIT ?`,
          [...visibleParams, anchor["updated_at_ms"], anchor["updated_at_ms"], after, limit],
        );
      } else {
        rows = yield* db.queryAll(
          `SELECT * FROM boardCache WHERE ${VISIBLE_PREDICATE} ORDER BY updated_at_ms DESC, id DESC LIMIT ?`,
          [...visibleParams, limit],
        );
      }

      const count = yield* db.queryFirst<{ n: number }>(
        `SELECT COUNT(*) AS n FROM boardCache WHERE ${VISIBLE_PREDICATE}`,
        visibleParams,
      );

      // Org chips for grouping in the /boards aggregate view.
      const orgRows = yield* db.queryAll<{
        id: string;
        slug: string;
        display_name: string;
        kind: string;
      }>(
        "SELECT id, slug, display_name, kind FROM orgCache WHERE deleted_at_ms IS NULL AND id IN (SELECT org_id FROM orgMemberCache WHERE pubkey = ? UNION SELECT org_id FROM boardCache WHERE id IN (SELECT board_id FROM boardMemberCache WHERE pubkey = ?))",
        [pubkey, pubkey],
      );
      const orgById = new Map(orgRows.map((o) => [o.id, o]));

      const boardsOut = rows.map(parseBoardRow).map((b) => {
        const org = b.org_id === null ? undefined : orgById.get(b.org_id);
        return {
          ...b,
          org_slug: org?.slug ?? null,
          org_display_name: org?.display_name ?? null,
          org_kind: org?.kind ?? null,
        };
      });
      return { boards: boardsOut, total: count?.n ?? 0 };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── GET /boards/:slug — fetch one visible board ─────────────────────────
  boards.get("/boards/:slug", async (c) => {
    const program = Effect.gen(function* () {
      const pubkey = callerPubkeyOrNull(c.get("claims"));
      const { board, org, role } = yield* resolveBoardScope(
        { org_slug: c.req.param("org_slug"), slug: c.req.param("slug") },
        pubkey,
        "viewer",
      );
      return { board, org: orgView(org), role };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── PATCH /boards/:slug — partial update of mutable fields (admin) ──────
  boards.patch("/boards/:slug", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* readJsonBody(c);
      for (const immutable of ["slug", "pubkey", "id", "org_id", "audience_epoch", "audience_pubkey"]) {
        if (body[immutable] !== undefined) {
          return yield* new ValidationError({ reason: `${immutable}-immutable` });
        }
      }
      const hasPatch = [
        "title",
        "description",
        "columns",
        "labels",
        "member_policy",
        "issue_prefix",
        "visibility",
        "default_sprint_days",
        "is_encrypted",
      ].some((k) => body[k] !== undefined);
      if (!hasPatch) return yield* new ValidationError({ reason: "empty-patch" });

      const { board: current } = yield* resolveBoardScope(
        { org_slug: c.req.param("org_slug"), slug: c.req.param("slug") },
        callerPubkey(claims),
        "admin",
      );

      // Renaming a prefix would orphan every FLOW-n URL and reference
      // already minted, so it is only editable while no issue exists yet.
      let issue_prefix = current.issue_prefix;
      if (body["issue_prefix"] !== undefined) {
        if (current.next_issue_number !== 1) {
          return yield* new ConflictError({
            reason: "prefix-locked-issues-exist",
          });
        }
        const requested = yield* validatePrefix(body["issue_prefix"]);
        issue_prefix =
          requested === current.issue_prefix ? requested : yield* finalizePrefix(requested);
      }

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
      const visibility =
        body["visibility"] === undefined
          ? current.visibility
          : yield* validateVisibility(body["visibility"]);
      const default_sprint_days =
        body["default_sprint_days"] === undefined
          ? current.default_sprint_days
          : yield* validateSprintDays(body["default_sprint_days"]);

      // One-way privacy flip (phase 16.5). false→true mints the board's 4a
      // audience below; true→false is a v1 409 (unwrap-and-clear is future
      // work); an encrypted board can never be publicly visible.
      let flipToPrivate = false;
      if (body["is_encrypted"] !== undefined) {
        if (typeof body["is_encrypted"] !== "boolean") {
          return yield* new ValidationError({ reason: "is_encrypted" });
        }
        if (body["is_encrypted"] === false && current.is_encrypted) {
          return yield* new ConflictError({ reason: "unsupported-private-to-public" });
        }
        flipToPrivate = body["is_encrypted"] && !current.is_encrypted;
      }
      if ((current.is_encrypted || flipToPrivate) && visibility === "public") {
        return yield* new ConflictError({ reason: "encrypted-board-must-stay-private" });
      }
      if (flipToPrivate) {
        // The flip itself is owner-only (the rest of the PATCH stays admin).
        yield* resolveBoardScope(
          { org_slug: c.req.param("org_slug"), slug: c.req.param("slug") },
          callerPubkey(claims),
          "owner",
        );
        const audienceSvc = yield* Audience;
        if (audienceSvc.serverKeys() === null) {
          return yield* new ConflictError({ reason: "audience-not-configured" });
        }
      }

      const db = yield* Db;

      // Column-set changes: a deleted column must not strand its issues. A
      // removed id that still has issues requires a column_move_map entry
      // pointing at a surviving ENABLED column (the alternative — hiding —
      // is just enabled:false, which isn't a removal). Renames re-point the
      // status name mirror; column_id rows never move on a rename.
      if (body["columns"] !== undefined) {
        const moveMapRaw = body["column_move_map"];
        if (
          moveMapRaw !== undefined &&
          (typeof moveMapRaw !== "object" ||
            moveMapRaw === null ||
            Array.isArray(moveMapRaw) ||
            Object.values(moveMapRaw).some((t) => typeof t !== "string"))
        ) {
          return yield* new ValidationError({ reason: "column_move_map" });
        }
        const moveMap = (moveMapRaw ?? {}) as Record<string, string>;
        const survivingIds = new Set(columns.map((c) => c.id));
        for (const gone of current.columns.filter((c) => !survivingIds.has(c.id))) {
          const count = yield* db.queryFirst<{ n: number }>(
            "SELECT COUNT(*) AS n FROM issueCache WHERE board_id = ? AND column_id = ?",
            [current.id, gone.id],
          );
          if ((count?.n ?? 0) === 0) continue;
          const mapped = moveMap[gone.id];
          const target = mapped === undefined ? undefined : columnById(columns, mapped);
          if (target === undefined || !target.enabled) {
            return yield* new ValidationError({ reason: "column-delete-has-issues" });
          }
          yield* db.execute(
            "UPDATE issueCache SET column_id = ?, status = ? WHERE board_id = ? AND column_id = ?",
            [target.id, target.name, current.id, gone.id],
          );
        }
        for (const col of columns) {
          const prev = current.columns.find((c) => c.id === col.id);
          if (prev !== undefined && prev.name !== col.name) {
            yield* db.execute(
              "UPDATE issueCache SET status = ? WHERE board_id = ? AND column_id = ?",
              [col.name, current.id, col.id],
            );
          }
        }
      }

      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      yield* db.execute(
        "UPDATE boardCache SET title = ?, description = ?, columns = ?, labels = ?, member_policy = ?, issue_prefix = ?, visibility = ?, default_sprint_days = ?, updated_at_ms = ? WHERE id = ?",
        [
          title,
          description === null ? null : JSON.stringify(description),
          JSON.stringify(columns),
          JSON.stringify(labels),
          member_policy,
          issue_prefix,
          visibility,
          default_sprint_days,
          now,
          current.id,
        ],
      );
      yield* audit.record({
        event_type: "board_updated",
        actor: claims.login,
        details: {
          slug: current.slug,
          ...(visibility === current.visibility ? {} : { visibility }),
        },
      });
      let audienceState = {
        audience_epoch: current.audience_epoch,
        audience_pubkey: current.audience_pubkey,
      };
      if (flipToPrivate) {
        audienceState = yield* initializeBoardAudience({ ...current, visibility }).pipe(
          Effect.mapError((e) =>
            e instanceof AudienceKeyError
              ? new ConflictError({ reason: "audience-init-failed" })
              : e,
          ),
        );
        yield* audit.record({
          event_type: "board_flipped_private",
          actor: claims.login,
          details: { slug: current.slug },
        });
      }
      const board: BoardShape = {
        ...current,
        title,
        description,
        columns,
        labels,
        member_policy,
        issue_prefix,
        visibility,
        default_sprint_days,
        is_encrypted: current.is_encrypted || flipToPrivate,
        audience_epoch: audienceState.audience_epoch,
        audience_pubkey: audienceState.audience_pubkey,
        updated_at_ms: now,
      };
      return { board };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── POST /boards/:slug/(un)archive — hide from / restore to lists ──────
  // Owner-only. Archived boards stay reachable by deep link; every list
  // surface filters them unless ?include_archived=1.
  const setArchived = (archive: boolean) => async (c: Context<AppHonoEnv>) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { board } = yield* resolveBoardScope(
        { org_slug: c.req.param("org_slug"), slug: c.req.param("slug") ?? "" },
        callerPubkey(claims),
        "owner",
      );
      const db = yield* Db;
      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      const archived_at_ms = archive ? now : null;
      yield* db.execute(
        "UPDATE boardCache SET archived_at_ms = ?, updated_at_ms = ? WHERE id = ?",
        [archived_at_ms, now, board.id],
      );
      yield* audit.record({
        event_type: archive ? "board_archived" : "board_unarchived",
        actor: claims.login,
        details: { slug: board.slug },
      });
      return { board: { ...board, archived_at_ms, updated_at_ms: now } };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  };
  boards.post("/boards/:slug/archive", setArchived(true));
  boards.post("/boards/:slug/unarchive", setArchived(false));

  // ── DELETE /boards/:slug — remove a board (admin) ───────────────────────
  // Deliberately does NOT cascade to issueCache (soft FKs): issues orphan;
  // a v2 cleanup path reaps them.
  boards.delete("/boards/:slug", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { board: current } = yield* resolveBoardScope(
        { org_slug: c.req.param("org_slug"), slug: c.req.param("slug") },
        callerPubkey(claims),
        "admin",
      );
      const db = yield* Db;
      const audit = yield* AuditLog;
      yield* db.execute("DELETE FROM boardCache WHERE id = ?", [current.id]);
      yield* db.execute("DELETE FROM boardMemberCache WHERE board_id = ?", [current.id]);
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
