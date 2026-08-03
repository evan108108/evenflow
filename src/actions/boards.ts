/**
 * Board actions — board CRUD against the D1 boardCache, org-scoped since
 * phase 16.
 *
 * EFB-98 split src/routes/boards.ts in two. Everything that decides what a
 * board IS lives here: the request schemas, the failure union, the field
 * validators, the actions. src/routes/boards.ts is the HTTP shell that
 * extracts params, parses the body, calls one of these, and hands the result
 * to runJson.
 *
 * The bodies below moved VERBATIM. Every comment, ordering decision and
 * failure reason is the pre-split code; the only edits read
 * params/query/body/claims off an `input` record instead of off a Context.
 *
 * MVP posture unchanged: handlers write boardCache directly; the kind-30550
 * board event publish lands in the event-publisher phase (uuid ids, and
 * TODO(kms-backfill): pubkey is the "<provider>:<oauth_id>" stand-in).
 * TODO(board-audience-republish): the visibility toggle should republish
 * the board's audience event once board events publish at all.
 *
 * ORG_SLUG IS BUSINESS INPUT, NOT ROUTING. The router is mounted twice by
 * index.ts — at /api/v0 (legacy compat, no org_slug param, boards resolve
 * against the caller's own/visible set) and at /api/v0/orgs/:org_slug
 * (canonical, boards resolve inside that org) — and these actions branch on
 * it. So it arrives as `input.orgSlug`, a declared field, rather than being
 * read out of a Context none of this code can see. `board.create` branches on
 * its PRESENCE (an org mount authorizes into that org; the bare mount ensures
 * a personal one), which is why null has to survive the trip intact rather
 * than being collapsed to "".
 *
 * Auth: /api/v0/* runs behind optionalAuth — reads allow anonymous on public
 * boards, so `getBoard` and `boardVelocity` take a PublicActionInput and say
 * so in their signatures. Every mutation takes an ActionInput, which means the
 * route already ran requireCaller and the 401 has happened by the time the
 * action does.
 */

import { Clock, Effect, Schema } from "effect";

import { AuditLog, Audience, BoardEmitter, Db, DbError, FourA } from "../effects";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors";
import { AudienceKeyError, emitSecureBoardEvent, initializeBoardAudience } from "../audiences";
import {
  ForbiddenError,
  UnauthorizedError,
  authorizeOrgAccess,
  callerPubkey,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { ensurePersonalOrg, upsertMembership } from "../membership";
import { ImmutableField, requireAnyOf } from "../lib/route-body";
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
import type { ActionInput, PublicActionInput } from "./types";

const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MEMBER_POLICIES = ["open", "invite"] as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_SPRINT_DAYS = 14;
const MIN_SPRINT_DAYS = 1;
const MAX_SPRINT_DAYS = 90;

/**
 * EFB-98 step 6: these three were declared locally in src/routes/boards.ts.
 * They carry the same tags and the same single `reason` field as the shared
 * vocabulary in src/lib/errors.ts, and `errorResponse` has always matched on
 * `_tag` rather than on identity — so importing them changes no answer this
 * family gives, it just stops a fourth copy of the same three classes existing.
 */
export type BoardsFailure =
  | ValidationError
  | ConflictError
  | NotFoundError
  | BoardOwnershipError
  | UnauthorizedError
  | ForbiddenError
  | DbError;

/**
 * Services every board action needs.
 *
 * FourA is in the union because `ensurePersonalOrg` and `upsertMembership`
 * publish a kind-30521 key grant on the substrate — only `createBoard`
 * reaches them, but a single union per family keeps every action in this file
 * runnable through one `makeRunJson` instantiation, which is the point of
 * having a shared runner at all.
 */
export type BoardServices = Db | AuditLog | Audience | BoardEmitter | FourA;

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

/**
 * EFB-86: the reason names the FIELD BEING VALIDATED, not this function.
 *
 * Both `default_sprint_days` and `done_window_days` are 1..90 day counts, so
 * they shared a validator — and the validator hardcoded `default_sprint_days`
 * as its reason string. A caller who sent a bad `done_window_days` was told to
 * go fix a field they had not sent. EFB-61 found it during the boards.ts
 * migration and correctly reproduced it rather than fixing it under cover of
 * that PR; this is the standalone fix.
 *
 * The field name is a required parameter rather than one defaulting to
 * `"default_sprint_days"`. A default would let the next shared callsite
 * inherit the same wrong answer silently, which is the entire bug — the point
 * is that adding a third field has to say which field it is.
 */
const validateSprintDays = (v: unknown, field: "default_sprint_days" | "done_window_days") =>
  typeof v === "number" && Number.isInteger(v) && v >= MIN_SPRINT_DAYS && v <= MAX_SPRINT_DAYS
    ? Effect.succeed(v)
    : Effect.fail(new ValidationError({ reason: field }));

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
// These live beside the logic that consumes them; the ROUTE imports them back
// for `parseRouteBody`, so check:boundary keeps seeing the body read exactly
// where it has always seen it.
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
//   done_window_days — EFB-86 fixed the reason string (it answers its own
//              field name now), but the field STAYS untyped here, and the
//              reason is `issue_prefix`'s: the handler answers 409
//              `prefix-locked-issues-exist` before it ever reaches this field,
//              so typing it would turn `{issue_prefix, done_window_days: 999}`
//              on a board with issues from 409 into 400. Fixing a reason string
//              is what EFB-86 licensed; changing a status code is not.
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

/**
 * The board's slug, as this family reads it off an input record.
 *
 * `setArchived` already spelled its read `c.req.param("slug") ?? ""` while its
 * five siblings spelled it `c.req.param("slug")` — same runtime value, because
 * the manifest declares the param on every one of these paths. One helper so
 * the difference stops being a thing a reader has to check six times.
 */
const slugOf = (input: { readonly params: Readonly<Record<string, string>> }) =>
  input.params["slug"] ?? "";

/**
 * The scope selector `resolveBoardScope` wants, rebuilt from the input record.
 *
 * `orgSlug` is `string | null` on an ActionInput (null = the bare mount) and
 * `org_slug` is `string | undefined` here, so the one conversion lives in one
 * place rather than at five callsites.
 */
const boardScopeOf = (input: {
  readonly orgSlug: string | null;
  readonly params: Readonly<Record<string, string>>;
}) => ({ org_slug: input.orgSlug ?? undefined, slug: slugOf(input) });

/** POST /boards — create (in :org_slug when present, else personal). */
export const createBoard = (
  input: ActionInput<typeof PostBoardBody.Type>,
): Effect.Effect<unknown, BoardsFailure, BoardServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const token = input.token;
    const pubkey = callerPubkey(claims);
    const body = input.body;

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
    // Presence, not value: the org mount authorizes into the named org, the
    // bare mount ensures the caller's personal one. `null` is the bare mount.
    const orgSlugParam = input.orgSlug;
    let org: OrgShape;
    if (orgSlugParam !== null) {
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

/**
 * GET /boards — every board the caller can see, newest-updated first.
 *
 * (Org-scoped listing lives on the orgs router: GET /orgs/:slug/boards.)
 */
export const listBoards = (
  input: ActionInput,
): Effect.Effect<unknown, BoardsFailure, BoardServices> =>
  Effect.gen(function* () {
    const limitRaw = input.query["limit"];
    const after = input.query["after"];
    const includeArchived = input.query["include_archived"] === "1";

    const claims = input.claims;
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

/** GET /boards/:slug — fetch one visible board. Anonymous-readable. */
export const getBoard = (
  input: PublicActionInput,
): Effect.Effect<unknown, BoardsFailure, BoardServices> =>
  Effect.gen(function* () {
    const pubkey = input.claims === null ? null : callerPubkey(input.claims);
    const { board, org, role } = yield* resolveBoardScope(boardScopeOf(input), pubkey, "viewer");
    return { board, org: orgView(org), role };
  });

/**
 * GET /boards/:slug/velocity — anonymous-readable.
 *
 * Rolling velocity: sum of estimates for issues whose completed_at_ms fell
 * within the window. `?days=N` overrides the board's done_window_days; the
 * response echoes the effective window so the caller can render "we ship
 * ~X pts every N days" without re-deriving. Works whether the board uses
 * sprints or not — completed_at_ms is stamped by the shared transition
 * handler regardless of sprint state.
 */
export const boardVelocity = (
  input: PublicActionInput,
): Effect.Effect<unknown, BoardsFailure, BoardServices> =>
  Effect.gen(function* () {
    const pubkey = input.claims === null ? null : callerPubkey(input.claims);
    const { board } = yield* resolveBoardScope(boardScopeOf(input), pubkey, "viewer");
    const daysRaw = input.query["days"];
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

/** PATCH /boards/:slug — partial update of mutable fields (admin). */
export const updateBoard = (
  input: ActionInput<typeof PatchBoardBody.Type>,
): Effect.Effect<unknown, BoardsFailure, BoardServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    // Immutable-field and empty-patch rejection are both PatchBoardBody's
    // job now — ImmutableField answers `<field>-immutable` and
    // requireAnyOf answers `empty-patch`, the same two strings this route
    // returned when it checked them by hand.
    const body = input.body;

    const { board: current } = yield* resolveBoardScope(
      boardScopeOf(input),
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
    // Phase 21c: Done column window. Same 1..90 bounds as sprint days, and
    // since EFB-86 it answers with its OWN field name on failure.
    const done_window_days =
      body.done_window_days === undefined
        ? current.done_window_days
        : yield* validateSprintDays(body.done_window_days, "done_window_days");

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
      yield* resolveBoardScope(boardScopeOf(input), callerPubkey(claims), "owner");
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

/**
 * POST/DELETE /boards/:slug/archived — hide from / restore to lists.
 *
 * Owner-only. Archived boards stay reachable by deep link; every list
 * surface filters them unless ?include_archived=1.
 *
 * EFB-98: archiving is a state, so it gets the CRUD pair on one path rather
 * than a second verb URL. POST sets it, DELETE clears it; `unarchive` is gone.
 */
export const setBoardArchived =
  (archive: boolean) =>
  (input: ActionInput): Effect.Effect<unknown, BoardsFailure, BoardServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const { board } = yield* resolveBoardScope(
      boardScopeOf(input),
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

/**
 * DELETE /boards/:slug — remove a board (admin).
 *
 * Deliberately does NOT cascade to issueCache (soft FKs): issues orphan;
 * a v2 cleanup path reaps them.
 */
export const deleteBoard = (
  input: ActionInput,
): Effect.Effect<unknown, BoardsFailure, BoardServices> =>
  Effect.gen(function* () {
    const claims = input.claims;
    const { board: current } = yield* resolveBoardScope(
      boardScopeOf(input),
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
