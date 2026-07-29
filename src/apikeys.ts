// Developer API keys (phase 19) — format, hashing, and claim synthesis.
//
// A key is "evk_" + 43 base64url chars (32 random bytes). The plaintext
// exists exactly once, in the POST /api/v0/keys response; storage keeps
// only sha256(plaintext) plus the display/lookup prefix (first 12 chars).
//
// A verified key authenticates as its OWNER: claims are synthesized from
// the stored owner pubkey (`provider:oauth_id`), so callerPubkey() and
// every authz path behave exactly as they do for a JWT caller. The raw
// evk_ token is useless to the 4a gateway — substrate publishes riding an
// API-key request fall back to the existing deferred-publish path
// (substrate_event_id NULL), which is already best-effort.

import type { Claims } from "./effects";

export const API_KEY_PREFIX = "evk_";

/** First 12 chars of the plaintext ("evk_" + 8) — display + lookup index. */
export const API_KEY_DISPLAY_PREFIX_LEN = 12;

export const API_KEY_NAME_MAX = 60;

/** last_used_at_ms write throttle — at most one bump per key per minute. */
export const API_KEY_LAST_USED_THROTTLE_MS = 60_000;

export const isApiKeyToken = (token: string): boolean => token.startsWith(API_KEY_PREFIX);

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** Mint a fresh plaintext key + its display prefix. */
export const generateApiKey = (): { plaintext: string; prefix: string } => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const plaintext = `${API_KEY_PREFIX}${b64url(bytes)}`;
  return { plaintext, prefix: plaintext.slice(0, API_KEY_DISPLAY_PREFIX_LEN) };
};

export const hashApiKey = async (plaintext: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Claims for a request authenticated by an API key. The owner pubkey is
 * the `provider:oauth_id` composite every cache row stores; login carries
 * the key name for audit-trail readability.
 */
export const claimsForApiKey = (ownerPubkey: string, keyName: string): Claims | null => {
  const split = ownerPubkey.indexOf(":");
  if (split <= 0 || split === ownerPubkey.length - 1) return null;
  return {
    provider: ownerPubkey.slice(0, split),
    oauth_id: ownerPubkey.slice(split + 1),
    login: `key:${keyName}`,
    iat: 0,
    // API keys don't expire on a clock — revocation is the kill switch.
    exp: Number.MAX_SAFE_INTEGER,
  };
};
