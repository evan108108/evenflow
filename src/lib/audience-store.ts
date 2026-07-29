// At-rest sealing for private-board audience key material (phase 16.5).
//
// Trust model: the board's aud_id and per-epoch private scalars live in D1
// only as NIP-44 v2 ciphertext to the server's audience keypair, which
// derives from EVENFLOW_AUDIENCE_SECRET — a separate Worker secret from
// both EVENFLOW_BLOSSOM_SECRET (schnorr signing) and
// EVENFLOW_STORAGE_SECRET (BYO-S3 creds): no key reuse across contexts.
// The sealed payload is the BARE 32-byte scalar (the same wire convention
// as kind-30521 grants), so this uses the vendored raw-byte NIP-44 from
// src/lib/audience — nostr-tools' nip44 cannot round-trip raw scalars.
//
// Seal = ECIES-style with a throwaway sender keypair, mirroring how 18b
// clients encrypt S3 creds: ciphertext + ephemeral sender pub travel
// together; the server opens with ECDH(serverPriv, senderPub).

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import { decrypt } from "./audience/nip44";

const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

export interface ServerAudienceKeys {
  readonly privkey: Uint8Array;
  /** x-only hex pubkey (Nostr convention). */
  readonly pubkeyHex: string;
}

/** Derive the static server audience keypair; null when the secret is absent/malformed. */
export const deriveServerAudienceKeys = (
  secretHex: string | undefined,
): ServerAudienceKeys | null => {
  if (secretHex === undefined || !HEX_32_BYTES.test(secretHex)) return null;
  const privkey = hexToBytes(secretHex);
  return { privkey, pubkeyHex: bytesToHex(schnorr.getPublicKey(privkey)) };
};

/** Open a sealed scalar; null on any failure (bad sender pub, MAC mismatch, wrong length). */
export const openScalarFromServer = (
  keys: ServerAudienceKeys,
  ciphertext: string,
  senderPubkeyHex: string,
): Uint8Array | null => {
  if (!HEX_32_BYTES.test(senderPubkeyHex)) return null;
  try {
    const scalar = decrypt(ciphertext, keys.privkey, senderPubkeyHex);
    return scalar.length === 32 ? scalar : null;
  } catch {
    return null;
  }
};
