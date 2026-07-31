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

  // bech32 is a real Nostr spelling we simply don't decode yet. Rejected
  // rather than stored, so it can't become a fourth identity for one key.
  it("rejects npub bech32, which callers should be told is unsupported", () => {
    const npub = "npub1qy352euf7lxs4h8lpelw9r4vtvrhtnfvxhc4xzn3nlrxq0zj9nqmcqvr7";
    expect(canonicalizeIdentityRef(npub)).toBeNull();
    expect(isNpub(npub)).toBe(true);
  });

  it("isNpub is false for the forms we do accept", () => {
    expect(isNpub(HEX)).toBe(false);
    expect(isNpub(CANON)).toBe(false);
    expect(isNpub("google:1")).toBe(false);
  });

  // Normalizing twice must not move — otherwise a re-save could drift a row
  // to a new identity.
  it("is idempotent", () => {
    for (const v of [HEX, HEX.toUpperCase(), CANON, "google:104509077344032735108"]) {
      const once = canonicalizeIdentityRef(v)!;
      expect(canonicalizeIdentityRef(once)).toBe(once);
    }
  });
});
