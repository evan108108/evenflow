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
import { Cause, Clock, Data, Effect, Exit, Option, Schema } from "effect";
import { ImmutableField, parseRouteBody, requireAnyOf } from "../lib/route-body";
import { AuditLog, Audience, Db, DbError, bootstrap } from "../effects";
import { AudienceKeyError, emitSecureBoardEvent, initializeBoardAudience } from "../audiences";
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

// ── EFB-61 request shapes ─────────────────────────────────────────────────
//
// The four invariants come from parseRouteBody, not from anything here:
// unknown keys 400, wrong types 400, missing-required 400, canonical output.
// See docs/BOUNDARY_DISCIPLINE.md.
//
// Three fields are deliberately `Unknown` and keep their existing validator in
// the handler. Same reasoning issues.ts records for `status`: splitting a check
// that cannot be expressed purely would report two reasons for one broken
// field and change an error string that tests already pin.
//
//   columns  — validateColumns accepts EITHER a coerced string[] or a
//              structured Column[], mints UUIDs while coercing (impure), and
//              reports a dynamic `columns-<problem>` built by
//              columnArrayProblem. None of that is a static schema.
//   issue_prefix — depends on ANOTHER field (derived from title when absent)
//              and upper-cases what it accepts, so it is a cross-field
//              transform, not a shape.
//   done_window_days — reuses validateSprintDays and therefore answers
//              `default_sprint_days` on failure, not `done_window_days`. That
//              looks like a bug and is pre-existing; reproducing it is the
//              point of this ticket, and fixing it belongs in its own.
//
// Every filter below returns a BOOLEAN rather than a message string, matching
// PatchIssueBody. A bare kebab message would be read as a reason CODE and
// surface as `<field>-<slug>`; a boolean false falls back to the field name,
// which is the string these routes already answer.

export const PostBoardBody = Schema.Struct({
  slug: Schema.String.pipe(Schema.filter((s) => SLUG_RE.test(s))),
  // `.trim() !== ""` is NOT `minLength(1)` — the latter accepts "   ".
  title: Schema.String.pipe(Schema.filter((s) => s.trim() !== "")),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  columns: Schema.optional(Schema.Unknown),
  // validateLabels checks Array.isArray and nothing about the elements.
  labels: Schema.optional(Schema.Array(Schema.Unknown)),
  member_policy: Schema.optional(Schema.Literal(...MEMBER_POLICIES)),
  visibility: Schema.optional(Schema.Literal(...VISIBILITIES)),
  issue_prefix: Schema.optional(Schema.Unknown),
});

/** Mutable via PATCH — the list `empty-patch` is computed from. */
const PATCHABLE_BOARD_FIELDS = [
  "title",
  "description",
  "columns",
  "labels",
  "member_policy",
  "issue_prefix",
  "visibility",
  "default_sprint_days",
  "done_window_days",
] as const;

export const PatchBoardBody = Schema.Struct({
  title: Schema.optional(Schema.String.pipe(Schema.filter((s) => s.trim() !== ""))),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  columns: Schema.optional(Schema.Unknown),
  labels: Schema.optional(Schema.Array(Schema.Unknown)),
  member_policy: Schema.optional(Schema.Literal(...MEMBER_POLICIES)),
  visibility: Schema.optional(Schema.Literal(...VISIBILITIES)),
  issue_prefix: Schema.optional(Schema.Unknown),
  default_sprint_days: Schema.optional(
    Schema.Int.pipe(Schema.between(MIN_SPRINT_DAYS, MAX_SPRINT_DAYS)),
  ),
  done_window_days: Schema.optional(Schema.Unknown),
  // Only meaningful alongside `columns`, and only VALIDATED when columns are
  // present — so it stays Unknown and keeps its handler check, which lives
  // inside that branch. Declaring it purely here would start rejecting a bad
  // map sent without columns, which today is ignored. Not patchable on its
  // own: a body carrying only this is still `empty-patch`.
  column_move_map: Schema.optional(Schema.Unknown),
  // Pre-0015 clients still send `is_encrypted`; it is accepted and ignored,
  // `visibility` is authoritative. Declared so strict mode does not start
  // answering `is_encrypted-unknown` to a client that worked yesterday. It is
  // NOT patchable — a body carrying only this is still `empty-patch`.
  is_encrypted: Schema.optional(Schema.Unknown),
  // Real columns this route may not write. Declared rather than left to the
  // unknown-key rule so the caller is told `slug-immutable` ("real field,
  // wrong endpoint") instead of `slug-unknown` ("no such field").
  slug: ImmutableField,
  pubkey: ImmutableField,
  id: ImmutableField,
  org_id: ImmutableField,
  audience_epoch: ImmutableField,
  audience_pubkey: ImmutableField,
}).pipe(Schema.filter(requireAnyOf(PATCHABLE_BOARD_FIELDS)));

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
      const body = yield* parseRouteBody(c, PostBoardBody);

      const slug = body.slug;
      const title = body.title;
      const description = body.description === undefined ? null : body.description;
      const columns =
        body.columns === undefined
          ? defaultColumns(() => crypto.randomUUID())
          : yield* validateColumns(body.columns);
      const labels = body.labels === undefined ? [] : [...body.labels];
      const member_policy = body.member_policy === undefined ? "invite" : body.member_policy;
      const derived = body.issue_prefix === undefined ? derivePrefix(title) : null;
      if (derived === "") {
        return yield* new ValidationError({ reason: "issue_prefix" });
      }
      const requestedPrefix =
        derived !== null ? derived : yield* validatePrefix(body.issue_prefix);
      // Create-time visibility: private is the default (safer for a mixed
      // public/internal use), but a fresh board still lands in the "private
      // but not yet encrypted" third state — audience minting only happens
      // on an explicit PATCH visibility=private, so opting in at create
      // time doesn't silently pay the crypto tax.
      const createVisibility = body.visibility === undefined ? "private" : body.visibility;
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
        // Born private with no audience: members-only reads, plaintext
        // publish, and still freely flippable to public. Encryption goes
        // live on an explicit PATCH visibility=private.
        encryption_active: false,
        is_encrypted: false,
        audience_epoch: 1,
        audience_pubkey: null,
        issue_prefix,
        next_issue_number: 1,
        org_id: org.id,
        visibility: createVisibility,
        default_sprint_days: DEFAULT_SPRINT_DAYS,
        done_window_days: 14,
        archived_at_ms: null,
        created_at_ms: now,
        updated_at_ms: now,
        // Publish is fired off the request path (EFB-24) — not landed yet.
        substrate_event_id: null,
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
          createVisibility,
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
      yield* emitSecureBoardEvent(
        id,
        {
          kind: "board.created",
          board_id: id,
          at_ms: now,
          payload: { board },
        },
        null,
      );
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

  // ── GET /boards/:slug/velocity ────────────────────────────────────────────
  // Rolling velocity: sum of estimates for issues whose completed_at_ms fell
  // within the window. `?days=N` overrides the board's done_window_days; the
  // response echoes the effective window so the caller can render "we ship
  // ~X pts every N days" without re-deriving. Works whether the board uses
  // sprints or not — completed_at_ms is stamped by the shared transition
  // handler regardless of sprint state.
  boards.get("/boards/:slug/velocity", async (c) => {
    const program = Effect.gen(function* () {
      const pubkey = callerPubkeyOrNull(c.get("claims"));
      const { board } = yield* resolveBoardScope(
        { org_slug: c.req.param("org_slug"), slug: c.req.param("slug") },
        pubkey,
        "viewer",
      );
      const daysRaw = c.req.query("days");
      const days = (() => {
        if (daysRaw === undefined) return board.done_window_days;
        const n = Number(daysRaw);
        if (!Number.isInteger(n) || n < 1 || n > 365) return board.done_window_days;
        return n;
      })();

      const db = yield* Db;
      const now = yield* Clock.currentTimeMillis;
      const cutoff = now - days * 86_400_000;
      const rows = yield* db.queryAll(
        "SELECT estimate FROM issueCache WHERE board_id = ? AND completed_at_ms IS NOT NULL AND completed_at_ms >= ?",
        [board.id, cutoff],
      );
      const total = rows.reduce(
        (sum: number, r) => sum + ((r as { estimate: number | null }).estimate ?? 0),
        0,
      );
      const issues_completed = rows.length;
      const per_day = days > 0 ? total / days : 0;
      return {
        window_days: days,
        points_completed: total,
        issues_completed,
        per_day_average: Math.round(per_day * 100) / 100,
      };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── PATCH /boards/:slug — partial update of mutable fields (admin) ──────
  boards.patch("/boards/:slug", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      // Immutable-field and empty-patch rejection are both PatchBoardBody's
      // job now — ImmutableField answers `<field>-immutable` and
      // requireAnyOf answers `empty-patch`, the same two strings this route
      // returned when it checked them by hand.
      const body = yield* parseRouteBody(c, PatchBoardBody);

      const { board: current } = yield* resolveBoardScope(
        { org_slug: c.req.param("org_slug"), slug: c.req.param("slug") },
        callerPubkey(claims),
        "admin",
      );

      // Renaming a prefix would orphan every FLOW-n URL and reference
      // already minted, so it is only editable while no issue exists yet.
      let issue_prefix = current.issue_prefix;
      if (body.issue_prefix !== undefined) {
        if (current.next_issue_number !== 1) {
          return yield* new ConflictError({
            reason: "prefix-locked-issues-exist",
          });
        }
        const requested = yield* validatePrefix(body.issue_prefix);
        issue_prefix =
          requested === current.issue_prefix ? requested : yield* finalizePrefix(requested);
      }

      const title = body.title === undefined ? current.title : body.title;
      const description =
        body.description === undefined ? current.description : body.description;
      const columns =
        body.columns === undefined ? current.columns : yield* validateColumns(body.columns);
      const labels = body.labels === undefined ? current.labels : [...body.labels];
      const member_policy =
        body.member_policy === undefined ? current.member_policy : body.member_policy;
      // Explicitly requested visibility (null = untouched by this PATCH).
      // The distinction matters: only an EXPLICIT `visibility: 'private'`
      // mints the audience, so an unrelated title edit on a board that is
      // private-but-not-yet-encrypted never trips the crypto path.
      const requestedVisibility = body.visibility === undefined ? null : body.visibility;
      const visibility = requestedVisibility ?? current.visibility;
      const default_sprint_days =
        body.default_sprint_days === undefined
          ? current.default_sprint_days
          : body.default_sprint_days;
      // Phase 21c: Done column window. Same 1..90 bounds as sprint days —
      // and, because it shares validateSprintDays, the same `reason` on
      // failure. See the note on PatchBoardBody.
      const done_window_days =
        body.done_window_days === undefined
          ? current.done_window_days
          : yield* validateSprintDays(body.done_window_days);

      // Privacy is ONE setting since migration 0015: `visibility`. Asking for
      // 'private' on a board whose audience hasn't been minted yet IS the
      // privacy flip — it mints the audience below (phase 16.5 machinery).
      // Going back to 'public' after encryption was live is fine: past
      // gift-wrapped events stay on substrate as ciphertext forever (the
      // audience_pubkey and grants stay too, so members-at-encryption-time
      // can keep decrypting their history), and new events publish plaintext
      // from the flip onward. The UI's warning states this plainly.
      //
      // A pre-0015 client may still send `is_encrypted` — accepted and
      // ignored, `visibility` is authoritative.
      const flipToPrivate = requestedVisibility === "private" && !current.encryption_active;
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
      if (body.columns !== undefined) {
        const moveMapRaw = body.column_move_map;
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
        "UPDATE boardCache SET title = ?, description = ?, columns = ?, labels = ?, member_policy = ?, issue_prefix = ?, visibility = ?, default_sprint_days = ?, done_window_days = ?, updated_at_ms = ? WHERE id = ?",
        [
          title,
          description === null ? null : JSON.stringify(description),
          JSON.stringify(columns),
          JSON.stringify(labels),
          member_policy,
          issue_prefix,
          visibility,
          default_sprint_days,
          done_window_days,
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
        done_window_days,
        encryption_active: visibility === "private" && audienceState.audience_pubkey !== null,
        is_encrypted: visibility === "private" && audienceState.audience_pubkey !== null,
        audience_epoch: audienceState.audience_epoch,
        audience_pubkey: audienceState.audience_pubkey,
        updated_at_ms: now,
      };
      yield* emitSecureBoardEvent(
        current.id,
        {
          kind: "board.updated",
          board_id: current.id,
          at_ms: now,
          payload: { board },
        },
        null,
      );
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
      const updated = { ...board, archived_at_ms, updated_at_ms: now };
      yield* emitSecureBoardEvent(
        board.id,
        {
          kind: "board.updated",
          board_id: board.id,
          at_ms: now,
          payload: { board: updated },
        },
        null,
      );
      return { board: updated };
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
      // EFB-32: retire the board's 30550 on the substrate. Without this the
      // last live 30550 outlives the board forever and a replaying consumer
      // resurrects it — replaceable events mean only a newer event AT THE SAME
      // ADDRESS supersedes, and a delete published nowhere supersedes nothing.
      //
      // Emitted AFTER the delete, like issue.deleted and comment.deleted, so
      // the failure direction stays the one we want: a DELETE that fails short-
      // circuits the Effect and nothing publishes, rather than tombstoning a
      // board that still exists. What makes it work where the naive version
      // didn't is `current` — the pre-delete snapshot resolveBoardScope already
      // handed us. emitSecureBoardEvent would otherwise re-read this row to
      // decide whether it may publish, find it gone, and fail closed.
      const now = yield* Clock.currentTimeMillis;
      yield* emitSecureBoardEvent(
        current.id,
        {
          kind: "board.deleted",
          board_id: current.id,
          at_ms: now,
          payload: { board: current },
        },
        // `null`: buildKanbanBoard carries no pubkey at all, so the board
        // tombstone has no actor slot to fill. EFB-63's ticket listed
        // board.deleted as an actor-slot event; the builder says otherwise.
        null,
        current,
      );
      return { deleted: true };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  return boards;
};
