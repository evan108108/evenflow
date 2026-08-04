// Auth middleware — two flavors over the same JWT verification:
//
//   requireAuth()  — hard gate: no (valid) token → 401. Pre-16 behavior,
//                    still used for /auth/* surfaces.
//   optionalAuth() — phase-16 gate for /api/v0/*: a PRESENT token must be
//                    valid (invalid → 401 — never silently downgrade an
//                    authenticated caller to anonymous), an ABSENT token
//                    passes through unauthenticated so public boards can be
//                    read without signing in. Routes gate mutations with
//                    requireCaller(claims).
//
// Both set `claims` (verified) and `token` (raw JWT, forwarded to 4a
// publish calls) on the request context when a token verifies.
//
// Phase 19: both flavors ALSO accept `Authorization: Bearer evk_…`
// developer API keys — looked up by prefix, verified by sha256 hash, and
// authenticating as the key's owner (synthesized claims). REST and the
// /mcp surface share this middleware, so keys work on both for free.

import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { Cause, Clock, Data, Effect, Exit, Option } from "effect";
import { entryForMatch } from "../routes-manifest";
import {
  derivedRequirement,
  describeRequirement,
  grantsFromColumn,
  grantsSatisfy,
  type Grant,
} from "../scopes";
import { Db, Jwt, bootstrap, type JwtError } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import type { Claims } from "../effects";
import {
  API_KEY_DISPLAY_PREFIX_LEN,
  API_KEY_LAST_USED_THROTTLE_MS,
  claimsForApiKey,
  hashApiKey,
  isApiKeyToken,
} from "../apikeys";
import { API_KEY_ROTATION_GRACE_MS } from "../apikey-policy";

const BEARER_PREFIX = "Bearer ";

/** Unknown, revoked, or malformed evk_ token — always the same 401 reason
 *  so probing can't distinguish "revoked" from "never existed". */
class ApiKeyError extends Data.TaggedError("ApiKeyError")<{
  readonly reason: "invalid-api-key";
}> {}

/**
 * A verified caller: who they are, plus what they may do.
 *
 * `grants` is null for a JWT caller and for a key minted before EFB-100 —
 * both carry full owner authority, which is the pre-scoping behaviour
 * preserved byte-for-byte. A non-null list NARROWS.
 */
interface VerifiedCaller {
  readonly claims: Claims;
  readonly grants: readonly Grant[] | null;
}

const verifyApiKey = (token: string): Effect.Effect<VerifiedCaller, ApiKeyError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const candidates = yield* db
      .queryAll<{
        id: string;
        pubkey: string;
        name: string;
        key_hash: string;
        last_used_at_ms: number | null;
        rotated_at_ms: number | null;
        scopes: string | null;
      }>(
        "SELECT id, pubkey, name, key_hash, last_used_at_ms, rotated_at_ms, scopes FROM apiKeys WHERE prefix = ? AND revoked_at_ms IS NULL",
        [token.slice(0, API_KEY_DISPLAY_PREFIX_LEN)],
      )
      .pipe(Effect.mapError(() => new ApiKeyError({ reason: "invalid-api-key" })));
    const hash = yield* Effect.promise(() => hashApiKey(token));
    const key = candidates.find((k) => k.key_hash === hash);
    if (key === undefined) return yield* new ApiKeyError({ reason: "invalid-api-key" });
    const claims = claimsForApiKey(key.pubkey, key.name);
    if (claims === null) return yield* new ApiKeyError({ reason: "invalid-api-key" });

    const now = yield* Clock.currentTimeMillis;

    // EFB-99 — the grace window, and THIS is where a rotated key's expiry is
    // DECIDED. A rotated row is deliberately left un-revoked so the query
    // above still finds it: that is what keeps the old secret working while
    // callers redeploy. Once the window has passed it stops here.
    //
    // Enforced at auth rather than by a sweep on purpose. A background job
    // would make "is this key dead?" depend on whether the job ran on time,
    // and "the sweep ran" is a PROXY for "the key is dead" that diverges
    // exactly when it matters — a late or wedged sweep means an expired key
    // authenticates. Deciding here makes expiry a property of the auth
    // predicate itself. The revoke write below is bookkeeping DOWNSTREAM of a
    // decision already made, never the thing the decision trusts; a sweep may
    // be added later to tidy rows nobody re-presents, but it must not become
    // the authority.
    //
    // The refusal reuses `invalid-api-key` verbatim. Answering something
    // truer like "rotated" would confirm to a prober both that this prefix
    // once existed and that its owner is actively managing it — see the
    // ApiKeyError docstring: one reason, so revoked and never-existed are
    // indistinguishable.
    if (key.rotated_at_ms !== null && now - key.rotated_at_ms > API_KEY_ROTATION_GRACE_MS) {
      yield* db
        .execute("UPDATE apiKeys SET revoked_at_ms = ? WHERE id = ?", [now, key.id])
        .pipe(Effect.catchAll(() => Effect.void));
      return yield* new ApiKeyError({ reason: "invalid-api-key" });
    }

    // last_used_at_ms bumps at most once a minute per key; a failed bump
    // never fails the request.
    if (key.last_used_at_ms === null || now - key.last_used_at_ms > API_KEY_LAST_USED_THROTTLE_MS) {
      yield* db
        .execute("UPDATE apiKeys SET last_used_at_ms = ? WHERE id = ?", [now, key.id])
        .pipe(Effect.catchAll(() => Effect.void));
    }
    // EFB-100. NULL means the key predates scoping and carries full owner
    // authority; an explicit array narrows. A stored value that will not parse
    // yields an EMPTY grant list rather than null — a corrupt scopes column
    // must never be read as the widest possible answer.
    return { claims, grants: grantsFromColumn(key.scopes) };
  });

const makeAuthMiddleware = (
  layerFor: LayerFor,
  tokenRequired: boolean,
): MiddlewareHandler<AppHonoEnv> =>
  async (c, next) => {
    const header = c.req.header("Authorization");
    if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
      if (tokenRequired) {
        return c.json({ error: "unauthorized", reason: "missing-authorization" }, 401);
      }
      return next();
    }
    const token = header.slice(BEARER_PREFIX.length).trim();

    const verify: Effect.Effect<VerifiedCaller, JwtError | ApiKeyError, Jwt | Db> = isApiKeyToken(
      token,
    )
      ? verifyApiKey(token)
      : Effect.flatMap(Jwt, (jwt) =>
          // A JWT caller is never narrowed: grants stay null, which is the
          // pre-EFB-100 behaviour for every human session.
          Effect.map(jwt.verify(token), (claims) => ({ claims, grants: null })),
        );
    const exit = await Effect.runPromiseExit(
      Effect.provide(verify, layerFor(c.env)),
    );

    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      const reason = Option.isSome(failure) ? failure.value.reason : "internal";
      return c.json({ error: "unauthorized", reason }, 401);
    }

    const { claims, grants } = exit.value;

    // ── EFB-100: the DOMAIN + ACCESS half of scope enforcement ────────────
    //
    // One place, and this is it. Both requireAuth and optionalAuth are built
    // from this function, and mcp.ts builds its internal REST app with the
    // same requireAuth factory — so the MCP surface inherits this check by
    // construction rather than by anyone remembering to add it there. There
    // is no second check to forget.
    //
    // The INSTANCE half (which board) is not here and cannot be: half the
    // board surface addresses rows rather than boards (/issue/:id and
    // friends), so at this point there is no slug to compare — only an opaque
    // id whose board nothing has read yet. That half lives in authorizeBoard,
    // where the board is resolved. Two choke points, two different questions,
    // each at the only layer that can answer its own.
    if (grants !== null) {
      const entry = entryForMatch(c.req.method, routePath(c, -1));
      // FAIL CLOSED. No manifest entry means nothing can say what reaching
      // this route ought to require, and "unknown requirement" must never
      // read as "no requirement". This is what makes the manifest the
      // security perimeter: a route declared nowhere is reachable by no
      // scoped key.
      if (entry === null) {
        return c.json(
          {
            error: "forbidden",
            reason: "this route is not declared in the API manifest, so a scoped key cannot reach it",
          },
          403,
        );
      }
      const requirement = derivedRequirement(entry);
      if (!grantsSatisfy(grants, requirement)) {
        // The keys surface answers `jwt-required` — the SAME reason
        // rejectKeyCallers has always given — rather than a scope-flavoured
        // one. Two things depend on that. A legacy key (grants null) skips
        // this block entirely and gets `jwt-required` from the old guard, so
        // any other string here would mean the same refusal reads differently
        // depending on whether the key happens to be scoped. And the reason is
        // wire surface: changing it is a wire-reason change, which needs its
        // own ticket rather than riding in on this one.
        //
        // This is still a real second gate, not a pass-through: if a keys
        // route ever forgot rejectKeyCallers, a scoped key is stopped here.
        const reason =
          requirement.kind === "never"
            ? "jwt-required"
            : `this key is missing ${describeRequirement(requirement)}`;
        return c.json({ error: "forbidden", reason }, 403);
      }
    }

    c.set("claims", claims);
    c.set("token", token);
    // Read by authorizeBoard for the instance half. Null for JWT callers and
    // legacy keys, which is what keeps their behaviour unchanged.
    c.set("grants", grants);
    await next();
  };

export const requireAuth = (
  layerFor: LayerFor = bootstrap,
): MiddlewareHandler<AppHonoEnv> => makeAuthMiddleware(layerFor, true);

export const optionalAuth = (
  layerFor: LayerFor = bootstrap,
): MiddlewareHandler<AppHonoEnv> => makeAuthMiddleware(layerFor, false);
