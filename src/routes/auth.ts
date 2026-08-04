// /auth — session + identity endpoints.
//
// The OAuth flow itself lives on 4a's AS (api.4a4.ai/auth/*): it talks to
// Google/GitHub and mints the HS256 JWT. We run the authorization-code flow
// as a registered client (DCR, RFC 7591): /auth/oauth/start sends the user
// to 4a with client_id + PKCE, 4a redirects back to /auth/callback with a
// code, and we exchange it server-side for the JWT. We never store the raw
// JWT, only its sha256 hex (sessionCache.jwt_hash).
//
// EFB-98: the three session/identity programs live in src/actions/auth.ts.
// The OAuth pair below does NOT, and deliberately: /oauth/start mints a PKCE
// verifier into a cookie and 302s to 4a, and /callback compares a state
// cookie, exchanges the code, and 302s with the JWT in a URL fragment. It
// never touches a session row — it is cookie and redirect plumbing end to
// end, which is exactly what an action module is supposed to be free of.

import { Hono } from "hono";
import { path } from "../routes-manifest";
import { getCookie } from "hono/cookie";
import { Cause, Effect, Exit, Option } from "effect";
import { bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { grantsOf } from "../http";
import { requireAuth } from "../middleware/requireAuth";
import { actionInput } from "../actions/types";
import { createSessionFromJwt, deleteSession, whoami } from "../actions/auth";

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

  // Verified identity of the caller, plus their KMS-derived hex pubkey from
  // the gateway's /v0/whoami (the same derivation every publish signs
  // with). Resolution failure is audited, not fatal — pubkey null. On
  // success the sessionCache row is upgraded in place, closing out the
  // pubkey '' sentinel rows the KmsClient-stub era wrote.
  auth.get(path("auth.whoami"), requireAuth(layerFor), async (c) => {
    const claims = c.get("claims");
    if (claims === undefined) {
      return c.json({ error: "unauthorized", reason: "missing-authorization" }, 401);
    }
    const token = (c.req.header("Authorization") ?? "").slice(BEARER_PREFIX.length).trim();
    // runPromise, not runPromiseExit: `whoami` cannot fail — a gateway
    // resolution failure is audited and answers pubkey null. Same as pre-split.
    return c.json(
      await Effect.runPromise(
        Effect.provide(
          whoami(actionInput(claims, c.req.param(), undefined, { grants: grantsOf(c), token })),
          layerFor(c.env),
        ),
      ),
    );
  });

  // Exchange a 4a-minted JWT for a cached session row. Body: { jwt }.
  auth.post(path("auth.session.create"), async (c) => {
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

    const program = createSessionFromJwt(jwt);

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
  auth.delete(path("auth.session.delete"), requireAuth(layerFor), async (c) => {
    const claims = c.get("claims");
    if (claims === undefined) {
      return c.json({ error: "unauthorized", reason: "missing-authorization" }, 401);
    }
    const token = (c.req.header("Authorization") ?? "").slice(BEARER_PREFIX.length).trim();

    const program = deleteSession(actionInput(claims, c.req.param(), undefined, { grants: grantsOf(c), token }));

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
  auth.get(path("auth.oauth.start"), async (c) => {
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
  auth.get(path("auth.oauth.callback"), async (c) => {
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
