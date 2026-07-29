// Audience — Effect service for private-board substrate publishing
// (phase 16.5).
//
// Two responsibilities:
//   1. Hold the server audience keypair (derived from
//      EVENFLOW_AUDIENCE_SECRET) that seals per-board aud_id/epoch scalars
//      at rest in D1. `serverKeys` is null until the secret is configured —
//      privacy endpoints answer 503 not-configured, mirroring 18b storage.
//   2. `rawPost` — NIP-98-signed POSTs to the 4a gateway's caller-signed
//      audience surface (/v0/audience/raw/*), signed by a board's aud_id.
//      This is the ONLY substrate door that accepts evenflow's encrypted
//      event kinds (30555-30559): publish-wraps never inspects the inner
//      rumor, while the JWT publish path allowlist-rejects unknown kinds.
//
// All substrate calls are best-effort at the call site (bestEffortAudience)
// — the D1 write is authoritative and a gateway outage must never fail a
// board mutation, same discipline as membership.ts's bestEffort.

import { Context, Data, Effect, Layer } from "effect";
import { AppEnv } from "./AppEnv";
import { signNip98 } from "../lib/audience/nip98-sign";
import {
  deriveServerAudienceKeys,
  type ServerAudienceKeys,
} from "../lib/audience-store";

export const FOURA_API_BASE = "https://api.4a4.ai";

export class AudienceError extends Data.TaggedError("AudienceError")<{
  readonly reason: "http" | "network";
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export interface AudienceService {
  /** Server audience keypair, or null when EVENFLOW_AUDIENCE_SECRET is unset. */
  readonly serverKeys: () => ServerAudienceKeys | null;
  /** NIP-98-signed POST to /v0/audience/raw/<path suffix>. */
  readonly rawPost: (
    path: string,
    body: unknown,
    signerPriv: Uint8Array,
  ) => Effect.Effect<void, AudienceError>;
}

export class Audience extends Context.Tag("evenflow/Audience")<Audience, AudienceService>() {}

export const AudienceLive: Layer.Layer<Audience, never, AppEnv> = Layer.effect(
  Audience,
  Effect.gen(function* () {
    const env = yield* AppEnv;
    const keys = deriveServerAudienceKeys(env.EVENFLOW_AUDIENCE_SECRET);
    return {
      serverKeys: () => keys,
      rawPost: (path, body, signerPriv) =>
        Effect.tryPromise({
          try: async () => {
            const url = `${FOURA_API_BASE}${path}`;
            const bytes = new TextEncoder().encode(JSON.stringify(body));
            const auth = await signNip98({ url, method: "POST", body: bytes, pluginPriv: signerPriv });
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: auth },
              body: bytes,
            });
            if (!res.ok) throw new AudienceError({ reason: "http", status: res.status });
          },
          catch: (cause) =>
            cause instanceof AudienceError ? cause : new AudienceError({ reason: "network", cause }),
        }),
    };
  }),
);

/**
 * Best-effort substrate publish: failures log `audience-publish-deferred`
 * and resolve — D1 already committed, the substrate mirror catches up in a
 * later phase's retry pass.
 */
export const bestEffortAudience = <A>(
  label: string,
  effect: Effect.Effect<A, AudienceError>,
): Effect.Effect<A | null, never> =>
  effect.pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        console.log(
          JSON.stringify({ warn: "audience-publish-deferred", label, reason: e.reason, status: e.status ?? null }),
        );
        return null;
      }),
    ),
  );

export interface AudienceTestHandle {
  readonly layer: Layer.Layer<Audience>;
  readonly calls: Array<{ path: string; body: unknown }>;
  /** Set true to make every rawPost fail (substrate-outage tests). */
  flags: { failPosts: boolean };
}

/** Deterministic test secret — any fixed 32-byte hex works for the mock. */
export const AUDIENCE_TEST_SECRET =
  "5f0e17a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8";

export const makeAudienceTest = (): AudienceTestHandle => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const flags = { failPosts: false };
  const keys = deriveServerAudienceKeys(AUDIENCE_TEST_SECRET);
  return {
    calls,
    flags,
    layer: Layer.succeed(Audience, {
      serverKeys: () => keys,
      rawPost: (path, body) =>
        flags.failPosts
          ? Effect.fail(new AudienceError({ reason: "http", status: 502 }))
          : Effect.sync(() => {
              calls.push({ path, body });
            }),
    }),
  };
};
