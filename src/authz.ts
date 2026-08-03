// Shared authorization for /api/v0 routers — the phase-16 membership model.
//
// Role hierarchy: owner > admin > contributor (= org member) > viewer.
// A caller's effective role on a board is the strongest of:
//   * their explicit boardMemberCache row,
//   * their orgMemberCache role on the board's org (owner→owner,
//     admin→admin, member→contributor),
//   * viewer, when the board is public (anonymous callers included).
//
// Failure posture — a privacy primitive, not an ergonomic choice (EFB-76):
//
//   * ANONYMOUS caller, resource not publicly visible → 401
//     ("unauthorized"), UNIFORMLY, whether or not the resource exists.
//   * AUTHENTICATED caller with no access to a private resource → 404
//     ("not-found") — existence must not leak.
//   * Caller WITH access but below the required role → 403 ("forbidden").
//   * Missing auth on an endpoint that needs identity → 401.
//
// The word UNIFORMLY is the whole design. Splitting the anonymous case into
// 401-when-it-exists / 404-when-it-doesn't reads more precise and is strictly
// worse: it hands an oracle to callers holding no credentials at all. Short
// ids are per-board sequential, so walking FLOW-1..N and watching the status
// code would map every private board's ticket count and activity. The 401 has
// to be the same answer for "private" and "nonexistent" or it is not a fix.
// See `notVisible` below; do not collapse it back into a 404 for consistency.

import { Data, Effect } from "effect";
import { Db, type DbError, type Claims } from "./effects";
import {
  parseBoardRow,
  parseOrgRow,
  type BoardShape,
  type OrgShape,
} from "./shapes";
import { roleAtLeast } from "./roles";

// TODO(kms-backfill): provider-qualified stand-in, not a Nostr pubkey.
// Provider-qualified because a bare oauth_id collides across providers
// ("123" on Google vs GitHub); this is exactly the tuple KMS derives real
// pubkeys from, so the backfill is a pure re-derivation.
export const callerPubkey = (claims: Claims): string =>
  `${claims.provider}:${claims.oauth_id}`;

/** Anonymous-tolerant variant: Hono's claims variable is unset for anonymous requests. */
export const callerPubkeyOrNull = (claims: Claims | undefined): string | null =>
  claims === undefined ? null : callerPubkey(claims);

/**
 * Caller cannot see such a resource. Deliberately indistinguishable from
 * "does not exist" (404, not 403) — existence of other people's private
 * orgs/boards must not leak.
 */
export class BoardOwnershipError extends Data.TaggedError("BoardOwnershipError")<{
  readonly reason: "board" | "org";
}> {}

/** Endpoint needs identity and the request carried no (valid) JWT. → 401 */
export class UnauthorizedError extends Data.TaggedError("UnauthorizedError")<{
  readonly reason: string;
}> {}

/** Caller can see the resource but their role is below the requirement. → 403 */
export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly reason: string;
}> {}

/**
 * The reason an anonymous caller sees when a resource is not publicly
 * visible. One constant because every such 401 must be textually identical:
 * a distinguishable reason string would rebuild the existence oracle the
 * status code just closed.
 */
export const ANONYMOUS_UNAUTHORIZED_REASON = "authentication-required";

/**
 * Pick the failure for "this caller cannot see this resource."
 *
 * PRIVACY PRIMITIVE — see the module header. Anonymous callers get 401 and
 * learn nothing about existence; authenticated ones get whatever the caller
 * passed as `hidden` (a 404-shaped error), which keeps the no-leak posture
 * the header describes. `hidden` is returned as-is rather than constructed
 * here so each caller keeps its own `reason` grammar ("issue", "board",
 * "org") for authenticated callers, who are allowed that much detail.
 *
 * Do not "simplify" this to always return `hidden`. The 401 is load-bearing:
 * it is the entire fix for EFB-76, and the uniformity is what makes it safe.
 */
export const notVisible = <E>(pubkey: string | null, hidden: E): UnauthorizedError | E =>
  pubkey === null
    ? new UnauthorizedError({ reason: ANONYMOUS_UNAUTHORIZED_REASON })
    : hidden;

/** Fail 401-typed unless the request is authenticated. */
export const requireCaller = (
  claims: Claims | undefined,
): Effect.Effect<Claims, UnauthorizedError> =>
  claims === undefined
    ? Effect.fail(new UnauthorizedError({ reason: "authentication-required" }))
    : Effect.succeed(claims);

// ── org resolution ────────────────────────────────────────────────────────

/**
 * Resolve a live org by slug, following orgSlugAlias renames. Returns the
 * org plus whether the slug was an alias (callers 302 canonical when so).
 */
export const resolveOrgBySlug = (
  slug: string,
): Effect.Effect<{ org: OrgShape; viaAlias: boolean } | null, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const direct = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT * FROM orgCache WHERE slug = ? AND deleted_at_ms IS NULL",
      [slug],
    );
    if (direct !== null) return { org: parseOrgRow(direct), viaAlias: false };
    const alias = yield* db.queryFirst<{ org_id: string }>(
      "SELECT org_id FROM orgSlugAlias WHERE old_slug = ?",
      [slug],
    );
    if (alias === null) return null;
    const aliased = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT * FROM orgCache WHERE id = ? AND deleted_at_ms IS NULL",
      [alias.org_id],
    );
    return aliased === null ? null : { org: parseOrgRow(aliased), viaAlias: true };
  });

/** The caller's org-scope role, or null when not a member. */
export const orgRoleOf = (
  orgId: string,
  pubkey: string | null,
): Effect.Effect<string | null, DbError, Db> =>
  pubkey === null
    ? Effect.succeed(null)
    : Effect.gen(function* () {
        const db = yield* Db;
        const row = yield* db.queryFirst<{ role: string }>(
          "SELECT role FROM orgMemberCache WHERE org_id = ? AND pubkey = ?",
          [orgId, pubkey],
        );
        return row === null ? null : row.role;
      });

/**
 * Resolve org + prove the caller holds at least `minRole` on it.
 * Non-members of any org get 404-shaped BoardOwnershipError; members below
 * the bar get 403-shaped ForbiddenError. Pass minRole "viewer" for public
 * surfaces (org detail): any caller — anonymous included — passes, with
 * role null for outsiders.
 */
export const authorizeOrgAccess = (
  slug: string,
  pubkey: string | null,
  minRole: string,
): Effect.Effect<
  { org: OrgShape; role: string | null; viaAlias: boolean },
  BoardOwnershipError | ForbiddenError | UnauthorizedError | DbError,
  Db
> =>
  Effect.gen(function* () {
    // Above "viewer" an anonymous caller can never qualify, so answer 401
    // before touching the DB — no lookup, nothing to observe. Deliberately
    // NOT applied to the viewer path: org detail is a public surface where a
    // missing org is an honest 404, because existing orgs answer 200 to
    // anonymous callers anyway. There is no oracle to close there, and
    // 401-ing a public read would only make it harder to use.
    if (minRole !== "viewer" && pubkey === null) {
      return yield* new UnauthorizedError({ reason: ANONYMOUS_UNAUTHORIZED_REASON });
    }
    const resolved = yield* resolveOrgBySlug(slug);
    if (resolved === null) return yield* new BoardOwnershipError({ reason: "org" });
    const role = yield* orgRoleOf(resolved.org.id, pubkey);
    if (minRole === "viewer") return { org: resolved.org, role, viaAlias: resolved.viaAlias };
    if (role === null) return yield* new BoardOwnershipError({ reason: "org" });
    if (!roleAtLeast(role, minRole)) {
      return yield* new ForbiddenError({ reason: `requires-${minRole}` });
    }
    return { org: resolved.org, role, viaAlias: resolved.viaAlias };
  });

// ── board resolution ──────────────────────────────────────────────────────

/** Org member roles project onto boards: owner→owner, admin→admin, member→contributor. */
const boardRoleFromOrgRole = (orgRole: string | null): string | null => {
  if (orgRole === "owner" || orgRole === "admin") return orgRole;
  if (orgRole === "member") return "contributor";
  return null;
};

const strongest = (...roles: Array<string | null>): string | null =>
  roles.reduce<string | null>((best, r) => {
    if (r === null) return best;
    if (best === null || !roleAtLeast(best, r)) return r;
    return best;
  }, null);

/**
 * The caller's effective role on a board (explicit grant ∪ org projection ∪
 * public-viewer floor), or null when they cannot see it at all.
 */
export const effectiveBoardRole = (
  board: BoardShape,
  pubkey: string | null,
): Effect.Effect<string | null, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const publicFloor = board.visibility === "public" ? "viewer" : null;
    if (pubkey === null) return publicFloor;
    // Pre-0004 rows: the creator keeps admin until the backfill lands.
    const creatorRole = board.pubkey === pubkey ? "admin" : null;
    const explicit = yield* db.queryFirst<{ role: string }>(
      "SELECT role FROM boardMemberCache WHERE board_id = ? AND pubkey = ?",
      [board.id, pubkey],
    );
    const orgRole = board.org_id === null ? null : yield* orgRoleOf(board.org_id, pubkey);
    return strongest(explicit?.role ?? null, boardRoleFromOrgRole(orgRole), publicFloor, creatorRole);
  });

/** Enforce minRole against an already-loaded board. 404 for invisible, 403 for under-role. */
export const authorizeBoard = (
  board: BoardShape,
  pubkey: string | null,
  minRole: string,
): Effect.Effect<
  { board: BoardShape; role: string },
  BoardOwnershipError | ForbiddenError | UnauthorizedError | DbError,
  Db
> =>
  Effect.gen(function* () {
    const role = yield* effectiveBoardRole(board, pubkey);
    // Public boards never reach the null branch — effectiveBoardRole hands
    // anonymous callers a "viewer" floor first, which is what keeps EFB-24's
    // anonymous public reads answering 200 through this fix.
    if (role === null) return yield* notVisible(pubkey, new BoardOwnershipError({ reason: "board" }));
    if (!roleAtLeast(role, minRole)) {
      return yield* new ForbiddenError({ reason: `requires-${minRole}` });
    }
    return { board, role };
  });

/** Load a board by id and enforce minRole. */
export const authorizeBoardById = (
  boardId: string,
  pubkey: string | null,
  minRole: string,
): Effect.Effect<
  { board: BoardShape; role: string },
  BoardOwnershipError | ForbiddenError | UnauthorizedError | DbError,
  Db
> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst<Record<string, unknown>>(
      "SELECT * FROM boardCache WHERE id = ?",
      [boardId],
    );
    // Nonexistent board: 401 for anonymous, same as a private one. Splitting
    // these two is the oracle the module header forbids.
    if (row === null) return yield* notVisible(pubkey, new BoardOwnershipError({ reason: "board" }));
    return yield* authorizeBoard(parseBoardRow(row), pubkey, minRole);
  });

/**
 * Resolve a board from route params + enforce minRole. Two addressing
 * modes, decided by whether an org_slug param is present on the route:
 *   * org-scoped (canonical): /orgs/:org_slug/boards/:slug → the board
 *     with that slug inside that org.
 *   * legacy (compat alias): /boards/:slug → the best-ranked board with
 *     that slug among those the caller can see, preferring their own
 *     (personal-org / created) boards — pre-16 semantics unchanged for
 *     pre-16 data.
 */
export const resolveBoardScope = (
  params: { org_slug?: string | undefined; slug: string },
  pubkey: string | null,
  minRole: string,
): Effect.Effect<
  { board: BoardShape; org: OrgShape | null; role: string },
  BoardOwnershipError | ForbiddenError | UnauthorizedError | DbError,
  Db
> =>
  Effect.gen(function* () {
    const db = yield* Db;
    if (params.org_slug !== undefined) {
      const resolved = yield* resolveOrgBySlug(params.org_slug);
      if (resolved === null) {
        return yield* notVisible(pubkey, new BoardOwnershipError({ reason: "org" }));
      }
      const row = yield* db.queryFirst<Record<string, unknown>>(
        "SELECT * FROM boardCache WHERE org_id = ? AND slug = ?",
        [resolved.org.id, params.slug],
      );
      if (row === null) {
        return yield* notVisible(pubkey, new BoardOwnershipError({ reason: "board" }));
      }
      const authorized = yield* authorizeBoard(parseBoardRow(row), pubkey, minRole);
      return { ...authorized, org: resolved.org };
    }

    // Legacy: match by slug across every board carrying it, pick the first
    // the caller can access — own boards outrank invited/public ones.
    const rows = yield* db.queryAll<Record<string, unknown>>(
      "SELECT * FROM boardCache WHERE slug = ? ORDER BY (pubkey = ?) DESC, created_at_ms ASC",
      [params.slug, pubkey ?? ""],
    );
    let sawForbidden = false;
    for (const row of rows) {
      const board = parseBoardRow(row);
      const role = yield* effectiveBoardRole(board, pubkey);
      if (role === null) continue;
      if (!roleAtLeast(role, minRole)) {
        sawForbidden = true;
        continue;
      }
      const orgRow =
        board.org_id === null
          ? null
          : yield* db.queryFirst<Record<string, unknown>>(
              "SELECT * FROM orgCache WHERE id = ? AND deleted_at_ms IS NULL",
              [board.org_id],
            );
      return { board, role, org: orgRow === null ? null : parseOrgRow(orgRow) };
    }
    if (sawForbidden) return yield* new ForbiddenError({ reason: `requires-${minRole}` });
    // No visible board carried this slug — including the case where no board
    // carries it at all. Anonymous gets 401 for both; see module header.
    return yield* notVisible(pubkey, new BoardOwnershipError({ reason: "board" }));
  });

/**
 * Back-compat shim for the pre-16 call shape (owner-only board fetch), now
 * membership-aware: "own" means admin-or-better. Remaining importers are
 * legacy write paths; reads should use resolveBoardScope directly.
 */
// UnauthorizedError is in the union for the type-checker's benefit only: this
// shim takes a non-null pubkey, so resolveBoardScope's anonymous 401 branch is
// unreachable here. Widening beats casting it away.
export const assertOwnBoard = (
  slug: string,
  pubkey: string,
): Effect.Effect<
  BoardShape,
  BoardOwnershipError | ForbiddenError | UnauthorizedError | DbError,
  Db
> => Effect.map(resolveBoardScope({ slug }, pubkey, "admin"), (r) => r.board);
