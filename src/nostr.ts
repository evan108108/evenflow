// Nostr identity vocabulary (phase 16.7).
//
// Nostr-signed-in callers keep the composite `provider:oauth_id` stand-in
// convention everywhere authz reads member identity — "nostr:<hex64>" —
// so every membership/role/board path works unchanged. The REAL curve
// point is recoverable from the composite, and that is what private-board
// key grants address (level-4: only the member's own key decrypts).
//
// Mirrored in spirit at web/src/lib/nostr.ts (client adds npub decoding +
// NIP-07 plumbing); keep the constants in lockstep.

export const NOSTR_PROVIDER = "nostr";

export const HEX64_RE = /^[0-9a-f]{64}$/;

/** NIP-98 created_at acceptance window (spec suggests 60s; brief says 5m). */
export const NIP98_SKEW_SECONDS = 300;

/** Challenge validity for the paste-and-sign flow. */
export const CHALLENGE_TTL_SECONDS = 300;

/** Nostr-minted JWT lifetime. Re-auth is one signature, so keep it short-ish. */
export const NOSTR_JWT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The kind-22242 (NIP-42-shaped) client-auth event the paste flow signs. */
export const CHALLENGE_EVENT_KIND = 22242;

/** Compose the member stand-in for a real pubkey. */
export const nostrMemberPubkey = (hexPubkey: string): string =>
  `${NOSTR_PROVIDER}:${hexPubkey.toLowerCase()}`;

/** The real curve point behind a member stand-in, or null for OAuth members. */
export const realPubkeyOfMember = (memberPubkey: string): string | null => {
  if (!memberPubkey.startsWith(`${NOSTR_PROVIDER}:`)) return null;
  const hex = memberPubkey.slice(NOSTR_PROVIDER.length + 1).toLowerCase();
  return HEX64_RE.test(hex) ? hex : null;
};

/** Default display login: "nostr-1a2b3c4d". Overridable at sign-in. */
export const defaultNostrLogin = (hexPubkey: string): string =>
  `nostr-${hexPubkey.slice(0, 8)}`;
