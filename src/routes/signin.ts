// /api/v0/signin/nostr — HTTP shell over src/actions/signin.ts (phase 16.7).
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
// WHY THE PROOF CHECK STAYS HERE. NIP-98 signs the HTTP request — its method,
// its URL, and the raw body bytes. That verification cannot be expressed
// without the request, so it fails the doctrine test ("would this exist if we
// weren't serving HTTP?") and stays in the route. What sign-in MEANS — the
// session row, the level-4 key registration, the audit record — is in the
// action.
//
// RULE 10: the JWT_SIGNING_KEY gate stays ABOVE the body read. An
// unconfigured server answering a malformed request has always said 500
// no-signing-key, and parse-first would report that config fault as the
// caller's 400. Preserved directly rather than by deferral, because the raw
// bytes are consumed here for the signature check — there is nothing to defer.

import { Hono } from "hono";
import type { Context } from "hono";
import { Cause, Effect, Exit, Option } from "effect";

import { path } from "../routes-manifest";
import { makeRunJson } from "../lib/run-json";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { defaultNostrLogin } from "../nostr";
import { verifyChallengeEvent, verifyNip98 } from "../lib/audience/nip98-verify";
import { actionInput } from "../actions/types";
import {
  displayNameOf,
  mintNostrChallenge,
  mintNostrJwt,
  mintNostrSession,
  verifyChallenge,
  type SigninFailure,
  type SigninServices,
} from "../actions/signin";

// Mapping preserved byte-for-byte from the pre-split file, with one addition:
// ConfigError carries the 500 `no-signing-key` this router used to answer with
// a bare c.json before the check moved into the challenge action.
const errorResponse = (c: Context<AppHonoEnv>, cause: Cause.Cause<SigninFailure>) => {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    const f = failure.value;
    switch (f._tag) {
      case "ValidationError":
        return c.json({ error: "invalid-body", reason: f.reason }, 400);
      case "ConfigError":
        return c.json({ error: "internal", reason: f.reason }, 500);
      case "DbError":
        return c.json({ error: "internal", reason: `db-${f.reason}` }, 500);
    }
  }
  return c.json({ error: "internal", reason: "defect" }, 500);
};

export const makeSigninRouter = (layerFor: LayerFor = bootstrap) => {
  const signin = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<SigninFailure, SigninServices>(layerFor, errorResponse);

  // ── GET /signin/nostr/challenge?pubkey=<hex64> ──────────────────────────
  signin.get(path("signin.nostr.challenge"), async (c) =>
    runJson(
      c,
      mintNostrChallenge(
        actionInput(null, c.req.param(), undefined, { query: c.req.query() }),
        c.env.JWT_SIGNING_KEY,
      ),
    ),
  );

  // ── POST /signin/nostr — NIP-98 header OR {signed_event, challenge} ─────
  signin.post(path("signin.nostr.verify"), async (c) => {
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

    const exit = await Effect.runPromiseExit(
      Effect.provide(mintNostrSession({ pubkey, login, jwt, claims, nowSeconds }), layerFor(c.env)),
    );
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, 201);
  });

  return signin;
};
