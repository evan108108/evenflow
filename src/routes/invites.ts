// /api/v0/invites — HTTP shell over src/actions/invites.ts.
//
// EFB-98 split this file in two. Everything that decides what an invite IS
// moved to the action module — the code generator, the state machine, the
// authorization, the membership grants. What stays here is transport: pull the
// params off the request, read the body, run requireCaller, call the action,
// map a failure to a status code.
//
// The body is still read HERE, deliberately, and with `readJsonBody` rather
// than `parseRouteBody`. POST /invites is on check:boundary's `unmigrated`
// allowlist (sunset 2026-12-31), and EFB-87's re-audit FAILS an allowlisted
// route whose file shows no body-read marker — a declaration that has stopped
// describing anything real is the exact rot that re-audit exists to catch. So
// the marker stays physically in this file; migrating the shape is that
// ticket's job, not this one's.
//
// errorResponse is the shared phase-16 one from ./errors: unlike boards, this
// family never had a private copy to delete.

import { Hono } from "hono";
import { Effect } from "effect";

import { path } from "../routes-manifest";
import { makeRunJson } from "../lib/run-json";
import { bootstrap, type Claims } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { requireCaller } from "../authz";
import { actionInput } from "../actions/types";
import {
  acceptInvite,
  createInvite,
  declineInvite,
  deleteInvite,
  getInvite,
  listOrgBoardInvites,
  listOrgInvites,
  sendInviteEmail,
  type InviteServices,
  type InvitesFailure,
} from "../actions/invites";
import { errorResponse, readJsonBody } from "./errors";

export const makeInvitesRouter = (layerFor: LayerFor = bootstrap) => {
  const invites = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<InvitesFailure, InviteServices>(layerFor, errorResponse);

  // ── POST /invites — create ──────────────────────────────────────────────
  invites.post(path("invite.create"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* readJsonBody(c);
      return yield* createInvite(actionInput(claims, c.req.param(), body));
    });
    return runJson(c, program, 201);
  });

  // ── GET /invites/:code — anonymous preview resolve ──────────────────────
  invites.get(path("invite.get"), async (c) =>
    runJson(
      c,
      getInvite(
        actionInput<undefined, Claims | null>(c.get("claims") ?? null, c.req.param(), undefined),
      ),
    ),
  );

  // ── POST /invites/:code/accept ──────────────────────────────────────────
  invites.post(path("invite.accept"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* acceptInvite(
        actionInput(claims, c.req.param(), undefined, { token: c.get("token") ?? "" }),
      );
    });
    return runJson(c, program);
  });

  // ── POST /invites/:code/decline ─────────────────────────────────────────
  invites.post(path("invite.decline"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* declineInvite(actionInput(claims, c.req.param(), undefined));
    });
    return runJson(c, program);
  });

  // ── POST /invites/:id/email — send the invite by mail ───────────────────
  invites.post(path("invite.email.send"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* sendInviteEmail(actionInput(claims, c.req.param(), undefined));
    });
    return runJson(c, program);
  });

  // ── DELETE /invites/:id — revoke ────────────────────────────────────────
  invites.delete(path("invite.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* deleteInvite(actionInput(claims, c.req.param(), undefined));
    });
    return runJson(c, program);
  });

  // ── pending lists ───────────────────────────────────────────────────────
  //
  // `org_slug` is declared in these two manifest paths rather than coming from
  // a mount prefix (this router mounts once), but it is the same business
  // input either way — it selects whose invites are listed — so it travels as
  // `input.orgSlug`.

  invites.get(path("invite.org.list"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* listOrgInvites(
        actionInput(claims, c.req.param(), undefined, {
          orgSlug: c.req.param("org_slug") ?? null,
        }),
      );
    });
    return runJson(c, program);
  });

  invites.get(path("invite.orgBoard.list"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* listOrgBoardInvites(
        actionInput(claims, c.req.param(), undefined, {
          orgSlug: c.req.param("org_slug") ?? null,
        }),
      );
    });
    return runJson(c, program);
  });

  return invites;
};
