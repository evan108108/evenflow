/**
 * Private-board key-grant actions (phase 16.5).
 *
 * EFB-98 split src/routes/audiences.ts in two. The route shell extracts params
 * and runs requireCaller and runJson; everything that decides who may hold a
 * grant lives here.
 *
 * Grants target SESSION pubkeys (sessionKeyRegistrations), looked up by the
 * caller's jwt_hash — never by member identity alone — so a stolen member
 * stand-in string can't fetch another device's ciphertext. That lookup needs
 * the raw bearer, which is why these actions read `input.token`: it is request
 * input belonging to the caller, the same trust domain as `claims`, not
 * ambient server configuration.
 *
 * The two bodies below moved VERBATIM, including the preamble they duplicate.
 * Factoring that shared preamble out is a real improvement and deliberately
 * NOT made here — a mechanical migration that also restructures is one whose
 * diff cannot be read as "this is the same code", and the duplication predates
 * the split.
 */

import { Effect } from "effect";

import { Audience, Db, DbError, hashToken } from "../effects";
import {
  ForbiddenError,
  UnauthorizedError,
  callerPubkey,
  resolveBoardScope,
  type BoardOwnershipError,
} from "../authz";
import { ConflictError, NotFoundError } from "../lib/errors";
import { AudienceKeyError, grantMemberOnJoin } from "../audiences";
import type { ActionInput } from "./types";

interface GrantRow {
  readonly epoch: number;
  readonly grant_ciphertext: string;
  readonly grant_sender_pubkey: string;
  readonly recipient_pubkey: string;
}

export type AudiencesFailure =
  | NotFoundError
  | ConflictError
  | BoardOwnershipError
  | UnauthorizedError
  | ForbiddenError
  | DbError;

/**
 * Services the audience actions need.
 *
 * `Audience` is here because `grantMemberOnJoin` mints the grant ciphertext —
 * the regrant path needs it, and the type says so rather than leaving it to
 * the layer to supply something the signature never asked for.
 */
export type AudienceServices = Db | Audience;

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

/** GET …/board/:slug/key-grant — the caller's current-epoch grant. */
export const getKeyGrant = (
  input: ActionInput,
): Effect.Effect<unknown, AudiencesFailure, AudienceServices> =>
  Effect.gen(function* () {
    const pubkey = callerPubkey(input.claims);
    const { board } = yield* resolveBoardScope(
      { org_slug: input.orgSlug ?? undefined, slug: input.params["slug"] ?? "" },
      pubkey,
      "viewer", input.grants,);
    if (!board.encryption_active) return yield* new NotFoundError({ reason: "not-private" });
    const sessionPub = yield* sessionPubOfCaller(input.token);
    if (sessionPub === null) return yield* new NotFoundError({ reason: "session-key" });
    const db = yield* Db;
    const row = yield* db.queryFirst<GrantRow>(
      "SELECT * FROM boardMemberKeyGrant WHERE board_id = ? AND member_pubkey = ? AND recipient_pubkey = ? AND epoch = ? AND revoked_at_ms IS NULL",
      [board.id, pubkey, sessionPub, board.audience_epoch],
    );
    if (row === null) return yield* new NotFoundError({ reason: "grant" });
    return grantView(board, row);
  });

/**
 * POST …/board/:slug/request-regrant — self-service re-issue after a fresh
 * login (new session keypair) or an epoch rotation. Auto-approved for anyone
 * still holding board access — the same authz the board read path uses.
 */
export const createRegrantRequest = (
  input: ActionInput,
): Effect.Effect<unknown, AudiencesFailure, AudienceServices> =>
  Effect.gen(function* () {
    const pubkey = callerPubkey(input.claims);
    const { board } = yield* resolveBoardScope(
      { org_slug: input.orgSlug ?? undefined, slug: input.params["slug"] ?? "" },
      pubkey,
      "viewer", input.grants,);
    if (!board.encryption_active) return yield* new NotFoundError({ reason: "not-private" });
    const sessionPub = yield* sessionPubOfCaller(input.token);
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
