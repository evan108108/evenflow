// /api/v0/session — session bootstrap for the SPA.
//
// POST /session/bootstrap runs after every OAuth callback (and is safe to
// run on every app load): idempotently ensures the caller's personal org
// exists (slug = login-prefix, digit-suffixed on collision, reserved words
// skipped; an optional `claim` body field carries the sign-up CTA's
// ?claim=<handle> hint), then returns the caller's identity + org list so
// the client can populate the org switcher without a second round-trip.

import { Hono } from "hono";
import { Effect, Exit } from "effect";
import { Db, bootstrap } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { callerPubkey, requireCaller } from "../authz";
import { ensurePersonalOrg } from "../membership";
import { errorResponse } from "./errors";

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

  return session;
};
