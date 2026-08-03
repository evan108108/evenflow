/**
 * Nostr sign-in actions (phase 16.7).
 *
 * EFB-98 split src/routes/signin.ts along the line the doctrine draws: an
 * action is business logic with the HTTP taken out. Minting a challenge and
 * minting a session both survive that test. Verifying the PROOF does not —
 * NIP-98 signs the HTTP request itself (method, URL, and the raw body bytes),
 * so that verification is inseparable from the request and stays in the route.
 *
 * RULE 10, AND WHY THERE IS NO DEFERRED BODY HERE. `signin.nostr.verify`
 * gates on JWT_SIGNING_KEY (500 no-signing-key) BEFORE it reads the body
 * (400 expected-json), so an unconfigured server answering a malformed
 * request must keep saying 500 — a config fault must not be reported as the
 * caller's fault. The usual fix is to hand the action an unrun body Effect,
 * but that is not available here: the ROUTE itself consumes the raw bytes to
 * check the signature over them. So the order is preserved the direct way —
 * the gate stays above the read, both in the route — and the deferral
 * machinery would buy nothing. Rule 10 is preserve; deferral is only one of
 * the ways to preserve.
 *
 * `signingKey` arrives as an explicit parameter rather than on ActionInput:
 * it is ambient server configuration, not something the caller sent.
 */

import { Clock, Data, Effect } from "effect";

import { AuditLog, Db, DbError, hashToken } from "../effects";
import {
  CHALLENGE_TTL_SECONDS,
  HEX64_RE,
  NOSTR_JWT_TTL_SECONDS,
  NOSTR_PROVIDER,
  nostrMemberPubkey,
} from "../nostr";
import type { PublicActionInput } from "./types";

// ── crypto helpers ────────────────────────────────────────────────────────
//
// These moved with the logic that uses them. They pass the doctrine test on
// their own — HMAC-ing a challenge and minting an HS256 JWT would exist
// whether or not anything was being served over HTTP — and leaving them
// behind would have split a challenge's construction from its verification
// across two files.

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const hmacHex = async (key: string, message: string): Promise<string> => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
};

/** Mint the HS256 JWT (same scheme + key as the 4a AS, so Jwt.verify accepts it). */
export const mintNostrJwt = async (
  signingKey: string,
  pubkey: string,
  login: string,
  nowSeconds: number,
): Promise<{ jwt: string; claims: Record<string, unknown> }> => {
  const claims = {
    provider: NOSTR_PROVIDER,
    oauth_id: pubkey,
    sub: pubkey, // the real curve point — deliberately not a composite
    login,
    iat: nowSeconds,
    exp: nowSeconds + NOSTR_JWT_TTL_SECONDS,
  };
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return { jwt: `${header}.${payload}.${b64url(new Uint8Array(sig))}`, claims };
};

/** ts.pubkey.hmac16 — stateless, verifiable, TTL-bounded. */
const buildChallenge = async (signingKey: string, pubkey: string, nowSeconds: number): Promise<string> => {
  const mac = await hmacHex(signingKey, `nostr-challenge:${nowSeconds}:${pubkey}`);
  return `${nowSeconds}.${pubkey}.${mac.slice(0, 32)}`;
};

export const verifyChallenge = async (
  signingKey: string,
  challenge: string,
  nowSeconds: number,
): Promise<string | null> => {
  const [tsRaw, pubkey, mac] = challenge.split(".");
  if (tsRaw === undefined || pubkey === undefined || mac === undefined) return null;
  const ts = Number(tsRaw);
  if (!Number.isInteger(ts) || nowSeconds - ts > CHALLENGE_TTL_SECONDS || ts > nowSeconds + 60) {
    return null;
  }
  if (!HEX64_RE.test(pubkey)) return null;
  const expected = (await hmacHex(signingKey, `nostr-challenge:${ts}:${pubkey}`)).slice(0, 32);
  return mac === expected ? pubkey : null;
};

export const displayNameOf = (body: Record<string, unknown> | null): string | null => {
  const value = body?.["display_name"];
  return typeof value === "string" && value.trim() !== "" && value.length <= 60
    ? value.trim()
    : null;
};

/**
 * The server cannot answer because it is misconfigured, not because the
 * caller got anything wrong. Distinct from every other failure in this file
 * so the route can keep answering 500 `no-signing-key` rather than folding it
 * into a 400.
 */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly reason: string;
}> {}
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}

export type SigninFailure = ConfigError | ValidationError | DbError;

/** Services the session mint needs. The challenge mint needs none. */
export type SigninServices = Db | AuditLog;

/**
 * GET /signin/nostr/challenge?pubkey=<hex64>.
 *
 * A STATELESS challenge (ts.pubkey.hmac under JWT_SIGNING_KEY — no D1 table,
 * replay-bounded by the TTL plus the single JWT mint being idempotent).
 *
 * The two checks are in the pre-split order: missing signing key answers 500
 * before a malformed pubkey answers 400.
 */
export const mintNostrChallenge = (
  input: PublicActionInput,
  signingKey: string | undefined,
): Effect.Effect<unknown, SigninFailure, never> =>
  Effect.gen(function* () {
    if (signingKey === undefined || signingKey === "") {
      return yield* new ConfigError({ reason: "no-signing-key" });
    }
    const pubkey = (input.query["pubkey"] ?? "").toLowerCase();
    if (!HEX64_RE.test(pubkey)) {
      return yield* new ValidationError({ reason: "pubkey" });
    }
    const now = Math.floor(Date.now() / 1000);
    const challenge = yield* Effect.promise(() => buildChallenge(signingKey, pubkey, now));
    return {
      challenge,
      expires_in: CHALLENGE_TTL_SECONDS,
      sign_hint: `nak event -k 22242 -t challenge='${challenge}' --sec <your-nsec>`,
    };
  });

/**
 * The session half of POST /signin/nostr, once a proof has been accepted.
 *
 * Everything above this — which proof shape was offered, whether it verified,
 * and the JWT mint that depends on the signing key — is the route's, because
 * it is about this HTTP request. What is left is what sign-in MEANS: a
 * session row, a level-4 key registration, and an audit record.
 */
export const mintNostrSession = (verified: {
  readonly pubkey: string;
  readonly login: string;
  readonly jwt: string;
  readonly claims: unknown;
  readonly nowSeconds: number;
}): Effect.Effect<unknown, SigninFailure, SigninServices> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const audit = yield* AuditLog;
    const now = yield* Clock.currentTimeMillis;
    const hash = yield* hashToken(verified.jwt);
    const expiresAtMs = (verified.nowSeconds + NOSTR_JWT_TTL_SECONDS) * 1000;
    // sessionCache.pubkey = the real curve point: the caller brought
    // their own key, no gateway derivation involved.
    yield* db.execute(
      "INSERT OR REPLACE INTO sessionCache (jwt_hash, pubkey, provider, oauth_id, expires_at_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?)",
      [hash, verified.pubkey, NOSTR_PROVIDER, verified.pubkey, expiresAtMs, now],
    );
    // The level-4 registration: this session's key IS the member's real
    // key, marked 'nostr' so /session/register-key can't downgrade it.
    yield* db.execute(
      "INSERT OR REPLACE INTO sessionKeyRegistrations (jwt_hash, member_pubkey, session_pubkey, created_at_ms, expires_at_ms, session_key_source) VALUES (?, ?, ?, ?, ?, 'nostr')",
      [hash, nostrMemberPubkey(verified.pubkey), verified.pubkey, now, expiresAtMs],
    );
    yield* audit.record({
      event_type: "nostr_signin",
      actor: verified.login,
      details: { pubkey: verified.pubkey },
    });
    return { jwt: verified.jwt, claims: verified.claims };
  });
