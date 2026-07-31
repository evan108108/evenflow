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
import { decode as decodeNip19 } from "nostr-tools/nip19";
import { Db, type DbError } from "../effects";

/**
 * A normalized identity reference: `<provider>:<id>`.
 *
 * This is a SHAPE guarantee and nothing more — it does NOT promise the
 * referent exists, or that they are a member of anything. Compose with
 * `isRosterMember` wherever existence actually matters. A deliberate plain
 * alias rather than a branded type: the enforcement point is the handful of
 * write paths, and branding would force casts across every read path that
 * pulls a pubkey out of D1 for no additional safety there.
 */
export type IdentityRef = string;

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * `<provider>:<id>`. Deliberately general — an allowlist of nostr/google/
 * github would reject every future provider until someone edited this file,
 * and a typo'd provider is caught one layer later by the membership check
 * rather than silently stored.
 */
const PROVIDER_REF = /^[a-z0-9]+:[A-Za-z0-9_-]+$/;

/** Bech32-encoded Nostr pubkey. The spelling `npub1…`, decoded by EFB-41. */
export const NPUB = /^npub1[02-9ac-hj-np-z]+$/i;

const NOSTR_PROVIDER = "nostr";

/**
 * Decode a bech32 `npub1…` to bare lowercase hex, or null.
 *
 * MUST stay gated on `type === "npub"`. `nip19.decode` also accepts `nsec`
 * — a PRIVATE key — as well as `nprofile`, `note`, `naddr` and friends. A
 * caller who pastes their nsec where a pubkey belongs must not have it
 * silently decoded to the matching public key and stored as an identity:
 * that turns a fat-finger into a private-key disclosure, and it would look
 * like success. Every non-npub type is either a secret or a different
 * entity class, so all of them are null here.
 *
 * Null rather than a distinct error for the same reason the rest of this
 * module returns null: callers raise their own typed 400. It is also why
 * there is no "you sent an nsec" reason string — that would confirm to
 * someone fishing that a given string decodes as a secret key.
 *
 * Lowercased before decoding so an all-caps npub folds to the same identity
 * (bech32 is case-insensitive); the checksum is still enforced by decode, so
 * this widens accepted spelling, never accepted keys.
 */
const decodeNpub = (v: string): string | null => {
  try {
    const { type, data } = decodeNip19(v.toLowerCase());
    if (type !== "npub" || typeof data !== "string" || !HEX64.test(data)) return null;
    return data.toLowerCase();
  } catch {
    // Invalid checksum, bad length, illegal character — not a key we can use.
    return null;
  }
};

/**
 * Normalize a written identity reference, or null when it is not one.
 *
 * - bare 64-char hex (any case) → `nostr:<lowercase hex>`
 * - `nostr:<hex>` → lowercased, so `nostr:ABC…` and `nostr:abc…` cannot
 *   become two identities for one key — the exact bug this ticket closes
 * - `npub1…` bech32 (any case) → decoded to `nostr:<lowercase hex>` (EFB-41),
 *   so the spelling a Nostr client shows the user resolves to the same
 *   identity as the hex the roster stores. Invalid checksum → null.
 * - any other `<provider>:<id>` → passed through unchanged, because provider
 *   ids are opaque and case can be significant in them
 * - anything else → null
 *
 * Returns null rather than throwing so callers can raise their own typed
 * failure in the Effect channel; an exception here would escape the error
 * type and land as a 500 instead of the 400 this is.
 */
export const canonicalizeIdentityRef = (v: unknown): IdentityRef | null => {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "") return null;
  if (HEX64.test(trimmed)) return `${NOSTR_PROVIDER}:${trimmed.toLowerCase()}`;
  // Before the generic shape check: an npub carries no ":" and would other-
  // wise fall out as an unrecognized shape. Gated on the NPUB regex so that
  // `nsec1…`/`nprofile1…` never reach the decoder at all — belt and braces
  // with decodeNpub's own type check.
  if (NPUB.test(trimmed)) {
    const hex = decodeNpub(trimmed);
    return hex === null ? null : `${NOSTR_PROVIDER}:${hex}`;
  }
  if (!PROVIDER_REF.test(trimmed)) return null;
  const sep = trimmed.indexOf(":");
  const provider = trimmed.slice(0, sep);
  const id = trimmed.slice(sep + 1);
  // Only the Nostr id is a hex key whose case is meaningless. Other providers
  // hand out opaque ids where case may matter, so they pass through as given.
  if (provider === NOSTR_PROVIDER && HEX64.test(id)) {
    return `${NOSTR_PROVIDER}:${id.toLowerCase()}`;
  }
  return trimmed;
};

/**
 * True when the value is spelled as a bech32 npub.
 *
 * SHAPE ONLY — says nothing about whether it decodes. Since EFB-41 an npub
 * that passes the checksum is canonicalized like any other reference, so
 * this is no longer a reason to reject anything; callers that used it as an
 * "unsupported" gate were removed with that change. Kept because it is a
 * genuine spelling test (the members UI uses it to decide how to display a
 * key), and a shape check is not the same as a validity check.
 */
export const isNpub = (v: unknown): boolean => typeof v === "string" && NPUB.test(v.trim());

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
