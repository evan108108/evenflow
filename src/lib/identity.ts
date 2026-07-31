// EFB-38: identity references are resolved values, not arbitrary strings.
//
// A pubkey-shaped FIELD in an app model means "which person is this about".
// That is a reference, and it has exactly one accepted written form. Before
// this module, every write path invented its own rule — `validateAssignee`
// accepted any non-empty string, `validatePubkey` accepted any string under
// 256 chars — so `049b628c…` and `nostr:049b628c…` became two identities for
// one key, and an authenticated caller could assign work to somebody who was
// not on the board at all.
//
// The canonical form is `<provider>:<id>`. The prefix IS the provider, which
// is why the shape rule below is general rather than an allowlist: a new
// sign-in method must not require a code change here. Bare 64-char hex is
// accepted as a legacy spelling of a Nostr key and normalized forward.
//
// NOT everything pubkey-shaped is a reference. Two things in this codebase
// are deliberately raw and must never be routed through here:
//
//   * `inviteCache.bind_to_pubkey` — a raw curve point on purpose. The accept
//     path compares it against `realPubkeyOfMember(callerPubkey)` (nostr.ts),
//     which strips the `nostr:` prefix back to the bare key. That is what
//     makes "OAuth callers can never accept a pubkey-bound invite" true.
//   * `sessionKeyRegistrations.session_pubkey` — an encryption key for a
//     session, not a person.
//
// A NIP-98 or Nostr event's own `pubkey` is likewise data, not a reference:
// it is cryptographically bound to the event and stays raw hex.


import { Effect } from "effect";
import { Db, type DbError } from "../effects";
import { canonicalizeIdentityRef, isNpub, NPUB, type IdentityRef } from "./identity-shared";

// The shape rules live in ./identity-shared (EFB-52) — pure, Worker-runtime
// free. They are re-exported here so this module stays the one import site
// for identity concerns and no call site had to change when they moved.
export { canonicalizeIdentityRef, isNpub, NPUB, type IdentityRef };

/** Rosters an identity reference can be checked against. */
export type RosterTable = "boardMemberCache" | "orgMemberCache";

const SCOPE_COLUMN: Readonly<Record<RosterTable, string>> = {
  boardMemberCache: "board_id",
  orgMemberCache: "org_id",
};

/**
 * Is this reference on the given roster?
 *
 * Reads the membership table directly, and deliberately NOT
 * `effectiveBoardRole`: that floors any pubkey at "viewer" on a public board,
 * so a check built on it would pass for every syntactically valid identity
 * and quietly do nothing. It is also exactly the roster the members endpoint
 * and the UI picker render, which is what keeps the API from accepting an
 * assignee the picker cannot show.
 */
export const isRosterMember = (
  table: RosterTable,
  scopeId: string,
  ref: IdentityRef,
): Effect.Effect<boolean, DbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = yield* db.queryFirst<{ pubkey: string }>(
      `SELECT pubkey FROM ${table} WHERE ${SCOPE_COLUMN[table]} = ? AND pubkey = ?`,
      [scopeId, ref],
    );
    return row !== null;
  });
