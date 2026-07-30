// /api/v0/orgs — org CRUD, org members, and board members.
//
// Namespace model (phase 16): every board lives in an org; /@{handle} is an
// org slug. Personal orgs are ONLY auto-created (session bootstrap); this
// router creates team orgs. Role requirements per endpoint follow the spec
// matrix — see authz.ts for the hierarchy and failure posture.
//
// Substrate: mutations cache D1 first and best-effort publish kind-30520 /
// kind-30521 events (membership.ts) — a 4a outage never blocks an org edit.

import { Hono } from "hono";
import { Clock, Effect, Exit } from "effect";
import { AuditLog, Db, bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import {
  BoardOwnershipError,
  ForbiddenError,
  authorizeOrgAccess,
  callerPubkey,
  callerPubkeyOrNull,
  effectiveBoardRole,
  requireCaller,
  resolveBoardScope,
  resolveOrgBySlug,
} from "../authz";
import {
  publishOrgBestEffort,
  removeMembership,
  upsertMembership,
} from "../membership";
import { parseBoardRow, parseMemberRow, parseOrgRow, type OrgShape } from "../shapes";
import {
  BOARD_ROLES,
  ORG_ROLES,
  ORG_SLUG_RE,
  RESERVED_ORG_SLUGS,
  roleAtLeast,
} from "../roles";
import { ConflictError, NotFoundError, ValidationError, errorResponse, readJsonBody } from "./errors";
import { AudienceKeyError, grantMemberOnJoin, rotateBoardAudience } from "../audiences";
import type { BoardShape } from "../shapes";


const ORG_NAME_MAX = 128;

// ── phase 16.5: private-board key hooks ───────────────────────────────────

/** Every encrypted board owned by an org. */
const privateBoardsOfOrg = (orgId: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* db.queryAll(
      "SELECT * FROM boardCache WHERE org_id = ? AND is_encrypted = 1",
      [orgId],
    );
    return rows.map(parseBoardRow);
  });

/** Grant issuance on join is best-effort: a member without a grant can
 *  always request-regrant, so key trouble must not fail the add. */
const grantOnJoinBestEffort = (board: BoardShape, memberPubkey: string) =>
  grantMemberOnJoin(board, memberPubkey).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        console.log(
          JSON.stringify({
            warn: "member-grant-deferred",
            board_id: board.id,
            reason: e instanceof AudienceKeyError ? e.reason : "db",
          }),
        );
      }),
    ),
  );

/** Rotation on removal is NOT best-effort — honest crypto means the epoch
 *  bump must land before the roster shrinks; failures abort the removal. */
const rotateOnRemoval = (board: BoardShape, removedPubkey: string) =>
  rotateBoardAudience(board, removedPubkey).pipe(
    Effect.mapError((e) =>
      e instanceof AudienceKeyError ? new ConflictError({ reason: `audience-${e.reason}` }) : e,
    ),
  );
const ORG_BIO_MAX = 4000;
const ORG_AVATAR_URL_MAX = 512;

// ── field validators ──────────────────────────────────────────────────────

const validateDisplayName = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" && v.length <= ORG_NAME_MAX
    ? Effect.succeed(v)
    : Effect.fail(new ValidationError({ reason: "display_name" }));

const validateBio = (v: unknown) =>
  v === null || (typeof v === "string" && v.length <= ORG_BIO_MAX)
    ? Effect.succeed(v as string | null)
    : Effect.fail(new ValidationError({ reason: "bio" }));

const validateAvatarUrl = (v: unknown) =>
  v === null ||
  (typeof v === "string" && v.startsWith("https://") && v.length <= ORG_AVATAR_URL_MAX)
    ? Effect.succeed(v as string | null)
    : Effect.fail(new ValidationError({ reason: "avatar_url" }));

const validatePubkey = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" && v.length <= 256
    ? Effect.succeed(v)
    : Effect.fail(new ValidationError({ reason: "pubkey" }));

const validateOrgRole = (v: unknown) =>
  typeof v === "string" && (ORG_ROLES as ReadonlyArray<string>).includes(v)
    ? Effect.succeed(v)
    : Effect.fail(new ValidationError({ reason: "role" }));

const validateBoardRole = (v: unknown) =>
  typeof v === "string" && (BOARD_ROLES as ReadonlyArray<string>).includes(v)
    ? Effect.succeed(v)
    : Effect.fail(new ValidationError({ reason: "role" }));

/** New-slug validation: shape + reserved blocklist + global uniqueness (orgs ∪ aliases). */
const validateNewOrgSlug = (v: unknown) =>
  Effect.gen(function* () {
    if (typeof v !== "string" || !ORG_SLUG_RE.test(v)) {
      return yield* new ValidationError({ reason: "slug" });
    }
    if (RESERVED_ORG_SLUGS.has(v)) {
      return yield* new ConflictError({ reason: "slug-reserved" });
    }
    const db = yield* Db;
    const org = yield* db.queryFirst("SELECT id FROM orgCache WHERE slug = ?", [v]);
    if (org !== null) return yield* new ConflictError({ reason: "slug-in-use" });
    const alias = yield* db.queryFirst("SELECT org_id FROM orgSlugAlias WHERE old_slug = ?", [v]);
    if (alias !== null) return yield* new ConflictError({ reason: "slug-in-use" });
    return v;
  });

// ── wire views ────────────────────────────────────────────────────────────

/** What anyone — anonymous included — may see about an org. */
const publicOrgView = (org: OrgShape) => ({
  slug: org.slug,
  display_name: org.display_name,
  avatar_url: org.avatar_url,
  bio: org.bio,
  kind: org.kind,
  created_at_ms: org.created_at_ms,
});

/** The member-only extension. */
const memberOrgView = (org: OrgShape) => ({
  ...publicOrgView(org),
  id: org.id,
  created_by: org.created_by,
  substrate_event_id: org.substrate_event_id,
  updated_at_ms: org.updated_at_ms,
});

export const makeOrgsRouter = (layerFor: LayerFor = bootstrap) => {
  const orgs = new Hono<AppHonoEnv>();

  // ── POST /orgs — create a team org ──────────────────────────────────────
  orgs.post("/orgs", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);

      if (body["kind"] !== "team") {
        // Personal orgs are only ever auto-created by session bootstrap.
        return yield* new ValidationError({ reason: "kind-must-be-team" });
      }
      const slug = yield* validateNewOrgSlug(body["slug"]);
      const display_name = yield* validateDisplayName(body["display_name"]);
      const avatar_url =
        body["avatar_url"] === undefined ? null : yield* validateAvatarUrl(body["avatar_url"]);
      const bio = body["bio"] === undefined ? null : yield* validateBio(body["bio"]);

      const db = yield* Db;
      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      const id = crypto.randomUUID();
      yield* db.execute(
        "INSERT INTO orgCache (id, slug, display_name, avatar_url, bio, kind, created_by, substrate_event_id, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, 'team', ?, NULL, ?, ?)",
        [id, slug, display_name, avatar_url, bio, pubkey, now, now],
      );
      const org = parseOrgRow(
        yield* db.queryFirst<Record<string, unknown>>("SELECT * FROM orgCache WHERE id = ?", [id]),
      );
      yield* upsertMembership({
        table: "orgMemberCache",
        scopeId: id,
        pubkey,
        role: "owner",
        addedBy: pubkey,
        token,
        grant: { scope: "org", target: slug },
      });
      yield* publishOrgBestEffort(token, org);
      yield* audit.record({ event_type: "org_created", actor: claims.login, details: { slug } });
      return { org: memberOrgView(org), role: "owner" };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, 201);
  });

  // ── GET /orgs/:slug — detail; public info for anyone, internal for members
  orgs.get("/orgs/:slug", async (c) => {
    const program = Effect.gen(function* () {
      const pubkey = callerPubkeyOrNull(c.get("claims"));
      const { org, role, viaAlias } = yield* authorizeOrgAccess(
        c.req.param("slug"),
        pubkey,
        "viewer",
      );
      if (role === null) return { org: publicOrgView(org), role: null, via_alias: viaAlias };
      return { org: memberOrgView(org), role, via_alias: viaAlias };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── PATCH /orgs/:slug — profile edits + slug rename (admin+) ────────────
  orgs.patch("/orgs/:slug", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const body = yield* readJsonBody(c);
      const { org } = yield* authorizeOrgAccess(
        c.req.param("slug"),
        callerPubkey(claims),
        "admin",
      );

      const hasPatch = ["display_name", "avatar_url", "bio", "slug"].some(
        (k) => body[k] !== undefined,
      );
      if (!hasPatch) return yield* new ValidationError({ reason: "empty-patch" });

      const display_name =
        body["display_name"] === undefined
          ? org.display_name
          : yield* validateDisplayName(body["display_name"]);
      const avatar_url =
        body["avatar_url"] === undefined ? org.avatar_url : yield* validateAvatarUrl(body["avatar_url"]);
      const bio = body["bio"] === undefined ? org.bio : yield* validateBio(body["bio"]);

      const db = yield* Db;
      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;

      let slug = org.slug;
      if (body["slug"] !== undefined && body["slug"] !== org.slug) {
        slug = yield* validateNewOrgSlug(body["slug"]);
        // 302-forever: the old slug redirects until (unless) reclaimed.
        yield* db.execute(
          "INSERT OR REPLACE INTO orgSlugAlias (old_slug, org_id, created_at_ms) VALUES (?, ?, ?)",
          [org.slug, org.id, now],
        );
      }

      yield* db.execute(
        "UPDATE orgCache SET slug = ?, display_name = ?, avatar_url = ?, bio = ?, updated_at_ms = ? WHERE id = ?",
        [slug, display_name, avatar_url, bio, now, org.id],
      );
      const updated = parseOrgRow(
        yield* db.queryFirst<Record<string, unknown>>("SELECT * FROM orgCache WHERE id = ?", [
          org.id,
        ]),
      );
      yield* publishOrgBestEffort(token, updated);
      yield* audit.record({
        event_type: "org_updated",
        actor: claims.login,
        details: { slug: updated.slug, renamed_from: slug === org.slug ? null : org.slug },
      });
      return { org: memberOrgView(updated) };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── DELETE /orgs/:slug — soft-delete (owner only; team orgs only) ───────
  orgs.delete("/orgs/:slug", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { org } = yield* authorizeOrgAccess(c.req.param("slug"), callerPubkey(claims), "owner");
      if (org.kind === "personal") {
        // Deleting the personal org would orphan the caller's handle and
        // every legacy board route; not allowed.
        return yield* new ConflictError({ reason: "personal-org-undeletable" });
      }
      const db = yield* Db;
      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      // Soft-delete + 30-day purge: resolvers filter deleted_at_ms IS NULL
      // everywhere; the purge sweep is a follow-up job.
      yield* db.execute("UPDATE orgCache SET deleted_at_ms = ?, updated_at_ms = ? WHERE id = ?", [
        now,
        now,
        org.id,
      ]);
      yield* audit.record({
        event_type: "org_deleted",
        actor: claims.login,
        details: { slug: org.slug },
      });
      return { deleted: true };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── POST /orgs/:slug/transfer — ownership transfer (owner only) ─────────
  orgs.post("/orgs/:slug/transfer", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);
      const { org } = yield* authorizeOrgAccess(c.req.param("slug"), pubkey, "owner");

      const to_pubkey = yield* validatePubkey(body["to_pubkey"]);
      if (body["confirmation_slug"] !== org.slug) {
        return yield* new ValidationError({ reason: "confirmation-slug-mismatch" });
      }
      if (to_pubkey === pubkey) {
        return yield* new ValidationError({ reason: "transfer-to-self" });
      }

      const audit = yield* AuditLog;
      yield* upsertMembership({
        table: "orgMemberCache",
        scopeId: org.id,
        pubkey: to_pubkey,
        role: "owner",
        addedBy: pubkey,
        token,
        grant: { scope: "org", target: org.slug },
      });
      yield* upsertMembership({
        table: "orgMemberCache",
        scopeId: org.id,
        pubkey,
        role: "admin",
        addedBy: pubkey,
        token,
        grant: { scope: "org", target: org.slug },
      });
      yield* publishOrgBestEffort(token, org);
      yield* audit.record({
        event_type: "org_transferred",
        actor: claims.login,
        details: { slug: org.slug, to: to_pubkey },
      });
      return { transferred: true, new_owner: to_pubkey };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── GET /orgs/:slug/boards — org board list, visibility-filtered ────────
  orgs.get("/orgs/:slug/boards", async (c) => {
    const includeArchived = c.req.query("include_archived") === "1";
    const program = Effect.gen(function* () {
      const pubkey = callerPubkeyOrNull(c.get("claims"));
      const resolved = yield* resolveOrgBySlug(c.req.param("slug"));
      if (resolved === null) return yield* new NotFoundError({ reason: "org" });
      const db = yield* Db;
      const rows = yield* db.queryAll<Record<string, unknown>>(
        includeArchived
          ? "SELECT * FROM boardCache WHERE org_id = ? ORDER BY updated_at_ms DESC, id DESC"
          : "SELECT * FROM boardCache WHERE org_id = ? AND archived_at_ms IS NULL ORDER BY updated_at_ms DESC, id DESC",
        [resolved.org.id],
      );
      const visible: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        const board = parseBoardRow(row);
        const role = yield* effectiveBoardRole(board, pubkey);
        if (role !== null) visible.push({ ...board, role });
      }
      return { org: publicOrgView(resolved.org), boards: visible, total: visible.length };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── GET /orgs/:slug/members — member list (org members only) ────────────
  orgs.get("/orgs/:slug/members", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { org } = yield* authorizeOrgAccess(c.req.param("slug"), callerPubkey(claims), "member");
      const db = yield* Db;
      const rows = yield* db.queryAll<Record<string, unknown>>(
        "SELECT * FROM orgMemberCache WHERE org_id = ? ORDER BY added_at_ms ASC",
        [org.id],
      );
      return { members: rows.map(parseMemberRow) };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── POST /orgs/:slug/members — direct add (admin+) ──────────────────────
  orgs.post("/orgs/:slug/members", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);
      const { org, role: myRole } = yield* authorizeOrgAccess(c.req.param("slug"), pubkey, "admin");

      const memberPubkey = yield* validatePubkey(body["pubkey"]);
      const role = yield* validateOrgRole(body["role"]);
      // Only owners mint owners.
      if (role === "owner" && !roleAtLeast(myRole, "owner")) {
        return yield* new ForbiddenError({ reason: "requires-owner" });
      }
      yield* upsertMembership({
        table: "orgMemberCache",
        scopeId: org.id,
        pubkey: memberPubkey,
        role,
        addedBy: pubkey,
        token,
        grant: { scope: "org", target: org.slug },
      });
      // Org membership projects onto every board — grant the joiner into
      // each of the org's private boards at their current epochs.
      for (const board of yield* privateBoardsOfOrg(org.id)) {
        yield* grantOnJoinBestEffort(board, memberPubkey);
      }
      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "org_member_added",
        actor: claims.login,
        details: { slug: org.slug, pubkey: memberPubkey, role },
      });
      return { added: true, pubkey: memberPubkey, role };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, 201);
  });

  // ── PATCH /orgs/:slug/members/:pubkey — role change (admin+) ────────────
  orgs.patch("/orgs/:slug/members/:pubkey", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);
      const { org, role: myRole } = yield* authorizeOrgAccess(c.req.param("slug"), pubkey, "admin");
      const targetPubkey = c.req.param("pubkey");
      const role = yield* validateOrgRole(body["role"]);

      const db = yield* Db;
      const current = yield* db.queryFirst<{ role: string }>(
        "SELECT role FROM orgMemberCache WHERE org_id = ? AND pubkey = ?",
        [org.id, targetPubkey],
      );
      if (current === null) return yield* new NotFoundError({ reason: "member" });
      // Owner seats move only by owners; and never demote the last owner.
      if ((current.role === "owner" || role === "owner") && !roleAtLeast(myRole, "owner")) {
        return yield* new ForbiddenError({ reason: "requires-owner" });
      }
      if (current.role === "owner" && role !== "owner") {
        const owners = yield* db.queryFirst<{ n: number }>(
          "SELECT COUNT(*) AS n FROM orgMemberCache WHERE org_id = ? AND role = 'owner'",
          [org.id],
        );
        if ((owners?.n ?? 0) <= 1) return yield* new ConflictError({ reason: "last-owner" });
      }
      yield* upsertMembership({
        table: "orgMemberCache",
        scopeId: org.id,
        pubkey: targetPubkey,
        role,
        addedBy: pubkey,
        token,
        grant: { scope: "org", target: org.slug },
      });
      return { pubkey: targetPubkey, role };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── DELETE /orgs/:slug/members/:pubkey — kick (admin+) ──────────────────
  // Removing the org row removes org-projected board access automatically
  // (it's computed); explicit boardMemberCache grants deliberately survive.
  orgs.delete("/orgs/:slug/members/:pubkey", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const pubkey = callerPubkey(claims);
      const { org, role: myRole } = yield* authorizeOrgAccess(c.req.param("slug"), pubkey, "admin");
      const targetPubkey = c.req.param("pubkey");

      const db = yield* Db;
      const current = yield* db.queryFirst<{ role: string }>(
        "SELECT role FROM orgMemberCache WHERE org_id = ? AND pubkey = ?",
        [org.id, targetPubkey],
      );
      if (current === null) return yield* new NotFoundError({ reason: "member" });
      if (current.role === "owner") {
        if (!roleAtLeast(myRole, "owner")) {
          return yield* new ForbiddenError({ reason: "requires-owner" });
        }
        const owners = yield* db.queryFirst<{ n: number }>(
          "SELECT COUNT(*) AS n FROM orgMemberCache WHERE org_id = ? AND role = 'owner'",
          [org.id],
        );
        if ((owners?.n ?? 0) <= 1) return yield* new ConflictError({ reason: "last-owner" });
      }
      // An org kick strips projected access to every org board. For each
      // private board where the target holds NO surviving explicit grant,
      // rotate before the roster shrinks (explicit boardMemberCache rows
      // deliberately survive an org kick — those boards keep their epoch).
      for (const board of yield* privateBoardsOfOrg(org.id)) {
        const explicit = yield* db.queryFirst(
          "SELECT role FROM boardMemberCache WHERE board_id = ? AND pubkey = ?",
          [board.id, targetPubkey],
        );
        if (explicit === null) yield* rotateOnRemoval(board, targetPubkey);
      }
      yield* removeMembership({
        table: "orgMemberCache",
        scopeId: org.id,
        pubkey: targetPubkey,
        token,
      });
      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "org_member_removed",
        actor: claims.login,
        details: { slug: org.slug, pubkey: targetPubkey },
      });
      return { removed: true };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── board members: /orgs/:org_slug/boards/:slug/members ─────────────────

  orgs.get("/orgs/:org_slug/boards/:slug/members", async (c) => {
    const program = Effect.gen(function* () {
      const pubkey = callerPubkeyOrNull(c.get("claims"));
      const { board } = yield* resolveBoardScope(
        { org_slug: c.req.param("org_slug"), slug: c.req.param("slug") },
        pubkey,
        "contributor",
      );
      const db = yield* Db;
      const rows = yield* db.queryAll<Record<string, unknown>>(
        "SELECT * FROM boardMemberCache WHERE board_id = ? ORDER BY added_at_ms ASC",
        [board.id],
      );
      // Private boards: surface each member's current-epoch grant state so
      // the settings page can show "Key grant issued … (epoch n)".
      let grants: Array<{ member_pubkey: string; epoch: number; issued_at_ms: number }> = [];
      if (board.is_encrypted) {
        const grantRows = yield* db.queryAll<{
          member_pubkey: string;
          epoch: number;
          issued_at_ms: number;
        }>(
          "SELECT member_pubkey, epoch, MAX(issued_at_ms) AS issued_at_ms FROM boardMemberKeyGrant WHERE board_id = ? AND epoch = ? AND revoked_at_ms IS NULL GROUP BY member_pubkey",
          [board.id, board.audience_epoch],
        );
        grants = grantRows.map((g) => ({
          member_pubkey: g.member_pubkey,
          epoch: board.audience_epoch,
          issued_at_ms: g.issued_at_ms,
        }));
      }
      return {
        members: rows.map(parseMemberRow),
        ...(board.is_encrypted ? { audience_epoch: board.audience_epoch, key_grants: grants } : {}),
      };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  orgs.post("/orgs/:org_slug/boards/:slug/members", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);
      const orgSlug = c.req.param("org_slug");
      const { board } = yield* resolveBoardScope(
        { org_slug: orgSlug, slug: c.req.param("slug") },
        pubkey,
        "admin",
      );
      const memberPubkey = yield* validatePubkey(body["pubkey"]);
      const role = yield* validateBoardRole(body["role"]);
      yield* upsertMembership({
        table: "boardMemberCache",
        scopeId: board.id,
        pubkey: memberPubkey,
        role,
        addedBy: pubkey,
        token,
        grant: { scope: "board", target: `${orgSlug}/${board.slug}` },
      });
      if (board.is_encrypted) yield* grantOnJoinBestEffort(board, memberPubkey);
      return { added: true, pubkey: memberPubkey, role };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, 201);
  });

  orgs.patch("/orgs/:org_slug/boards/:slug/members/:pubkey", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);
      const orgSlug = c.req.param("org_slug");
      const { board } = yield* resolveBoardScope(
        { org_slug: orgSlug, slug: c.req.param("slug") },
        pubkey,
        "admin",
      );
      const targetPubkey = c.req.param("pubkey");
      const role = yield* validateBoardRole(body["role"]);
      const db = yield* Db;
      const current = yield* db.queryFirst(
        "SELECT role FROM boardMemberCache WHERE board_id = ? AND pubkey = ?",
        [board.id, targetPubkey],
      );
      if (current === null) return yield* new NotFoundError({ reason: "member" });
      yield* upsertMembership({
        table: "boardMemberCache",
        scopeId: board.id,
        pubkey: targetPubkey,
        role,
        addedBy: pubkey,
        token,
        grant: { scope: "board", target: `${orgSlug}/${board.slug}` },
      });
      return { pubkey: targetPubkey, role };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  orgs.delete("/orgs/:org_slug/boards/:slug/members/:pubkey", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const pubkey = callerPubkey(claims);
      const { board } = yield* resolveBoardScope(
        { org_slug: c.req.param("org_slug"), slug: c.req.param("slug") },
        pubkey,
        "admin",
      );
      const targetPubkey = c.req.param("pubkey");
      // Rotate FIRST: if the epoch bump fails, the removal fails with it
      // and stays retryable — a removed member must never keep a live key.
      if (board.is_encrypted) {
        const existing = yield* Db.pipe(
          Effect.flatMap((db) =>
            db.queryFirst("SELECT role FROM boardMemberCache WHERE board_id = ? AND pubkey = ?", [
              board.id,
              targetPubkey,
            ]),
          ),
        );
        if (existing === null) return yield* new NotFoundError({ reason: "member" });
        yield* rotateOnRemoval(board, targetPubkey);
      }
      const result = yield* removeMembership({
        table: "boardMemberCache",
        scopeId: board.id,
        pubkey: targetPubkey,
        token,
      });
      if (!result.removed) return yield* new NotFoundError({ reason: "member" });
      return { removed: true };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  return orgs;
};
