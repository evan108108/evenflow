// NIP-98 HTTP Auth — Worker-side VERIFIER (phase 16.7), the mirror of
// nip98-sign.ts in this directory (and of the 4A gateway's verifier).
//
// Accepts `Authorization: Nostr <base64(json-event)>`: kind 27235, a "u"
// tag matching the request URL exactly, a "method" tag matching the
// request method, an optional "payload" tag equal to sha256(body) —
// REQUIRED whenever the request has a body — created_at within the skew
// window, canonical id recomputed, schnorr signature verified.
//
// Also verifies the kind-22242 challenge event used by the paste-and-sign
// sign-in flow (NIP-42 shape: a ["challenge", …] tag; same id + signature
// discipline, no URL binding — the challenge itself is the binding).

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { CHALLENGE_EVENT_KIND, HEX64_RE, NIP98_SKEW_SECONDS } from "../../nostr";

const NIP98_KIND = 27235;

export interface VerifiedNostrAuth {
  readonly pubkey: string;
}

export interface NostrEventShape {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: ReadonlyArray<ReadonlyArray<string>>;
  readonly content: string;
  readonly sig: string;
}

export type Nip98Failure =
  | "missing-header"
  | "malformed-event"
  | "wrong-kind"
  | "url-mismatch"
  | "method-mismatch"
  | "payload-mismatch"
  | "stale-timestamp"
  | "bad-id"
  | "bad-signature"
  | "bad-pubkey";

const parseEvent = (value: unknown): NostrEventShape | null => {
  if (typeof value !== "object" || value === null) return null;
  const e = value as Record<string, unknown>;
  if (
    typeof e["id"] !== "string" ||
    typeof e["pubkey"] !== "string" ||
    typeof e["created_at"] !== "number" ||
    typeof e["kind"] !== "number" ||
    !Array.isArray(e["tags"]) ||
    typeof e["content"] !== "string" ||
    typeof e["sig"] !== "string"
  ) {
    return null;
  }
  return e as unknown as NostrEventShape;
};

const canonicalId = (event: NostrEventShape): string => {
  const ser = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return bytesToHex(sha256(new TextEncoder().encode(ser)));
};

const tagValue = (event: NostrEventShape, name: string): string | undefined =>
  event.tags.find((t) => t[0] === name)?.[1];

/** Shared discipline: shape, pubkey, canonical id, schnorr signature. */
const verifyEventCore = (event: NostrEventShape): Nip98Failure | null => {
  if (!HEX64_RE.test(event.pubkey.toLowerCase())) return "bad-pubkey";
  if (canonicalId(event) !== event.id) return "bad-id";
  try {
    if (!schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))) {
      return "bad-signature";
    }
  } catch {
    return "bad-signature";
  }
  return null;
};

/**
 * Verify a NIP-98 Authorization header against the request it arrived on.
 * Returns the signer's pubkey, or a typed failure reason.
 */
export const verifyNip98 = async (
  authorizationHeader: string | undefined,
  requestUrl: string,
  requestMethod: string,
  rawBody: Uint8Array | null,
  nowSeconds: number,
): Promise<VerifiedNostrAuth | { error: Nip98Failure }> => {
  if (authorizationHeader === undefined || !authorizationHeader.startsWith("Nostr ")) {
    return { error: "missing-header" };
  }
  let event: NostrEventShape | null = null;
  try {
    event = parseEvent(JSON.parse(atob(authorizationHeader.slice("Nostr ".length).trim())));
  } catch {
    return { error: "malformed-event" };
  }
  if (event === null) return { error: "malformed-event" };
  if (event.kind !== NIP98_KIND) return { error: "wrong-kind" };
  if (tagValue(event, "u") !== requestUrl) return { error: "url-mismatch" };
  if ((tagValue(event, "method") ?? "").toUpperCase() !== requestMethod.toUpperCase()) {
    return { error: "method-mismatch" };
  }
  if (rawBody !== null && rawBody.byteLength > 0) {
    const bodyHash = bytesToHex(sha256(rawBody));
    if (tagValue(event, "payload") !== bodyHash) return { error: "payload-mismatch" };
  }
  if (Math.abs(nowSeconds - event.created_at) > NIP98_SKEW_SECONDS) {
    return { error: "stale-timestamp" };
  }
  const core = verifyEventCore(event);
  if (core !== null) return { error: core };
  return { pubkey: event.pubkey.toLowerCase() };
};

/**
 * Verify a signed kind-22242 challenge event (the paste-and-sign flow).
 * The caller has already validated the challenge string itself (HMAC +
 * TTL); this proves the pasted event signs THAT challenge with the
 * claimed key.
 */
export const verifyChallengeEvent = (
  value: unknown,
  expectedChallenge: string,
  nowSeconds: number,
): VerifiedNostrAuth | { error: Nip98Failure } => {
  const event = parseEvent(value);
  if (event === null) return { error: "malformed-event" };
  if (event.kind !== CHALLENGE_EVENT_KIND) return { error: "wrong-kind" };
  if (tagValue(event, "challenge") !== expectedChallenge) return { error: "payload-mismatch" };
  if (Math.abs(nowSeconds - event.created_at) > NIP98_SKEW_SECONDS) {
    return { error: "stale-timestamp" };
  }
  const core = verifyEventCore(event);
  if (core !== null) return { error: core };
  return { pubkey: event.pubkey.toLowerCase() };
};
