// EFB-52: the client pubkey decoder's TYPE GATE, pinned.
//
// `normalizePubkey` deliberately skips checksum verification (see the
// contract note on the function — the sign-in flow's signature check is the
// real gate). That makes its `startsWith("npub1")` prefix test the ONLY thing
// standing between a pasted `nsec1…` and a decoded pubkey, and a prefix check
// is exactly the kind of line that looks redundant to someone tidying up.
// Before this file it was untested, so dropping it would have been silent.
//
// Mirrors the dangerous-test pattern from EFB-41's server-side
// tests/identity.test.ts.

import { describe, expect, it } from "vitest";
import { normalizePubkey, normalizePrivkey, HEX64_RE } from "./nostr";

const HEX = "049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2";
const NPUB = "npub1qjdk9rzwrr2kycnlmyjda2xadl5c6nwnp98askjnmpxq75sek0pqr3fl3a";

// Same 32 bytes as NPUB above, encoded under a different prefix. If the type
// gate is ever dropped, this decodes to a REAL person's pubkey rather than to
// junk — so the test fails on the harmful case, not merely on a malformed one.
const NOTE1 = "note1qjdk9rzwrr2kycnlmyjda2xadl5c6nwnp98askjnmpxq75sek0pqjm2zg4";

// NIP-19 spec test vector. A PRIVATE key.
const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

describe("normalizePubkey", () => {
  it("accepts bare hex, lowercasing it", () => {
    expect(normalizePubkey(HEX)).toBe(HEX);
    expect(normalizePubkey(HEX.toUpperCase())).toBe(HEX);
    expect(normalizePubkey(`  ${HEX}  `)).toBe(HEX);
  });

  // Baseline. Without it, the rejection cases below cannot distinguish
  // "the gate works" from "this function rejects everything".
  it("decodes a valid npub to the matching hex", () => {
    expect(normalizePubkey(NPUB)).toBe(HEX);
  });

  // THE GATE. Both of these decode to 32 well-formed bytes; only the prefix
  // check keeps them out. The nsec case is the severe one — accepting it
  // would take a pasted private key and hand back the public key it derives,
  // which reads as a successful sign-in rather than as a disclosure.
  it.each([
    ["note1 carrying a real pubkey's bytes", NOTE1],
    ["nsec (private key)", NSEC],
  ])("refuses %s", (_label, code) => {
    expect(normalizePubkey(code)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["not bech32 at all", "hello"],
    ["short hex", "deadbeef"],
    ["wrong-length npub payload", "npub1qqqqqqqqqq"],
  ])("returns null for %s", (_label, input) => {
    expect(normalizePubkey(input)).toBeNull();
  });

  // Documents the deliberate leniency so nobody "fixes" it into strictness
  // without reading why: a bad-checksum npub of the right length still
  // decodes here. It cannot authenticate anyone — the signed-event check
  // downstream is what actually validates the key.
  it("does NOT verify the checksum, by design", () => {
    const tampered = `${NPUB.slice(0, -1)}${NPUB.endsWith("a") ? "c" : "a"}`;
    const out = normalizePubkey(tampered);
    expect(out).not.toBeNull();
    expect(HEX64_RE.test(out!)).toBe(true);
  });
});

describe("normalizePrivkey", () => {
  // The mirror gate: the nsec path must not accept a PUBLIC key spelling,
  // or a paste into the wrong box would be treated as a secret.
  it("accepts nsec and refuses npub", () => {
    expect(normalizePrivkey(NSEC)).not.toBeNull();
    expect(normalizePrivkey(NPUB)).toBeNull();
    expect(normalizePrivkey(NOTE1)).toBeNull();
  });
});
