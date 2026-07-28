// Shared authorization helpers for /api/v0 routers.
//
// MVP trust model: the board owner is the only member, so "may act on this
// board/issue" reduces to "the caller's pubkey owns the board". Membership
// (audience-declaration lookup) replaces these checks in a later phase.

import { Data, Effect } from "effect";
import { Db, type DbError, type Claims } from "./effects";
import { parseBoardRow, type BoardShape } from "./shapes";

// TODO(kms-backfill): provider-qualified stand-in, not a Nostr pubkey.
// Provider-qualified because a bare oauth_id collides across providers
// ("123" on Google vs GitHub); this is exactly the tuple KMS derives real
// pubkeys from, so the backfill is a pure re-derivation.
export const callerPubkey = (claims: Claims): string =>
  `${claims.provider}:${claims.oauth_id}`;

/**
 * Caller does not own such a board. Deliberately indistinguishable from
 * "board does not exist" (404, not 403) — existence of other people's
 * boards must not leak.
 */
export class BoardOwnershipError extends Data.TaggedError("BoardOwnershipError")<{
  readonly reason: "board";
}> {}

/** Fetch the caller's board by slug or fail 404-shaped. */
export const assertOwnBoard = (
  slug: string,
  pubkey: string,
): Effect.Effect<BoardShape, BoardOwnershipError | DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst(
      "SELECT * FROM boardCache WHERE pubkey = ? AND slug = ?",
      [pubkey, slug],
    );
    if (row === null) return yield* new BoardOwnershipError({ reason: "board" });
    return parseBoardRow(row);
  });
