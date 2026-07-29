// Server-side storage keypair + NIP-44 credential unwrap (phase 18b).
//
// Trust model (locked, Evan-approved): BYO-S3 credentials are encrypted BY
// THE CLIENT to the Evenflow SERVER's static pubkey — NOT to the org
// audience, so creds are never readable by org members. The server keypair
// derives from EVENFLOW_STORAGE_SECRET (32-byte hex Worker secret) — a
// DIFFERENT secret from EVENFLOW_BLOSSOM_SECRET on purpose: no key reuse
// across schnorr signing and ECDH.
//
// The client has no long-lived secp256k1 key (login pubkeys are OAuth
// stand-ins until KMS lands), so it encrypts with an EPHEMERAL sender
// keypair, ECIES-style: NIP-44 v2 payload + the ephemeral sender pubkey
// travel together, and the server ECDHs its privkey with the sender pubkey
// to derive the conversation key at upload time. Plaintext creds exist only
// inside a single request's memory.

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import { decrypt, getConversationKey } from "nostr-tools/nip44";

const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

export interface ServerStorageKeys {
  readonly privkey: Uint8Array;
  /** x-only hex pubkey (Nostr convention) — what /api/v0/server-pubkey serves. */
  readonly pubkeyHex: string;
}

/** Derive the static server storage keypair; null when the secret is absent/malformed. */
export const deriveServerStorageKeys = (secretHex: string | undefined): ServerStorageKeys | null => {
  if (secretHex === undefined || !HEX_32_BYTES.test(secretHex)) return null;
  const privkey = hexToBytes(secretHex);
  return { privkey, pubkeyHex: bytesToHex(schnorr.getPublicKey(privkey)) };
};

export interface S3Credentials {
  readonly access_key_id: string;
  readonly secret_access_key: string;
}

/**
 * Unwrap a NIP-44 v2 credentials payload encrypted to the server pubkey by
 * an ephemeral sender. Returns null on any failure — bad sender pubkey, MAC
 * mismatch, or a plaintext that isn't the expected credentials JSON — so
 * callers map to one typed error without leaking crypto specifics.
 */
export const decryptS3Creds = (
  keys: ServerStorageKeys,
  ciphertext: string,
  senderPubkeyHex: string,
): S3Credentials | null => {
  if (!HEX_32_BYTES.test(senderPubkeyHex)) return null;
  try {
    const conversationKey = getConversationKey(keys.privkey, senderPubkeyHex);
    const plaintext = decrypt(ciphertext, conversationKey);
    conversationKey.fill(0);
    const parsed = JSON.parse(plaintext) as Record<string, unknown>;
    if (
      typeof parsed["access_key_id"] !== "string" ||
      parsed["access_key_id"] === "" ||
      typeof parsed["secret_access_key"] !== "string" ||
      parsed["secret_access_key"] === ""
    ) {
      return null;
    }
    return {
      access_key_id: parsed["access_key_id"],
      secret_access_key: parsed["secret_access_key"],
    };
  } catch {
    return null;
  }
};
