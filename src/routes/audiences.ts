// /api/v0 private-board key grants (phase 16.5).
//
// GET  …/boards/:slug/key-grant       — the caller's current-epoch grant
//                                       for THIS session's registered key.
// POST …/boards/:slug/request-regrant — self-service re-issue after a
//                                       fresh login (new session keypair)
//                                       or an epoch rotation. Auto-approved
//                                       for anyone still holding board
//                                       access — the same authz the board
//                                       read path uses.
//
// Grants target SESSION pubkeys (sessionKeyRegistrations), looked up by
// the caller's jwt_hash — never by member identity alone — so a stolen
// member stand-in string can't fetch another device's ciphertext.

import { Hono } from "hono";
import { Effect, Exit } from "effect";
import { Db, bootstrap, hashToken } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { callerPubkey, requireCaller, resolveBoardScope } from "../authz";
import { ConflictError, NotFoundError, errorResponse } from "./errors";
import { AudienceKeyError, grantMemberOnJoin } from "../audiences";

interface GrantRow {
  readonly epoch: number;
  readonly grant_ciphertext: string;
  readonly grant_sender_pubkey: string;
  readonly recipient_pubkey: string;
}

export const makeAudiencesRouter = (layerFor: LayerFor = bootstrap) => {
  const audiences = new Hono<AppHonoEnv>();

  const grantView = (board: { audience_pubkey: string | null }, row: GrantRow) => ({
    grant: {
      epoch: row.epoch,
      grant_ciphertext: row.grant_ciphertext,
      grant_sender_pubkey: row.grant_sender_pubkey,
      session_pubkey: row.recipient_pubkey,
      audience_pubkey: board.audience_pubkey,
    },
  });

  /** The caller's registered session pub for THIS jwt, or null. */
  const sessionPubOfCaller = (token: string) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const jwtHash = yield* hashToken(token);
      const row = yield* db.queryFirst<{ session_pubkey: string }>(
        "SELECT session_pubkey FROM sessionKeyRegistrations WHERE jwt_hash = ?",
        [jwtHash],
      );
      return row?.session_pubkey ?? null;
    });

  audiences.get("/boards/:slug/key-grant", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const { board } = yield* resolveBoardScope(
        { org_slug: c.req.param("org_slug"), slug: c.req.param("slug") },
        pubkey,
        "viewer",
      );
      if (!board.is_encrypted) return yield* new NotFoundError({ reason: "not-private" });
      const sessionPub = yield* sessionPubOfCaller(c.get("token") ?? "");
      if (sessionPub === null) return yield* new NotFoundError({ reason: "session-key" });
      const db = yield* Db;
      const row = yield* db.queryFirst<GrantRow>(
        "SELECT * FROM boardMemberKeyGrant WHERE board_id = ? AND member_pubkey = ? AND recipient_pubkey = ? AND epoch = ? AND revoked_at_ms IS NULL",
        [board.id, pubkey, sessionPub, board.audience_epoch],
      );
      if (row === null) return yield* new NotFoundError({ reason: "grant" });
      return grantView(board, row);
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  audiences.post("/boards/:slug/request-regrant", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const pubkey = callerPubkey(claims);
      const { board } = yield* resolveBoardScope(
        { org_slug: c.req.param("org_slug"), slug: c.req.param("slug") },
        pubkey,
        "viewer",
      );
      if (!board.is_encrypted) return yield* new NotFoundError({ reason: "not-private" });
      const sessionPub = yield* sessionPubOfCaller(c.get("token") ?? "");
      if (sessionPub === null) return yield* new NotFoundError({ reason: "session-key" });
      yield* grantMemberOnJoin(board, pubkey).pipe(
        Effect.mapError((e) =>
          e instanceof AudienceKeyError
            ? new ConflictError({ reason: `audience-${e.reason}` })
            : e,
        ),
      );
      const db = yield* Db;
      const row = yield* db.queryFirst<GrantRow>(
        "SELECT * FROM boardMemberKeyGrant WHERE board_id = ? AND member_pubkey = ? AND recipient_pubkey = ? AND epoch = ? AND revoked_at_ms IS NULL",
        [board.id, pubkey, sessionPub, board.audience_epoch],
      );
      if (row === null) return yield* new NotFoundError({ reason: "grant" });
      return grantView(board, row);
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, 201);
  });

  return audiences;
};
