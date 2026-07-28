// Jwt — Effect service for verifying 4a-minted access tokens.
//
// Tokens are minted by 4a's OAuth AS at api.4a4.ai (HS256, shared
// JWT_SIGNING_KEY); verification is a local HMAC check — no network call.
// Same scheme as the gateway's verifyJwt (4a/gateway/src/auth.ts),
// re-expressed in Effect idiom with a typed error union.

import { Clock, Context, Data, Effect, Layer } from "effect";
import { AppEnv } from "./AppEnv";

export interface Claims {
  readonly provider: string;
  readonly oauth_id: string;
  readonly login: string;
  readonly iat: number;
  readonly exp: number;
}

export class JwtError extends Data.TaggedError("JwtError")<{
  readonly reason:
    | "no-signing-key"
    | "malformed"
    | "bad-algorithm"
    | "bad-signature"
    | "bad-claims"
    | "expired";
}> {}

export interface JwtService {
  readonly verify: (token: string) => Effect.Effect<Claims, JwtError>;
}

export class Jwt extends Context.Tag("evenflow/Jwt")<Jwt, JwtService>() {}

const enc = new TextEncoder();
const dec = new TextDecoder();

const decodeB64Url = (s: string): Uint8Array | null => {
  try {
    const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(dec.decode(bytes));
  } catch {
    return null;
  }
};

const parseClaims = (value: unknown): Claims | null => {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (
    typeof c["provider"] !== "string" ||
    typeof c["oauth_id"] !== "string" ||
    typeof c["login"] !== "string" ||
    typeof c["iat"] !== "number" ||
    typeof c["exp"] !== "number"
  ) {
    return null;
  }
  return {
    provider: c["provider"],
    oauth_id: c["oauth_id"],
    login: c["login"],
    iat: c["iat"],
    exp: c["exp"],
  };
};

/** Core HS256 verification, factored out so tests can wire their own secret. */
export const makeJwt = (signingKey: string | undefined): JwtService => ({
  verify: (token) =>
    Effect.gen(function* () {
      if (signingKey === undefined || signingKey === "") {
        return yield* new JwtError({ reason: "no-signing-key" });
      }
      const parts = token.split(".");
      if (parts.length !== 3) return yield* new JwtError({ reason: "malformed" });
      const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

      const headerBytes = decodeB64Url(headerB64);
      const payloadBytes = decodeB64Url(payloadB64);
      const sig = decodeB64Url(sigB64);
      if (headerBytes === null || payloadBytes === null || sig === null) {
        return yield* new JwtError({ reason: "malformed" });
      }

      const header = parseJson(headerBytes) as { alg?: unknown } | null;
      if (header === null || header.alg !== "HS256") {
        return yield* new JwtError({ reason: "bad-algorithm" });
      }

      const ok = yield* Effect.tryPromise({
        try: async () => {
          const key = await crypto.subtle.importKey(
            "raw",
            enc.encode(signingKey),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["verify"],
          );
          return crypto.subtle.verify(
            "HMAC",
            key,
            sig,
            enc.encode(`${headerB64}.${payloadB64}`),
          );
        },
        catch: () => new JwtError({ reason: "bad-signature" }),
      });
      if (!ok) return yield* new JwtError({ reason: "bad-signature" });

      const claims = parseClaims(parseJson(payloadBytes));
      if (claims === null) return yield* new JwtError({ reason: "bad-claims" });

      const nowMs = yield* Clock.currentTimeMillis;
      if (claims.exp <= Math.floor(nowMs / 1000)) {
        return yield* new JwtError({ reason: "expired" });
      }
      return claims;
    }),
});

export const JwtLive: Layer.Layer<Jwt, never, AppEnv> = Layer.effect(
  Jwt,
  Effect.gen(function* () {
    const env = yield* AppEnv;
    return makeJwt(env.JWT_SIGNING_KEY);
  }),
);

/** Canned token accepted by the Test layer — no crypto involved. */
export const JWT_TEST_TOKEN = "evenflow-test-token";

export const JWT_TEST_CLAIMS: Claims = {
  provider: "test",
  oauth_id: "0",
  login: "tester",
  iat: 0,
  exp: 4102444800, // 2100-01-01
};

export const JwtTest: Layer.Layer<Jwt> = Layer.succeed(Jwt, {
  verify: (token) =>
    token === JWT_TEST_TOKEN
      ? Effect.succeed(JWT_TEST_CLAIMS)
      : Effect.fail(new JwtError({ reason: "bad-signature" })),
});
