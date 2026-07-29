// /auth — session + identity endpoints.
//
// The OAuth flow itself lives on 4a's AS (api.4a4.ai/auth/*): it talks to
// Google/GitHub and mints the HS256 JWT. We run the authorization-code flow
// as a registered client (DCR, RFC 7591): /auth/oauth/start sends the user
// to 4a with client_id + PKCE, 4a redirects back to /auth/callback with a
// code, and we exchange it server-side for the JWT. We never store the raw
// JWT, only its sha256 hex (sessionCache.jwt_hash).

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { Cause, Clock, Effect, Exit, Option } from "effect";
import {
  AuditLog,
  Db,
  Jwt,
  KmsClient,
  bootstrap,
  hashToken,
} from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { requireAuth } from "../middleware/requireAuth";

const PROVIDERS = ["google", "github"] as const;
const BEARER_PREFIX = "Bearer ";

// Registered on 4a via Dynamic Client Registration (2026-07-28). The
// client_id is a public identifier (a signed blob 4a validates itself);
// the matching client_secret lives in the OAUTH_CLIENT_SECRET_4A secret.
const OAUTH_CLIENT_ID_4A =
  "dcr1_eyJ2IjoxLCJzaCI6InBLYkk2WGMyUDlyVGVKU1FLaHJXV1g1b05QYzhzS0VkRldPMnU2aXQyb28iLCJydXMiOlsiaHR0cHM6Ly9ldmVuZmxvdy53b3JrL2F1dGgvY2FsbGJhY2siXSwibiI6IkV2ZW5mbG93IiwiaWF0IjoxNzg1MjgzMzE5fQ.w59L9yjiUdS-bjsTNFo7o0TMuAY8XGsIWLKN9WCyKs4";
const OAUTH_REDIRECT_URI = "https://evenflow.work/auth/callback";
const OAUTH_TOKEN_URL = "https://api.4a4.ai/auth/token";
const PKCE_COOKIE = "pkce_verifier";
const STATE_COOKIE = "oauth_state";
const OAUTH_COOKIE_TTL_SECONDS = 600;

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const sha256B64url = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return b64url(new Uint8Array(digest));
};

const oauthCookie = (name: string, value: string, maxAge = OAUTH_COOKIE_TTL_SECONDS): string =>
  `${name}=${value}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const makeAuthRouter = (layerFor: LayerFor = bootstrap) => {
  const auth = new Hono<AppHonoEnv>();

  // Verified identity of the caller, plus their KMS-derived pubkey once the
  // KMS client is wired. Until then pubkey is null (audited, not fatal).
  auth.get("/whoami", requireAuth(layerFor), async (c) => {
    const claims = c.get("claims");
    const program = Effect.gen(function* () {
      const kms = yield* KmsClient;
      const audit = yield* AuditLog;
      const pubkey = yield* kms.derivePubkey(claims.provider, claims.oauth_id).pipe(
        Effect.catchAll((err) =>
          audit
            .record({
              event_type: "kms_not_wired",
              actor: claims.login,
              details: { reason: err.reason },
            })
            .pipe(Effect.as(null)),
        ),
      );
      return { claims, pubkey };
    });
    return c.json(await Effect.runPromise(Effect.provide(program, layerFor(c.env))));
  });

  // Exchange a 4a-minted JWT for a cached session row. Body: { jwt }.
  auth.post("/session", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid-body", reason: "expected-json" }, 400);
    }
    const jwt = (body as { jwt?: unknown }).jwt;
    if (typeof jwt !== "string" || jwt === "") {
      return c.json({ error: "invalid-body", reason: "missing-jwt" }, 400);
    }

    const program = Effect.gen(function* () {
      const jwtService = yield* Jwt;
      const claims = yield* jwtService.verify(jwt);
      const db = yield* Db;
      const audit = yield* AuditLog;
      const hash = yield* hashToken(jwt);
      const now = yield* Clock.currentTimeMillis;
      // TODO(kms-backfill): pubkey '' = KMS-not-wired sentinel; the column
      // is NOT NULL in migration 0001. When KmsClient.Live lands, derive
      // real pubkeys here AND backfill existing '' rows in that phase's
      // migration (Sona-ratified 2026-07-28).
      yield* db.execute(
        "INSERT OR REPLACE INTO sessionCache (jwt_hash, pubkey, provider, oauth_id, expires_at_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?)",
        [hash, "", claims.provider, claims.oauth_id, claims.exp * 1000, now],
      );
      yield* audit.record({
        event_type: "session_created",
        actor: claims.login,
        details: { provider: claims.provider },
      });
      return { session_hash: hash };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure) && failure.value._tag === "JwtError") {
        return c.json({ error: "unauthorized", reason: failure.value.reason }, 401);
      }
      const reason = Option.isSome(failure) ? failure.value._tag : "defect";
      return c.json({ error: "internal", reason }, 500);
    }
    return c.json(exit.value);
  });

  // Drop the caller's session row.
  auth.delete("/session", requireAuth(layerFor), async (c) => {
    const claims = c.get("claims");
    const token = (c.req.header("Authorization") ?? "").slice(BEARER_PREFIX.length).trim();

    const program = Effect.gen(function* () {
      const db = yield* Db;
      const audit = yield* AuditLog;
      const hash = yield* hashToken(token);
      yield* db.execute("DELETE FROM sessionCache WHERE jwt_hash = ?", [hash]);
      yield* audit.record({ event_type: "session_deleted", actor: claims.login });
      return { deleted: true };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      const reason = Option.isSome(failure) ? failure.value._tag : "defect";
      return c.json({ error: "internal", reason }, 500);
    }
    return c.json(exit.value);
  });

  // Entry into 4a's OAuth AS as a registered client (authorization-code +
  // PKCE). Without client_id/redirect_uri 4a would run its "direct" flow and
  // strand the user on a raw-JSON JWT page at api.4a4.ai.
  auth.get("/oauth/start", async (c) => {
    const provider = c.req.query("provider") ?? "google";
    if (!(PROVIDERS as ReadonlyArray<string>).includes(provider)) {
      return c.json({ error: "invalid-provider", reason: `expected one of: ${PROVIDERS.join(", ")}` }, 400);
    }
    const state = c.req.query("state") ?? crypto.randomUUID();
    const verifierBytes = new Uint8Array(32);
    crypto.getRandomValues(verifierBytes);
    const codeVerifier = b64url(verifierBytes);
    const codeChallenge = await sha256B64url(codeVerifier);

    const url = new URL(`https://api.4a4.ai/auth/${provider}/start`);
    url.searchParams.set("client_id", OAUTH_CLIENT_ID_4A);
    url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    c.header("Set-Cookie", oauthCookie(PKCE_COOKIE, codeVerifier), { append: true });
    c.header("Set-Cookie", oauthCookie(STATE_COOKIE, state), { append: true });
    return c.redirect(url.toString(), 302);
  });

  // 4a redirects back here with ?code=&state=. Exchange the code for the JWT
  // server-side (client_secret + PKCE verifier), then hand the JWT to the SPA
  // via the fragment — /signin parses #jwt= and persists it.
  auth.get("/callback", async (c) => {
    const code = c.req.query("code");
    if (code === undefined || code === "") {
      return c.json({ error: "invalid-callback", reason: "missing-code" }, 400);
    }
    const state = c.req.query("state");
    const expectedState = getCookie(c, STATE_COOKIE);
    if (expectedState === undefined || state !== expectedState) {
      return c.json({ error: "invalid-callback", reason: "state-mismatch" }, 400);
    }
    const codeVerifier = getCookie(c, PKCE_COOKIE);
    if (codeVerifier === undefined) {
      return c.json({ error: "invalid-callback", reason: "missing-pkce-verifier" }, 400);
    }
    const clientSecret = c.env.OAUTH_CLIENT_SECRET_4A;
    if (clientSecret === undefined) {
      return c.json({ error: "internal", reason: "oauth-client-secret-unset" }, 500);
    }

    const tokenRes = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: OAUTH_REDIRECT_URI,
        client_id: OAUTH_CLIENT_ID_4A,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => "");
      return c.json(
        { error: "token-exchange-failed", status: tokenRes.status, detail: detail.slice(0, 500) },
        502,
      );
    }
    const tokenBody = (await tokenRes.json()) as { access_token?: string };
    if (typeof tokenBody.access_token !== "string" || tokenBody.access_token === "") {
      return c.json({ error: "token-exchange-failed", reason: "no-access-token" }, 502);
    }

    // Expire the one-shot cookies and land the SPA's sign-in page.
    c.header("Set-Cookie", oauthCookie(PKCE_COOKIE, "", 0), { append: true });
    c.header("Set-Cookie", oauthCookie(STATE_COOKIE, "", 0), { append: true });
    return c.redirect(`/signin#jwt=${tokenBody.access_token}`, 302);
  });

  return auth;
};
