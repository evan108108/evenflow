// /api/v0/session — session bootstrap for the SPA.
//
// POST /session/bootstrap runs after every OAuth callback (and is safe to
// run on every app load): idempotently ensures the caller's personal org
// exists (slug = login-prefix, digit-suffixed on collision, reserved words
// skipped; an optional `claim` body field carries the sign-up CTA's
// ?claim=<handle> hint), then returns the caller's identity + org list so
// the client can populate the org switcher without a second round-trip.

import { Hono } from "hono";
import { Clock, Effect, Exit } from "effect";
import { Db, bootstrap, hashToken } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { callerPubkey, requireCaller } from "../authz";
import { ensurePersonalOrg } from "../membership";
import { ValidationError, errorResponse, readJsonBody } from "./errors";

const SESSION_PUBKEY_RE = /^[0-9a-f]{64}$/i;

export const makeSessionRouter = (layerFor: LayerFor = bootstrap) => {
  const session = new Hono<AppHonoEnv>();

  session.post("/session/bootstrap", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const pubkey = callerPubkey(claims);

      // The claim hint is best-effort: a malformed or taken handle falls
      // back to login-prefix derivation rather than failing sign-in.
      const body = yield* Effect.tryPromise({
        try: () => c.req.json() as Promise<Record<string, unknown>>,
        catch: () => null,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));
      const claim =
        body !== null && typeof body["claim"] === "string" ? body["claim"] : undefined;

      const { org: personal, created } = yield* ensurePersonalOrg(claims, token, claim);

      const db = yield* Db;
      const orgRows = yield* db.queryAll<{
        slug: string;
        display_name: string;
        avatar_url: string | null;
        kind: string;
        role: string;
      }>(
        "SELECT o.slug, o.display_name, o.avatar_url, o.kind, m.role FROM orgMemberCache m JOIN orgCache o ON o.id = m.org_id WHERE m.pubkey = ? AND o.deleted_at_ms IS NULL ORDER BY (o.kind = 'personal') DESC, o.slug ASC",
        [pubkey],
      );

      return {
        me: {
          handle: personal.slug,
          pubkey,
          login: claims.login,
          orgs: orgRows,
        },
        last_active_org: personal.slug,
        personal_org_created: created,
      };
    });

    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value);
  });

  // ── POST /session/register-key — per-session client keypair (16.5) ──────
  // Web users hold no long-lived secp256k1 keys, so each signed-in session
  // generates one and registers the pub here. Private-board key grants are
  // issued to these session pubs. Keyed by jwt_hash (one key per session,
  // re-registering replaces); expiry rides the JWT's own exp.
  session.post("/session/register-key", async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const token = c.get("token") ?? "";
      const pubkey = callerPubkey(claims);
      const body = yield* readJsonBody(c);
      const sessionPub = body["session_pubkey"];
      if (typeof sessionPub !== "string" || !SESSION_PUBKEY_RE.test(sessionPub)) {
        return yield* new ValidationError({ reason: "session_pubkey" });
      }
      const db = yield* Db;
      const now = yield* Clock.currentTimeMillis;
      const jwtHash = yield* hashToken(token);
      yield* db.execute(
        "INSERT OR REPLACE INTO sessionKeyRegistrations (jwt_hash, member_pubkey, session_pubkey, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)",
        [jwtHash, pubkey, sessionPub.toLowerCase(), now, claims.exp * 1000],
      );
      return { registered: true, session_pubkey: sessionPub.toLowerCase() };
    });
    const exit = await Effect.runPromiseExit(Effect.provide(program, layerFor(c.env)));
    if (Exit.isFailure(exit)) return errorResponse(c, exit.cause);
    return c.json(exit.value, 201);
  });

  return session;
};
