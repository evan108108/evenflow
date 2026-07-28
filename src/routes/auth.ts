// /auth — session + identity endpoints.
//
// The OAuth flow itself lives on 4a's AS (api.4a4.ai/auth/*): it talks to
// Google/GitHub and mints the HS256 JWT. MVP uses the direct flow — the
// user fetches a JWT there and submits it to POST /auth/session here. We
// never store the raw JWT, only its sha256 hex (sessionCache.jwt_hash).

import { Hono } from "hono";
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
      // pubkey '' = KMS-not-wired sentinel; the column is NOT NULL in
      // migration 0001. Backfilled once KmsClient.Live is real.
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

  // Entry into 4a's OAuth AS. The state param is generated here (or passed
  // by the client) and tracked client-side against CSRF.
  auth.get("/oauth/start", (c) => {
    const provider = c.req.query("provider") ?? "google";
    if (!(PROVIDERS as ReadonlyArray<string>).includes(provider)) {
      return c.json({ error: "invalid-provider", reason: `expected one of: ${PROVIDERS.join(", ")}` }, 400);
    }
    const state = c.req.query("state") ?? crypto.randomUUID();
    const url = new URL(`https://api.4a4.ai/auth/${provider}/start`);
    url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  return auth;
};
