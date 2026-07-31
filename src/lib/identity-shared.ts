// The pure half of the identity vocabulary (EFB-52).
//
// Split out of identity.ts so the shape rules — what counts as a written
// identity reference, and how one normalizes — carry no Worker runtime
// dependency. identity.ts keeps everything that needs a Db: `isRosterMember`
// and friends. Nothing here touches Cloudflare globals, the Effect service
// graph, or D1, and it should stay that way; that is the property that makes
// the module quotable from another program, the same discipline
// `src/durable-objects/board-events.ts` keeps for the SSE wire contract
// (EFB-34).
//
// WHAT THIS MODULE IS NOT: a shared runtime dependency of the web app. The
// client has its own pubkey decoder in `web/src/lib/nostr.ts`, and that is
// DELIBERATE, not drift — see the contract note there before consolidating.
// The two differ in return type AND in strictness, and the difference is
// load-bearing on the sign-in path. This module is import-light so it CAN be
// type-shared later, not because anything imports it across the boundary
// today.
//
// The one import is `nostr-tools/nip19`, a plain npm package rather than a
// runtime capability, which is what keeps this quotable.

import { decode as decodeNip19 } from "nostr-tools/nip19";

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
 *   become two identities for one key — the exact bug EFB-38 closed
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
