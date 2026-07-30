// /api/v0/invites — invite lifecycle: create, resolve (anonymous preview),
// accept, decline, revoke, email, and per-scope pending lists.
//
// inviteCache is D1-authoritative (invites are Evenflow config, not
// substrate events); the substrate sees only the RESULT of acceptance — a
// kind-30521 key-grant published through membership.upsertMembership.
//
// GET /invites/:code is deliberately anonymous: the preview page renders
// before sign-in (per spec). It discloses inviter, target, and role for a
// code the caller already possesses — the code IS the capability.

import { Hono } from "hono";
import { Clock, Effect, Exit } from "effect";
import { AuditLog, Db, Email, bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import {
  ForbiddenError,
  authorizeOrgAccess,
  callerPubkey,
  requireCaller,
  resolveBoardScope,
  resolveOrgBySlug,
} from "../authz";
import { upsertMembership } from "../membership";
import { parseBoardRow, parseInviteRow, parseOrgRow, type InviteShape } from "../shapes";
import {
  BOARD_ROLES,
  INVITE_CODE_PREFIX,
  INVITE_CODE_RANDOM_LEN,
  INVITE_DEFAULT_EXPIRES_HOURS,
  INVITE_MAX_EXPIRES_HOURS,
  INVITE_RATE_LIMIT_PER_DAY,
  ORG_ROLES,
} from "../roles";
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  errorResponse,
  readJsonBody,
} from "./errors";

const PUBLIC_BASE_URL = "https://evenflow.work";
const DAY_MS = 24 * 60 * 60 * 1000;

/** inv-a1b2c3d4 — lowercase base36, crypto-random. */
const generateInviteCode = (): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_CODE_RANDOM_LEN));
  let random = "";
  for (const b of bytes) random += alphabet[b % alphabet.length];
  return `${INVITE_CODE_PREFIX}${random}`;
};

type InviteState = "valid" | "expired" | "revoked" | "declined" | "used";

const inviteState = (invite: InviteShape, now: number): InviteState => {
  if (invite.revoked_at_ms !== null) return "revoked";
  if (invite.declined_at_ms !== null) return "declined";
  if (invite.single_use && invite.used_by !== null) return "used";
  if (invite.expires_at_ms < now) return "expired";
  return "valid";
};

export const makeInvitesRouter = (layerFor: LayerFor = bootstrap) => {
  const invites = new Hono<AppHonoEnv>();

  // Shared: load an invite + prove the caller administers its scope.
  const loadInviteForAdmin = (idOrCode: { id?: string; code?: string }, pubkey: string) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const row =
        idOrCode.id !== undefined
          ? yield* db.queryFirst<Record<string, unknown>>(
              "SELECT * FROM inviteCache WHERE id = ?",
              [idOrCode.id],
            )
          : yield* db.queryFirst<Record<string, unknown>>(
              "SELECT * FROM inviteCache WHERE code = ?",
              [idOrCode.code ?? ""],
            );
      if (row === null) return yield* new NotFoundError({ reason: "invite" });
      const invite = parseInviteRow(row);
      const orgRow = yield* db.queryFirst<Record<string, unknown>>(
        "SELECT * FROM orgCache WHERE id = ? AND deleted_at_ms IS NULL",
        [invite.org_id],
      );
      if (orgRow === null) return yield* new NotFoundError({ reason: "invite" });
      const org = parseOrgRow(orgRow);
      if (invite.board_id !== null) {
        const boardRow = yield* db.queryFirst<Record<string, unknown>>(
          "SELECT * FROM boardCache WHERE id = ?",
          [invite.board_id],
        );
        if (boardRow === null) return yield* new NotFoundError({ reason: "invite" });
        const board = parseBoardRow(boardRow);
        yield* resolveBoardScope({ org_slug: org.slug, slug: board.slug }, pubkey, "admin");
        return { invite, org, board };
      }
      yield* authorizeOrgAccess(org.slug, pubkey, "admin");
      return { invite, org, board: null };
    });

  // ── POST /invites — create ──────────────────────────────────────────────
  invites.post("/invites", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);

      const orgSlug = body["org_slug"];
      if (typeof orgSlug !== "string" || orgSlug === "") {
        return yield* new ValidationError({ reason: "org_slug" });
      }
      const boardSlug = body["board_slug"];
      if (boardSlug !== undefined && (typeof boardSlug !== "string" || boardSlug === "")) {
        return yield* new ValidationError({ reason: "board_slug" });
      }
      const role = body["role"];
      const allowedRoles: ReadonlyArray<string> =
        boardSlug === undefined ? ORG_ROLES : BOARD_ROLES;
      if (typeof role !== "string" || !allowedRoles.includes(role) || role === "owner") {
        return yield* new ValidationError({ reason: "role" });
      }
      const invitedEmail = body["invited_email"];
      if (invitedEmail !== undefined && (typeof invitedEmail !== "string" || !invitedEmail.includes("@"))) {
        return yield* new ValidationError({ reason: "invited_email" });
      }
      const bindToEmail = body["bind_to_email"] === true;
      if (bindToEmail && invitedEmail === undefined) {
        return yield* new ValidationError({ reason: "bind_to_email-needs-invited_email" });
      }
      // Bind to a specific Nostr pubkey (64-hex lowercase). Only the caller
      // whose JWT pubkey equals this may accept — pre-issued invites for
      // AI-agent identities can't be raced by a human who trips on the URL.
      const bindToPubkeyRaw = body["bind_to_pubkey"];
      let bindToPubkey: string | null = null;
      if (bindToPubkeyRaw !== undefined && bindToPubkeyRaw !== null) {
        if (typeof bindToPubkeyRaw !== "string" || !/^[0-9a-f]{64}$/.test(bindToPubkeyRaw)) {
          return yield* new ValidationError({ reason: "bind_to_pubkey" });
        }
        bindToPubkey = bindToPubkeyRaw;
      }
      let expiresHours = INVITE_DEFAULT_EXPIRES_HOURS;
      if (body["expires_hours"] !== undefined) {
        const n = body["expires_hours"];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > INVITE_MAX_EXPIRES_HOURS) {
          return yield* new ValidationError({ reason: "expires_hours" });
        }
        expiresHours = n;
      }
      const singleUse = body["single_use"] === undefined ? true : body["single_use"] === true;

      // Authorize against the tightest scope the invite grants into.
      let boardId: string | null = null;
      let orgId: string;
      if (boardSlug !== undefined) {
        const { board, org } = yield* resolveBoardScope(
          { org_slug: orgSlug, slug: boardSlug },
          pubkey,
          "admin",
        );
        boardId = board.id;
        orgId = org?.id ?? board.org_id ?? "";
        if (orgId === "") return yield* new NotFoundError({ reason: "org" });
      } else {
        const { org } = yield* authorizeOrgAccess(orgSlug, pubkey, "admin");
        orgId = org.id;
      }

      const db = yield* Db;
      const now = yield* Clock.currentTimeMillis;
      const recent = yield* db.queryFirst<{ n: number }>(
        "SELECT COUNT(*) AS n FROM inviteCache WHERE invited_by = ? AND org_id = ? AND (board_id IS ? OR board_id = ?) AND created_at_ms > ?",
        [pubkey, orgId, boardId, boardId, now - DAY_MS],
      );
      if ((recent?.n ?? 0) >= INVITE_RATE_LIMIT_PER_DAY) {
        return yield* new RateLimitError({ reason: "invite-daily-limit" });
      }

      const id = crypto.randomUUID();
      const code = generateInviteCode();
      yield* db.execute(
        "INSERT INTO inviteCache (id, code, org_id, board_id, role, invited_by, invited_email, bind_to_email, bind_to_pubkey, expires_at_ms, single_use, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          code,
          orgId,
          boardId,
          role,
          pubkey,
          invitedEmail ?? null,
          bindToEmail ? 1 : 0,
          bindToPubkey,
          now + expiresHours * 60 * 60 * 1000,
          singleUse ? 1 : 0,
          now,
        ],
      );
      const invite = parseInviteRow(
        yield* db.queryFirst<Record<string, unknown>>("SELECT * FROM inviteCache WHERE id = ?", [id]),
      );
      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "invite_created",
        actor: claims.login,
        details: { code, org_slug: orgSlug, board_slug: boardSlug ?? null, role },
      });
      return { invite, url: `${PUBLIC_BASE_URL}/i/${code}` };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, 201);
  });

  // ── GET /invites/:code — anonymous preview resolve ──────────────────────
  invites.get("/invites/:code", async (c) => {
    const program = Effect.gen(function* () {
      const db = yield* Db;
      const row = yield* db.queryFirst<Record<string, unknown>>(
        "SELECT * FROM inviteCache WHERE code = ?",
        [c.req.param("code")],
      );
      if (row === null) return yield* new NotFoundError({ reason: "invite" });
      const invite = parseInviteRow(row);
      const now = yield* Clock.currentTimeMillis;
      const state = inviteState(invite, now);

      const orgRow = yield* db.queryFirst<Record<string, unknown>>(
        "SELECT * FROM orgCache WHERE id = ? AND deleted_at_ms IS NULL",
        [invite.org_id],
      );
      if (orgRow === null) return yield* new NotFoundError({ reason: "invite" });
      const org = parseOrgRow(orgRow);

      let board: { slug: string; title: string } | null = null;
      if (invite.board_id !== null) {
        const boardRow = yield* db.queryFirst<Record<string, unknown>>(
          "SELECT * FROM boardCache WHERE id = ?",
          [invite.board_id],
        );
        if (boardRow !== null) {
          const parsed = parseBoardRow(boardRow);
          board = { slug: parsed.slug, title: parsed.title };
        }
      }

      const inviterProfile = yield* db.queryFirst<{
        name: string | null;
        display_name: string | null;
        picture: string | null;
      }>(
        "SELECT name, display_name, picture FROM profileCache WHERE pubkey = ?",
        [invite.invited_by],
      );

      return {
        code: invite.code,
        org: { slug: org.slug, display_name: org.display_name, avatar_url: org.avatar_url },
        board,
        role: invite.role,
        invited_by_profile: {
          pubkey: invite.invited_by,
          name: inviterProfile?.name ?? null,
          display_name: inviterProfile?.display_name ?? null,
          picture: inviterProfile?.picture ?? null,
        },
        expires_at_ms: invite.expires_at_ms,
        bind_to_email: invite.bind_to_email,
        valid: state === "valid",
        ...(state === "valid" ? {} : { reason: state }),
      };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── POST /invites/:code/accept ──────────────────────────────────────────
  invites.post("/invites/:code/accept", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const pubkey = callerPubkey(claims);
      const db = yield* Db;
      const row = yield* db.queryFirst<Record<string, unknown>>(
        "SELECT * FROM inviteCache WHERE code = ?",
        [c.req.param("code")],
      );
      if (row === null) return yield* new NotFoundError({ reason: "invite" });
      const invite = parseInviteRow(row);
      const now = yield* Clock.currentTimeMillis;
      const state = inviteState(invite, now);
      if (state !== "valid") return yield* new ConflictError({ reason: `invite-${state}` });
      if (
        invite.bind_to_email &&
        (invite.invited_email === null ||
          claims.login.toLowerCase() !== invite.invited_email.toLowerCase())
      ) {
        return yield* new ForbiddenError({ reason: "invite-bound-to-other-email" });
      }
      // Pubkey binding: only the exact identity the invite was pre-issued
      // for can accept. The JWT's pubkey claim is authoritative; anonymous
      // callers never get past requireCaller above, so pubkey is always set
      // by the time we reach here.
      if (invite.bind_to_pubkey !== null && pubkey !== invite.bind_to_pubkey) {
        return yield* new ForbiddenError({ reason: "invite-bound-to-other-pubkey" });
      }

      // Single-use race: exactly one accept claims the row. RETURNING makes
      // the claim atomic — the loser sees null and 409s.
      if (invite.single_use) {
        const claimed = yield* db.queryFirst<{ id: string }>(
          "UPDATE inviteCache SET used_by = ?, used_at_ms = ? WHERE id = ? AND used_by IS NULL RETURNING id",
          [pubkey, now, invite.id],
        );
        if (claimed === null) return yield* new ConflictError({ reason: "invite-used" });
      } else {
        yield* db.execute("UPDATE inviteCache SET used_by = ?, used_at_ms = ? WHERE id = ?", [
          pubkey,
          now,
          invite.id,
        ]);
      }

      const orgRow = yield* db.queryFirst<Record<string, unknown>>(
        "SELECT * FROM orgCache WHERE id = ? AND deleted_at_ms IS NULL",
        [invite.org_id],
      );
      if (orgRow === null) return yield* new NotFoundError({ reason: "invite" });
      const org = parseOrgRow(orgRow);

      let targetUrl = `/@${org.slug}`;
      if (invite.board_id !== null) {
        const boardRow = yield* db.queryFirst<Record<string, unknown>>(
          "SELECT * FROM boardCache WHERE id = ?",
          [invite.board_id],
        );
        if (boardRow === null) return yield* new NotFoundError({ reason: "invite" });
        const board = parseBoardRow(boardRow);
        yield* upsertMembership({
          table: "boardMemberCache",
          scopeId: board.id,
          pubkey,
          role: invite.role,
          addedBy: invite.invited_by,
          token,
          grant: { scope: "board", target: `${org.slug}/${board.slug}` },
        });
        targetUrl = `/@${org.slug}/${board.slug}`;
      } else {
        yield* upsertMembership({
          table: "orgMemberCache",
          scopeId: org.id,
          pubkey,
          role: invite.role,
          addedBy: invite.invited_by,
          token,
          grant: { scope: "org", target: org.slug },
        });
      }
      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "invite_accepted",
        actor: claims.login,
        details: { code: invite.code, target: targetUrl },
      });
      return { accepted: true, target_url: targetUrl, role: invite.role };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── POST /invites/:code/decline ─────────────────────────────────────────
  invites.post("/invites/:code/decline", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const db = yield* Db;
      const row = yield* db.queryFirst<Record<string, unknown>>(
        "SELECT * FROM inviteCache WHERE code = ?",
        [c.req.param("code")],
      );
      if (row === null) return yield* new NotFoundError({ reason: "invite" });
      const invite = parseInviteRow(row);
      const now = yield* Clock.currentTimeMillis;
      const state = inviteState(invite, now);
      if (state !== "valid") return yield* new ConflictError({ reason: `invite-${state}` });
      yield* db.execute("UPDATE inviteCache SET declined_at_ms = ? WHERE id = ?", [now, invite.id]);
      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "invite_declined",
        actor: claims.login,
        details: { code: invite.code },
      });
      return { declined: true };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── POST /invites/:id/email — send the invite by mail ───────────────────
  invites.post("/invites/:id/email", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const { invite, org, board } = yield* loadInviteForAdmin(
        { id: c.req.param("id") },
        pubkey,
      );
      if (invite.invited_email === null) {
        return yield* new ValidationError({ reason: "invite-has-no-email" });
      }
      const now = yield* Clock.currentTimeMillis;
      const state = inviteState(invite, now);
      if (state !== "valid") return yield* new ConflictError({ reason: `invite-${state}` });

      const db = yield* Db;
      const inviterProfile = yield* db.queryFirst<{ display_name: string | null; name: string | null }>(
        "SELECT display_name, name FROM profileCache WHERE pubkey = ?",
        [invite.invited_by],
      );
      const inviter =
        inviterProfile?.display_name || inviterProfile?.name || claims.login.split("@")[0] || "Someone";
      const target = board === null ? `@${org.slug}` : `@${org.slug}/${board.slug}`;
      const targetName = board === null ? org.display_name : board.title;
      const url = `${PUBLIC_BASE_URL}/i/${invite.code}`;
      const days = Math.max(1, Math.round((invite.expires_at_ms - now) / DAY_MS));

      const email = yield* Email;
      yield* email.send({
        to: invite.invited_email,
        subject: `[Evenflow] ${inviter} invited you to ${target}`,
        text: `${inviter} invited you to join ${targetName} (${target}) on Evenflow as ${invite.role}.\n\nAccept or decline: ${url}\n\nThis invite expires in ${days} day${days === 1 ? "" : "s"}.\n\n— Evenflow · The Even Flow of Work`,
        html: [
          `<div style="max-width:520px;margin:0 auto;padding:32px 24px;background:#f5f2ec;color:#17233b;font-family:Georgia,'Times New Roman',serif;">`,
          `<h1 style="font-size:28px;font-weight:700;margin:0 0 24px;">Evenflow</h1>`,
          `<p style="font-size:16px;line-height:1.6;margin:0 0 16px;"><strong>${inviter}</strong> invited you to join <strong>${targetName}</strong> (${target}) as <strong>${invite.role}</strong>.</p>`,
          `<p style="margin:24px 0;"><a href="${url}" style="display:inline-block;padding:12px 28px;background:#17233b;color:#f5f2ec;text-decoration:none;font-size:15px;">View invitation</a></p>`,
          `<p style="font-size:13px;color:#5a6478;margin:24px 0 0;">This invite expires in ${days} day${days === 1 ? "" : "s"}. If you weren't expecting it, you can ignore this email.</p>`,
          `<p style="font-size:13px;color:#5a6478;margin:8px 0 0;">— Evenflow · <em>The Even Flow of Work</em></p>`,
          `</div>`,
        ].join(""),
      });
      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "invite_emailed",
        actor: claims.login,
        details: { code: invite.code, to: invite.invited_email },
      });
      return { sent: true, to: invite.invited_email };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── DELETE /invites/:id — revoke ────────────────────────────────────────
  invites.delete("/invites/:id", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { invite } = yield* loadInviteForAdmin({ id: c.req.param("id") }, callerPubkey(claims));
      if (invite.revoked_at_ms !== null) return { revoked: true };
      const db = yield* Db;
      const now = yield* Clock.currentTimeMillis;
      yield* db.execute("UPDATE inviteCache SET revoked_at_ms = ? WHERE id = ?", [now, invite.id]);
      const audit = yield* AuditLog;
      yield* audit.record({
        event_type: "invite_revoked",
        actor: claims.login,
        details: { code: invite.code },
      });
      return { revoked: true };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── pending lists ───────────────────────────────────────────────────────

  const pendingInvites = (orgId: string, boardId: string | null) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* db.queryAll<Record<string, unknown>>(
        "SELECT * FROM inviteCache WHERE org_id = ? AND (board_id IS ? OR board_id = ?) AND revoked_at_ms IS NULL AND declined_at_ms IS NULL AND expires_at_ms > ? AND (single_use = 0 OR used_by IS NULL) ORDER BY created_at_ms DESC",
        [orgId, boardId, boardId, now],
      );
      return rows.map(parseInviteRow);
    });

  invites.get("/orgs/:slug/invites", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { org } = yield* authorizeOrgAccess(c.req.param("slug"), callerPubkey(claims), "admin");
      return { invites: yield* pendingInvites(org.id, null) };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  invites.get("/orgs/:org_slug/boards/:slug/invites", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const { board, org } = yield* resolveBoardScope(
        { org_slug: c.req.param("org_slug"), slug: c.req.param("slug") },
        callerPubkey(claims),
        "admin",
      );
      const orgId = org?.id ?? board.org_id;
      if (orgId === null) return yield* new NotFoundError({ reason: "org" });
      return { invites: yield* pendingInvites(orgId, board.id) };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  return invites;
};
