// Audience identity + per-epoch keypair generators.
//
// Per SPEC-v0.5 §1.2 / v0.5-design.md §1.2, every audience has two keypairs:
//
//   1. aud_id   — long-lived. Signs the kind:30520 declaration. Never rotates.
//                 Its pubkey is what users see when picking a roster.
//   2. aud_epoch_n — short-lived (per-epoch). Distributed via kind:30521
//                    key-grants; rotated on membership change. Holders of the
//                    private key can decrypt audience-addressed messages.
//
// Both are plain secp256k1 keypairs — they are *not* derived from the user's
// KMS-backed identity. Audience keys are audience-scoped, not user-scoped, so
// they're generated fresh by the audience founder's client (or by the gateway
// on the founder's behalf, in custodial flows).
//
// The "x-only Nostr pubkey" convention from BIP-340 / NIP-19 applies: pubkeys
// are 32-byte hex strings (the x-coordinate, even-y normalized).

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

export interface AudienceKeypair {
  /** 32-byte secp256k1 private key. */
  priv: Uint8Array;
  /** 32-byte hex Nostr (BIP-340 x-only) public key. */
  pub: string;
}

/**
 * Generate a fresh secp256k1 keypair from system randomness. The `priv` is
 * 32 bytes; the `pub` is the BIP-340 x-only schnorr pubkey hex-encoded.
 *
 * Falls back to re-rolling on the astronomically unlikely event of a private
 * key not in (0, n) — same shape as kms.ts's `clampToCurveOrder`.
 */
function generateKeypair(): AudienceKeypair {
  for (let attempt = 0; attempt < 4; attempt++) {
    const priv = randomBytes(32);
    if (!secp256k1.utils.isValidSecretKey(priv)) continue;
    const pub = bytesToHex(schnorr.getPublicKey(priv));
    return { priv, pub };
  }
  throw new Error("failed to generate a valid secp256k1 private key after 4 attempts");
}

/**
 * `aud_id` — long-lived audience identity keypair. Signs the audience
 * declaration. The pubkey identifies the audience across all epochs.
 */
export function generateAudienceIdentity(): AudienceKeypair {
  return generateKeypair();
}

/**
 * `aud_epoch_n` — per-epoch audience keypair. Granted to members; rotated on
 * membership change. NIP-44-encryption to `aud_epoch_n_pub` is what makes a
 * payload audience-addressed.
 */
export function generateEpochKeypair(): AudienceKeypair {
  return generateKeypair();
}

/**
 * Derive the BIP-340 x-only pubkey from a raw 32-byte private key. Used when
 * importing an audience key from a key-grant payload (the wire is just bytes;
 * we re-derive the pubkey rather than trust a separate field).
 */
export function pubkeyFromPriv(priv: Uint8Array): string {
  if (priv.length !== 32) throw new Error("private key must be 32 bytes");
  return bytesToHex(schnorr.getPublicKey(priv));
}
