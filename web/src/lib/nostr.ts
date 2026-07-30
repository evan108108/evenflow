// Client-side Nostr identity plumbing (phase 16.7) — mirrors the
// vocabulary in src/nostr.ts on the Worker.
//
// Three pieces:
//   * npub / hex pubkey normalization (minimal bech32 decoder — read-only,
//     pubkeys only, no nsec handling on this path).
//   * NIP-07 (window.nostr) detection + typed surface for signEvent and
//     nip44.decrypt.
//   * The OPT-IN "hold my key in this tab" store: sessionStorage at most,
//     cleared on tab close, never localStorage, never sent anywhere.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decryptString } from "./audience/nip44";

export const NOSTR_PROVIDER = "nostr";
export const HEX64_RE = /^[0-9a-f]{64}$/i;

export const nostrMemberPubkey = (hexPubkey: string): string =>
  `${NOSTR_PROVIDER}:${hexPubkey.toLowerCase()}`;

// ── npub decoding (bech32, BIP-173 charset) ───────────────────────────────

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const fromWords = (words: number[]): Uint8Array => {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const word of words) {
    acc = (acc << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
};

/**
 * Accept an npub1… or bare hex pubkey; return lowercase hex64, or null.
 * Checksum is NOT verified — this is input normalization, and the server
 * re-validates the key by verifying a signature made with it.
 */
export const normalizePubkey = (input: string): string | null => {
  const trimmed = input.trim().toLowerCase();
  if (HEX64_RE.test(trimmed)) return trimmed;
  if (!trimmed.startsWith("npub1")) return null;
  const data = trimmed.slice(5, -6); // strip hrp+separator and the 6-char checksum
  const words: number[] = [];
  for (const char of data) {
    const value = BECH32_CHARSET.indexOf(char);
    if (value < 0) return null;
    words.push(value);
  }
  const bytes = fromWords(words);
  return bytes.length === 32 ? bytesToHex(bytes) : null;
};

// ── NIP-07 (window.nostr) ─────────────────────────────────────────────────

export interface Nip07EventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(template: Nip07EventTemplate): Promise<Record<string, unknown>>;
  nip44?: {
    decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  };
}

export const nip07 = (): Nip07Provider | null =>
  (window as { nostr?: Nip07Provider }).nostr ?? null;

// ── opt-in tab-scoped nsec (BIG-warning path) ─────────────────────────────

const NSEC_STORAGE = "evenflow.nostr-tab-key";

const store = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/** Accept nsec1… or hex; return the 32-byte scalar, or null. */
export const normalizePrivkey = (input: string): Uint8Array | null => {
  const trimmed = input.trim().toLowerCase();
  if (HEX64_RE.test(trimmed)) return hexToBytes(trimmed);
  if (!trimmed.startsWith("nsec1")) return null;
  const data = trimmed.slice(5, -6);
  const words: number[] = [];
  for (const char of data) {
    const value = BECH32_CHARSET.indexOf(char);
    if (value < 0) return null;
    words.push(value);
  }
  const bytes = fromWords(words);
  return bytes.length === 32 ? bytes : null;
};

/** Opt-in ONLY: sessionStorage at most, gone when the tab closes. */
export const storeTabKey = (priv: Uint8Array): void => {
  store()?.setItem(NSEC_STORAGE, bytesToHex(priv));
};

export const tabKey = (): Uint8Array | null => {
  const hex = store()?.getItem(NSEC_STORAGE) ?? null;
  return hex !== null && HEX64_RE.test(hex) ? hexToBytes(hex) : null;
};

export const clearTabKey = (): void => {
  store()?.removeItem(NSEC_STORAGE);
};

// ── grant decryption with the REAL key (level-4 read path) ────────────────
//
// Real-pubkey grants seal the epoch scalar as a HEX STRING (UTF-8-safe so
// standard NIP-07 nip44.decrypt round-trips it; see issueGrantsForMember).

/** Decrypt via the opt-in tab key, if present. */
export const decryptGrantWithTabKey = (
  ciphertext: string,
  senderPubkey: string,
): Uint8Array | null => {
  const priv = tabKey();
  if (priv === null) return null;
  try {
    const scalarHex = decryptString(ciphertext, priv, senderPubkey);
    return HEX64_RE.test(scalarHex) ? hexToBytes(scalarHex) : null;
  } catch {
    return null;
  }
};

/** Decrypt via a NIP-07 extension, if present and willing. */
export const decryptGrantWithNip07 = async (
  ciphertext: string,
  senderPubkey: string,
): Promise<Uint8Array | null> => {
  const provider = nip07();
  if (provider?.nip44 === undefined) return null;
  try {
    const scalarHex = await provider.nip44.decrypt(senderPubkey, ciphertext);
    return HEX64_RE.test(scalarHex.trim()) ? hexToBytes(scalarHex.trim()) : null;
  } catch {
    return null;
  }
};
