// EFB-38: the shared identity-reference normalizer.
//
// Route-level coverage lives in issues.test.ts and orgs.test.ts; this pins
// the pure function directly, because it is now the single shape rule for
// every pubkey-as-reference field in the API and a change here silently
// changes all of them at once.

import { describe, expect, it } from "vitest";
import { canonicalizeIdentityRef, isNpub } from "../src/lib/identity";

const HEX = "049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2";
const CANON = `nostr:${HEX}`;

describe("canonicalizeIdentityRef", () => {
  it("promotes bare 64-char hex to the nostr provider", () => {
    expect(canonicalizeIdentityRef(HEX)).toBe(CANON);
  });

  // The bug in one assertion: these three spellings are one key, and before
  // EFB-38 they were three different assignees.
  it("collapses every spelling of one key onto a single ref", () => {
    const spellings = [HEX, HEX.toUpperCase(), CANON, `nostr:${HEX.toUpperCase()}`, `  ${HEX}  `];
    expect(new Set(spellings.map(canonicalizeIdentityRef))).toEqual(new Set([CANON]));
  });

  it("passes other providers through unchanged", () => {
    expect(canonicalizeIdentityRef("google:104509077344032735108")).toBe(
      "google:104509077344032735108",
    );
    expect(canonicalizeIdentityRef("github:7")).toBe("github:7");
  });

  // Non-nostr ids are opaque; lowercasing them could collide two real
  // accounts, so only the hex key gets case-folded.
  it("does NOT case-fold a non-nostr provider id", () => {
    expect(canonicalizeIdentityRef("github:AbC_123")).toBe("github:AbC_123");
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["no provider", "not a pubkey"],
    ["provider with no id", "nostr:"],
    ["id with no provider", ":abc"],
    ["short hex", "deadbeef"],
    ["65 hex chars", `${HEX}f`],
    ["hex with a non-hex char", `${HEX.slice(0, 63)}z`],
    ["uppercase provider", "NOSTR:abc"],
    ["spaces inside", "nostr:ab cd"],
    ["not a string", 42],
    ["null", null],
    ["object", { pubkey: HEX }],
  ])("rejects %s", (_label, v) => {
    expect(canonicalizeIdentityRef(v)).toBeNull();
  });

  // EFB-41: bech32 is the spelling a Nostr client shows the user, so it has
  // to land on the same identity as the hex the roster stores — otherwise
  // npub is exactly the "fourth identity for one key" EFB-38 closed.
  //
  // NPUB is Sona's own key (HEX above) encoded, deliberately: it is the one
  // npub in this repo with a canonical counterpart already in the roster, so
  // this assertion is end-to-end and not just round-trip-with-itself.
  const NPUB_SONA = "npub1qjdk9rzwrr2kycnlmyjda2xadl5c6nwnp98askjnmpxq75sek0pqr3fl3a";

  it("decodes a valid npub onto the same ref as the hex spelling", () => {
    expect(canonicalizeIdentityRef(NPUB_SONA)).toBe(CANON);
  });

  it("folds an uppercased npub onto the same ref (bech32 is case-insensitive)", () => {
    expect(canonicalizeIdentityRef(NPUB_SONA.toUpperCase())).toBe(CANON);
  });

  // Still null, still `isNpub` — a bad checksum is malformed input, not an
  // unsupported spelling. This is the pre-EFB-41 sample, kept because its
  // checksum is invalid and the reject is now for the right reason.
  it("rejects an npub whose checksum does not verify", () => {
    const bad = "npub1qy352euf7lxs4h8lpelw9r4vtvrhtnfvxhc4xzn3nlrxq0zj9nqmcqvr7";
    expect(canonicalizeIdentityRef(bad)).toBeNull();
    expect(isNpub(bad)).toBe(true);
  });

  // SECURITY (EFB-41). nip19.decode also accepts nsec/note/nprofile. The
  // `note1…` below encodes the SAME 32 bytes as NPUB_SONA — so an ungated
  // decoder would happily resolve a note id to Sona's identity. And an nsec
  // is a PRIVATE key: decoding one to its public half and storing it would
  // turn a paste mistake into a key disclosure that looks like success.
  // All non-npub types are null, with no reason string that would confirm
  // to a fisher which type they sent.
  it.each([
    ["nsec (private key)", "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5"],
    ["note (same bytes as the npub)", "note1qjdk9rzwrr2kycnlmyjda2xadl5c6nwnp98askjnmpxq75sek0pqjm2zg4"],
    ["nprofile", "nprofile1qqsqfxmz338p34tzvflajfx74rwkl6vdfhfsjn7ctffasnq02gvm8ssnxgy9w"],
  ])("refuses to decode %s", (_label, code) => {
    expect(canonicalizeIdentityRef(code)).toBeNull();
  });

  // Spelling test, not an acceptance test — since EFB-41 an npub IS accepted,
  // so this pins that hex and provider refs are not *spelled* as bech32.
  it("isNpub is false for hex and provider-prefixed refs", () => {
    expect(isNpub(HEX)).toBe(false);
    expect(isNpub(CANON)).toBe(false);
    expect(isNpub("google:1")).toBe(false);
  });

  // Normalizing twice must not move — otherwise a re-save could drift a row
  // to a new identity. npub included: it canonicalizes to hex, and feeding
  // that back must not re-encode or drift.
  it("is idempotent", () => {
    for (const v of [HEX, HEX.toUpperCase(), CANON, NPUB_SONA, "google:104509077344032735108"]) {
      const once = canonicalizeIdentityRef(v)!;
      expect(canonicalizeIdentityRef(once)).toBe(once);
    }
  });
});
