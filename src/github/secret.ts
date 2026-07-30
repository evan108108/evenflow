// Per-board webhook secret: minting, sealing at rest, and HMAC verification.
//
// Trust story (Evan-approved, replaces the briefing's "Sonata secret ref" —
// a Cloudflare Worker has no reachable external secret store):
//
//   The SERVER mints the secret and shows the plaintext EXACTLY ONCE, at
//   create/rotate. The operator pastes it into GitHub's webhook form. D1
//   stores only AES-GCM ciphertext, sealed under EVENFLOW_WEBHOOK_SECRET —
//   a third distinct Worker secret. No key reuse across primitives:
//     EVENFLOW_BLOSSOM_SECRET  → schnorr signing (BUD-01)
//     EVENFLOW_STORAGE_SECRET  → ECDH / NIP-44 (18b BYO-S3 creds)
//     EVENFLOW_WEBHOOK_SECRET  → symmetric AES-GCM (this file)
//
// Unlike an API key (0008), this secret cannot be a one-way hash: HMAC
// verification needs the shared secret back in plaintext on every delivery.
// Reversible-at-rest is therefore the requirement, not a shortcut.

const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

/** GitHub sends `sha256=<hex>` in x-hub-signature-256. */
const SIGNATURE_PREFIX = "sha256=";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (s: string): Uint8Array | null => {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
};

const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A fresh per-board webhook secret: 32 random bytes, hex. Shown once, then
 * only ever the ciphertext. Hex (not base64url) because the operator pastes
 * it into GitHub's form by hand and hex survives a careless double-click.
 */
export const mintWebhookSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
};

const importAesKey = async (masterHex: string): Promise<CryptoKey | null> => {
  if (!HEX_32_BYTES.test(masterHex)) return null;
  const raw = hexToBytes(masterHex);
  if (raw === null) return null;
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
};

/**
 * Seal a plaintext secret for D1. Format `<iv-b64url>.<ciphertext-b64url>`,
 * fresh 12-byte IV per call. Returns null when the master key is missing or
 * malformed — callers surface that as a config error rather than storing
 * something they cannot read back.
 */
export const sealWebhookSecret = async (
  masterHex: string | undefined,
  plaintext: string,
): Promise<string | null> => {
  if (masterHex === undefined) return null;
  const key = await importAesKey(masterHex);
  if (key === null) return null;
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
};

/** Unseal a stored secret. Null on any failure — bad key, bad format, bad MAC. */
export const openWebhookSecret = async (
  masterHex: string | undefined,
  sealed: string | null,
): Promise<string | null> => {
  if (masterHex === undefined || sealed === null) return null;
  const key = await importAesKey(masterHex);
  if (key === null) return null;
  const [ivPart, ctPart] = sealed.split(".");
  if (ivPart === undefined || ctPart === undefined) return null;
  const iv = fromBase64Url(ivPart);
  const ct = fromBase64Url(ctPart);
  if (iv === null || ct === null) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return decoder.decode(plain);
  } catch {
    return null;
  }
};

/**
 * Verify GitHub's x-hub-signature-256 over the RAW request body.
 *
 * Constant-time by construction: rather than hex-comparing two digests in
 * JS (which short-circuits on the first differing byte and leaks the prefix
 * an attacker has guessed), this hands both the signature and the body to
 * crypto.subtle.verify, whose comparison is constant-time.
 *
 * The body MUST be the exact bytes GitHub signed — re-serializing parsed
 * JSON changes whitespace and key order and fails every time.
 */
export const verifyGithubSignature = async (
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
): Promise<boolean> => {
  if (typeof signatureHeader !== "string" || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const sigBytes = hexToBytes(signatureHeader.slice(SIGNATURE_PREFIX.length));
  // SHA-256 digests are 32 bytes; a wrong length can never verify.
  if (sigBytes === null || sigBytes.length !== 32) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(rawBody));
};

/** Sign a body the way GitHub would — test helper + the settings "send test ping". */
export const signGithubBody = async (secret: string, rawBody: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return `${SIGNATURE_PREFIX}${bytesToHex(new Uint8Array(sig))}`;
};
