// /api/v0/signin/nostr — key-based sign-in (phase 16.7).
//
// Two proof shapes, one outcome:
//   * NIP-98 (agents, NIP-07 extensions): `Authorization: Nostr <b64>`
//     signing THIS request — the smooth path; Sona signs in exactly the
//     way it joins Studio rooms.
//   * Challenge + paste (keyless-browser humans): GET …/challenge mints a
//     STATELESS challenge (ts.pubkey.hmac under JWT_SIGNING_KEY — no D1
//     table, replay-bounded by the TTL + single JWT mint being
//     idempotent), the user signs a kind-22242 event externally (nak,
//     nsec.app) and POSTs it back.
//
// On success Evenflow mints its own HS256 JWT (same JWT_SIGNING_KEY the
// 4a AS uses, so the existing verifier accepts it unchanged):
//   provider "nostr", oauth_id = the real pubkey, sub = the real pubkey
//   (explicitly NOT a provider:oauth_id composite), login =
//   display_name | "nostr-<hex8>".
//
// The mint ALSO writes the sessionCache row (pubkey column = the real
// curve point — no KMS derivation, the caller brought their own key) and
// registers the real pubkey in sessionKeyRegistrations with
// session_key_source='nostr'. That single registration is what makes
// private-board grants level-4 for these callers: the grant recipient is
// their own key, and only their own key decrypts.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { AuditLog, Db, DbError, bootstrap, hashToken } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import {
  CHALLENGE_TTL_SECONDS,
  HEX64_RE,
  NOSTR_JWT_TTL_SECONDS,
  NOSTR_PROVIDER,
  defaultNostrLogin,
  nostrMemberPubkey,
} from "../nostr";
import { verifyChallengeEvent, verifyNip98 } from "../lib/audience/nip98-verify";

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
class UnauthorizedError extends Data.TaggedError("UnauthorizedError")<{
  readonly reason: string;
}> {}

type SigninFailure = ValidationError | UnauthorizedError | DbError;

const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<SigninFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "UnauthorizedError":
        return c.json({ error: "unauthorized", reason: f.reason }, 401);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

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
const mintNostrJwt = async (
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

const verifyChallenge = async (
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

const displayNameOf = (body: Record<string, unknown> | null): string | null => {
  const value = body?.["display_name"];
  return typeof value === "string" && value.trim() !== "" && value.length <= 60
    ? value.trim()
    : null;
};

export const makeSigninRouter = (layerFor: LayerFor = bootstrap) => {
  const signin = new Hono<AppHonoEnv>();

  // ── GET /signin/nostr/challenge?pubkey=<hex64> ──────────────────────────
  signin.get("/signin/nostr/challenge", async (c) => {
    const signingKey = c.env.JWT_SIGNING_KEY;
    if (signingKey === undefined || signingKey === "") {
      return c.json({ error: "internal", reason: "no-signing-key" }, 500);
    }
    const pubkey = (c.req.query("pubkey") ?? "").toLowerCase();
    if (!HEX64_RE.test(pubkey)) {
      return c.json({ error: "invalid-body", reason: "pubkey" }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const challenge = await buildChallenge(signingKey, pubkey, now);
    return c.json({
      challenge,
      expires_in: CHALLENGE_TTL_SECONDS,
      sign_hint: `nak event -k 22242 -t challenge='${challenge}' --sec <your-nsec>`,
    });
  });

  // ── POST /signin/nostr — NIP-98 header OR {signed_event, challenge} ─────
  signin.post("/signin/nostr", async (c) => {
    const signingKey = c.env.JWT_SIGNING_KEY;
    if (signingKey === undefined || signingKey === "") {
      return c.json({ error: "internal", reason: "no-signing-key" }, 500);
    }
    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    let body: Record<string, unknown> | null = null;
    if (rawBody.byteLength > 0) {
      try {
        body = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
      } catch {
        return c.json({ error: "invalid-body", reason: "expected-json" }, 400);
      }
    }
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Proof 1: NIP-98 over this request. Proof 2: signed challenge event.
    let pubkey: string | null = null;
    let failure = "missing-proof";
    const authHeader = c.req.header("Authorization");
    if (authHeader !== undefined && authHeader.startsWith("Nostr ")) {
      const verified = await verifyNip98(authHeader, c.req.url, c.req.method, rawBody, nowSeconds);
      if ("pubkey" in verified) pubkey = verified.pubkey;
      else failure = `nip98-${verified.error}`;
    } else if (body !== null && body["signed_event"] !== undefined) {
      const challenge = typeof body["challenge"] === "string" ? body["challenge"] : "";
      const challengePubkey = await verifyChallenge(signingKey, challenge, nowSeconds);
      if (challengePubkey === null) {
        failure = "challenge-invalid";
      } else {
        const verified = verifyChallengeEvent(body["signed_event"], challenge, nowSeconds);
        if ("pubkey" in verified) {
          if (verified.pubkey === challengePubkey) pubkey = verified.pubkey;
          else failure = "challenge-pubkey-mismatch";
        } else {
          failure = `challenge-${verified.error}`;
        }
      }
    }
    if (pubkey === null) {
      return c.json({ error: "unauthorized", reason: failure }, 401);
    }

    const login = displayNameOf(body) ?? defaultNostrLogin(pubkey);
    const { jwt, claims } = await mintNostrJwt(signingKey, pubkey, login, nowSeconds);

    const program = Effect.gen(function* () {
      const db = yield* Db;
      const audit = yield* AuditLog;
      const now = yield* Clock.currentTimeMillis;
      const hash = yield* hashToken(jwt);
      const expiresAtMs = (nowSeconds + NOSTR_JWT_TTL_SECONDS) * 1000;
      // sessionCache.pubkey = the real curve point: the caller brought
      // their own key, no gateway derivation involved.
      yield* db.execute(
        "INSERT OR REPLACE INTO sessionCache (jwt_hash, pubkey, provider, oauth_id, expires_at_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?)",
        [hash, pubkey, NOSTR_PROVIDER, pubkey, expiresAtMs, now],
      );
      // The level-4 registration: this session's key IS the member's real
      // key, marked 'nostr' so /session/register-key can't downgrade it.
      yield* db.execute(
        "INSERT OR REPLACE INTO sessionKeyRegistrations (jwt_hash, member_pubkey, session_pubkey, created_at_ms, expires_at_ms, session_key_source) VALUES (?, ?, ?, ?, ?, 'nostr')",
        [hash, nostrMemberPubkey(pubkey), pubkey, now, expiresAtMs],
      );
      yield* audit.record({
        event_type: "nostr_signin",
        actor: login,
        details: { pubkey },
      });
      return { jwt, claims };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, 201);
  });

  return signin;
};
