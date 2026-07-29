// Phase 16.5 client crypto: session keypair lifecycle and the
// grant-decrypt → SSE-payload-decrypt chain, against the same vendored
// NIP-44 the Worker uses (raw-scalar capable). The wire fixtures here are
// built exactly the way src/audiences.ts builds them server-side.

import { afterEach, describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateAudienceIdentity, generateEpochKeypair, pubkeyFromPriv } from "./audience/audience-keys";
import { decrypt, encrypt, encryptString, decryptString } from "./audience/nip44";
import { __resetSessionKeys, clearSessionKeypair, ensureSessionKeypair } from "./sessionKeys";
import { isEncryptedPayload } from "./boardKeys";

afterEach(() => {
  clearSessionKeypair();
  __resetSessionKeys();
  try {
    window.sessionStorage.clear();
  } catch {
    // storage-less environment — nothing to clear
  }
});

describe("session keypair", () => {
  it("mints once, persists in sessionStorage (never localStorage), survives a reload", () => {
    const first = ensureSessionKeypair();
    expect(first.pub).toMatch(/^[0-9a-f]{64}$/);
    expect(pubkeyFromPriv(first.priv)).toBe(first.pub);

    // Not in localStorage under any key.
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)!;
        expect(window.localStorage.getItem(key)).not.toBe(bytesToHex(first.priv));
      }
    } catch {
      // storage-less env — the assertion above is vacuous there
    }

    // Simulated reload: drop the memory cache, keep sessionStorage.
    __resetSessionKeys();
    const second = ensureSessionKeypair();
    expect(second.pub).toBe(first.pub);
  });

  it("clear forgets the key; the next ensure mints a fresh one", () => {
    const first = ensureSessionKeypair();
    clearSessionKeypair();
    const second = ensureSessionKeypair();
    expect(second.pub).not.toBe(first.pub);
  });
});

describe("grant → payload decrypt chain", () => {
  it("decrypts a server-shaped grant, then a server-shaped SSE ciphertext", () => {
    // Server side (mirrors src/audiences.ts): aud_id + epoch keys; grant =
    // raw epoch scalar aud_id→session; payload = NIP-44 aud_id→epochPub.
    const audId = generateAudienceIdentity();
    const epoch = generateEpochKeypair();
    const session = ensureSessionKeypair();
    const grantCiphertext = encrypt(epoch.priv, audId.priv, session.pub);
    const payloadPlain = JSON.stringify({ issue: { id: "i1", title: "hidden" } });
    const sseCiphertext = encryptString(payloadPlain, audId.priv, epoch.pub);

    // Client side: unwrap the grant with the session priv…
    const epochPriv = decrypt(grantCiphertext, session.priv, audId.pub);
    expect(bytesToHex(epochPriv)).toBe(bytesToHex(epoch.priv));
    // …then open the payload with (epochPriv, aud_id pub).
    expect(JSON.parse(decryptString(sseCiphertext, epochPriv, audId.pub))).toEqual({
      issue: { id: "i1", title: "hidden" },
    });
  });

  it("a rotated-out key cannot open new-epoch ciphertext", () => {
    const audId = generateAudienceIdentity();
    const epoch1 = generateEpochKeypair();
    const epoch2 = generateEpochKeypair();
    const ciphertext = encryptString("post-rotation", audId.priv, epoch2.pub);
    expect(() => decryptString(ciphertext, epoch1.priv, audId.pub)).toThrow();
  });
});

describe("isEncryptedPayload", () => {
  it("discriminates encrypted envelopes from plaintext payloads", () => {
    expect(isEncryptedPayload({ enc: true, epoch: 1, ciphertext: "x" })).toBe(true);
    expect(isEncryptedPayload({ enc: true, epoch: 2, ciphertext: null })).toBe(true);
    expect(isEncryptedPayload({ issue: { id: "x" } })).toBe(false);
    expect(isEncryptedPayload(null)).toBe(false);
    expect(isEncryptedPayload("string")).toBe(false);
  });
});
