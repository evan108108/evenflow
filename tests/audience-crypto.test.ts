// Phase 16.5: round-trip coverage for the vendored 4a audience crypto
// (src/lib/audience/*). These are the invariants the private-board trust
// story leans on: raw-scalar key grants survive NIP-44, gift-wraps unwrap
// to the exact signed rumor, and the NIP-98 header parses to a verifiable
// kind-27235 event.

import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  generateAudienceIdentity,
  generateEpochKeypair,
  pubkeyFromPriv,
} from "../src/lib/audience/audience-keys";
import { decrypt, encrypt, decryptString, encryptString } from "../src/lib/audience/nip44";
import { unwrap, wrap, KIND_GIFT_WRAP, __signEvent } from "../src/lib/audience/nip17";
import { signNip98 } from "../src/lib/audience/nip98-sign";
import { buildAudienceDeclaration, buildKeyGrant } from "../src/lib/audience/audience-events";

describe("key-grant scalar round-trip (NIP-44 raw bytes)", () => {
  it("encrypts the bare 32-byte epoch scalar and decrypts it bit-exact", () => {
    const audId = generateAudienceIdentity();
    const epoch = generateEpochKeypair();
    const recipient = generateEpochKeypair(); // stands in for a session keypair

    const ciphertext = encrypt(epoch.priv, audId.priv, recipient.pub);
    const decrypted = decrypt(ciphertext, recipient.priv, audId.pub);

    expect(bytesToHex(decrypted)).toBe(bytesToHex(epoch.priv));
    expect(decrypted).toHaveLength(32);
    // The recovered scalar is usable: it derives the epoch pubkey.
    expect(pubkeyFromPriv(decrypted)).toBe(epoch.pub);
  });

  it("string payloads (event ciphertext) round-trip too", () => {
    const a = generateEpochKeypair();
    const b = generateEpochKeypair();
    const payload = JSON.stringify({ kind: "issue.created", title: "Ship 16.5 🚀" });
    expect(decryptString(encryptString(payload, a.priv, b.pub), b.priv, a.pub)).toBe(payload);
  });
});

describe("gift-wrap round-trip (NIP-59)", () => {
  it("wrap → unwrap returns the signed rumor and the wrap is ephemeral-signed", () => {
    const publisher = generateAudienceIdentity();
    const member = generateEpochKeypair();
    // 4A rumors are SIGNED events (unlike vanilla NIP-59) — unwrap verifies.
    const rumor = __signEvent(
      {
        kind: 30556,
        pubkey: publisher.pub,
        created_at: 1_700_000_000,
        tags: [["d", "kb:issue:abc"]],
        content: "ciphertext-goes-here",
      },
      publisher.priv,
    );

    const giftWrap = wrap(rumor, publisher.priv, member.pub);
    expect(giftWrap.kind).toBe(KIND_GIFT_WRAP);
    expect(giftWrap.tags).toEqual([["p", member.pub]]);
    // Ephemeral sender: the wrap must NOT be signed by the publisher.
    expect(giftWrap.pubkey).not.toBe(publisher.pub);

    const unwrapped = unwrap(giftWrap, member.priv);
    expect(unwrapped.rumor.kind).toBe(30556);
    expect(unwrapped.rumor.content).toBe("ciphertext-goes-here");
    expect(unwrapped.publisherPub).toBe(publisher.pub);
  });

  it("a non-recipient cannot unwrap", () => {
    const publisher = generateAudienceIdentity();
    const member = generateEpochKeypair();
    const outsider = generateEpochKeypair();
    const rumor = __signEvent(
      { kind: 30556, pubkey: publisher.pub, created_at: 1_700_000_000, tags: [], content: "x" },
      publisher.priv,
    );
    const giftWrap = wrap(rumor, publisher.priv, member.pub);
    expect(() => unwrap(giftWrap, outsider.priv)).toThrow();
  });
});

describe("NIP-98 signer", () => {
  it("produces a verifiable kind-27235 header with url/method/payload tags", async () => {
    const key = generateAudienceIdentity();
    const body = new TextEncoder().encode(JSON.stringify({ hello: "4a" }));
    const header = await signNip98({
      url: "https://api.4a4.ai/v0/audience/raw/publish-wraps",
      method: "POST",
      body,
      pluginPriv: key.priv,
    });

    expect(header.startsWith("Nostr ")).toBe(true);
    const evt = JSON.parse(atob(header.slice(6))) as {
      kind: number; pubkey: string; tags: string[][]; id: string; sig: string;
    };
    expect(evt.kind).toBe(27235);
    expect(evt.pubkey).toBe(key.pub);
    const tag = (name: string) => evt.tags.find((t) => t[0] === name)?.[1];
    expect(tag("u")).toBe("https://api.4a4.ai/v0/audience/raw/publish-wraps");
    expect(tag("method")).toBe("POST");
    expect(tag("payload")).toBe(bytesToHex(sha256(body)));
    expect(schnorr.verify(hexToBytes(evt.sig), hexToBytes(evt.id), hexToBytes(evt.pubkey))).toBe(true);
  });
});

describe("audience event builders", () => {
  it("declaration carries epoch, epoch-pubkey, and one p-tag per member", () => {
    const epoch = generateEpochKeypair();
    const m1 = generateEpochKeypair();
    const m2 = generateEpochKeypair();
    const audId = generateAudienceIdentity();
    const tpl = buildAudienceDeclaration({
      audIdPub: audId.pub,
      slug: "kb-board",
      name: "KB board",
      epoch: 3,
      epochPub: epoch.pub,
      members: [m1.pub, m2.pub],
    });
    const tag = (name: string) => tpl.tags.filter((t) => t[0] === name);
    expect(tpl.kind).toBe(30520);
    expect(tag("d")[0]?.[1]).toBe("kb-board");
    expect(tag("fa:epoch")[0]?.[1]).toBe("3");
    expect(tag("fa:epoch-pubkey")[0]?.[1]).toBe(epoch.pub);
    expect(tag("p").map((t) => t[1])).toEqual([m1.pub, m2.pub]);
    expect(JSON.parse(tpl.content)).toMatchObject({ "@type": "Audience", epoch: 3 });
  });

  it("key grant d-tag is slug:epoch:recipient and epoch tag matches", () => {
    const audId = generateAudienceIdentity();
    const recipient = generateEpochKeypair();
    const tpl = buildKeyGrant({
      audIdPub: audId.pub,
      slug: "kb-board",
      epoch: 3,
      recipientPub: recipient.pub,
      ciphertext: "AmNpcGhlcg==",
    });
    expect(tpl.kind).toBe(30521);
    const tag = (name: string) => tpl.tags.find((t) => t[0] === name)?.[1];
    expect(tag("d")).toBe(`kb-board:3:${recipient.pub}`);
    expect(tag("fa:epoch")).toBe("3");
    expect(tag("p")).toBe(recipient.pub);
    expect(tag("a")).toBe(`30520:${audId.pub}:kb-board`);
    expect(tpl.content).toBe("AmNpcGhlcg==");
  });
});
