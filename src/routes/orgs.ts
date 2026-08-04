// /api/v0/orgs — HTTP shell over src/actions/orgs.ts.
//
// EFB-98 split this file in two. Everything that decides what an org IS moved
// to the action module; what stays here is transport: pull the params off the
// request, read the body, run requireCaller, call the action, map a failure to
// a status code.
//
// Namespace model (phase 16): every board lives in an org; /@{handle} is an
// org slug. Personal orgs are ONLY auto-created (session bootstrap); this
// router creates team orgs. Role requirements per endpoint follow the spec
// matrix — see authz.ts for the hierarchy and failure posture.
//
// Substrate: mutations cache D1 first and best-effort publish kind-30520 /
// kind-30521 events (membership.ts) — a 4a outage never blocks an org edit.
//
// TWO THINGS STAY HERE ON PURPOSE, AND A CHECKER ENFORCES BOTH:
//
//   - `readJsonBody(c)`. Seven of these routes are listed in
//     scripts/boundary-allowlist.json under `unmigrated`, keyed by route path
//     AND this file. EFB-87 re-audits every entry against detection and FAILS
//     one whose file shows no body-read marker, precisely so that moving a
//     read out from under the scanner cannot silently stop the ratchet from
//     describing anything. So the body is read here and handed to the action.
//   - `c.req.query()` on GET /org/:org_slug/boards, for the same reason in
//     scripts/boundary-query-allowlist.json. The action reads the decoded
//     value off `input.query`; the marker stays where the checker looks.
//
// The params are named ORGSLUG and BOARDSLUG rather than passed through as
// `c.req.param()`. `:org_slug` and `:slug` are different resources that appear
// together in the four board-member routes, and both are strings that resolve
// to something — so confusing them is an authorization bug rather than a type
// error. Naming them apart makes each action's auth check say which resource
// it means.

import { Hono } from "hono";
import { path } from "../routes-manifest";
import { Effect } from "effect";
import { bootstrap, type Claims } from "../effects";
import type { AppHonoEnv, LayerFor } from "../http";
import { requireCaller } from "../authz";
import { makeRunJson } from "../lib/run-json";
import { errorResponse, readJsonBody } from "./errors";
import { actionInput } from "../actions/types";
import { grantsOf } from "../http";
import {
  addBoardMember,
  addOrgMember,
  createOrg,
  deleteOrg,
  getOrg,
  listBoardMembers,
  listOrgBoards,
  listOrgMembers,
  removeBoardMember,
  removeOrgMember,
  transferOrg,
  updateBoardMember,
  updateOrg,
  updateOrgMember,
  type OrgServices,
  type OrgsFailure,
} from "../actions/orgs";

export const makeOrgsRouter = (layerFor: LayerFor = bootstrap) => {
  const orgs = new Hono<AppHonoEnv>();
  const runJson = makeRunJson<OrgsFailure, OrgServices>(layerFor, errorResponse);

  // ── POST /orgs — create a team org ──────────────────────────────────────
  orgs.post(path("org.create"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* readJsonBody(c);
      return yield* createOrg(
        actionInput(claims, {}, body, { grants: grantsOf(c), token: c.get("token") ?? "" }),
      );
    });
    return runJson(c, program, 201);
  });

  // ── GET /orgs/:slug — detail; public info for anyone, internal for members
  orgs.get(path("org.get"), async (c) =>
    runJson(
      c,
      getOrg(
        actionInput<undefined, Claims | null>(
          c.get("claims") ?? null,
          { orgSlug: c.req.param("org_slug") },
          undefined,
          { grants: grantsOf(c) },
        ),
      ),
    ),
  );

  // ── PATCH /orgs/:slug — profile edits + slug rename (admin+) ────────────
  orgs.patch(path("org.update"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* readJsonBody(c);
      return yield* updateOrg(
        actionInput(claims, { orgSlug: c.req.param("org_slug") }, body, {
          grants: grantsOf(c),
          token: c.get("token") ?? "",
        }),
      );
    });
    return runJson(c, program);
  });

  // ── DELETE /orgs/:slug — soft-delete (owner only; team orgs only) ───────
  orgs.delete(path("org.delete"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* deleteOrg(
        actionInput(claims, { orgSlug: c.req.param("org_slug") }, undefined, { grants: grantsOf(c) }),
      );
    });
    return runJson(c, program);
  });

  // ── POST /orgs/:slug/transfer — ownership transfer (owner only) ─────────
  orgs.post(path("org.transfer"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* readJsonBody(c);
      return yield* transferOrg(
        actionInput(claims, { orgSlug: c.req.param("org_slug") }, body, {
          grants: grantsOf(c),
          token: c.get("token") ?? "",
        }),
      );
    });
    return runJson(c, program);
  });

  // ── GET /orgs/:slug/boards — org board list, visibility-filtered ────────
  orgs.get(path("org.boards.list"), async (c) =>
    runJson(
      c,
      listOrgBoards(
        actionInput<undefined, Claims | null>(
          c.get("claims") ?? null,
          { orgSlug: c.req.param("org_slug") },
          undefined,
          { grants: grantsOf(c), query: c.req.query() },
        ),
      ),
    ),
  );

  // ── GET /orgs/:slug/members — member list (org members only) ────────────
  orgs.get(path("org.members.list"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* listOrgMembers(
        actionInput(claims, { orgSlug: c.req.param("org_slug") }, undefined, { grants: grantsOf(c) }),
      );
    });
    return runJson(c, program);
  });

  // ── POST /orgs/:slug/members — direct add (admin+) ──────────────────────
  orgs.post(path("org.member.add"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* readJsonBody(c);
      return yield* addOrgMember(
        actionInput(claims, { orgSlug: c.req.param("org_slug") }, body, {
          grants: grantsOf(c),
          token: c.get("token") ?? "",
        }),
      );
    });
    return runJson(c, program, 201);
  });

  // ── PATCH /orgs/:slug/members/:pubkey — role change (admin+) ────────────
  orgs.patch(path("org.member.update"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* readJsonBody(c);
      return yield* updateOrgMember(
        actionInput(
          claims,
          { orgSlug: c.req.param("org_slug"), pubkey: c.req.param("pubkey") },
          body,
          { grants: grantsOf(c), token: c.get("token") ?? "" },
        ),
      );
    });
    return runJson(c, program);
  });

  // ── DELETE /orgs/:slug/members/:pubkey — kick (admin+) ──────────────────
  // Removing the org row removes org-projected board access automatically
  // (it's computed); explicit boardMemberCache grants deliberately survive.
  orgs.delete(path("org.member.remove"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* removeOrgMember(
        actionInput(
          claims,
          { orgSlug: c.req.param("org_slug"), pubkey: c.req.param("pubkey") },
          undefined,
          { grants: grantsOf(c), token: c.get("token") ?? "" },
        ),
      );
    });
    return runJson(c, program);
  });

  // ── board members: /orgs/:org_slug/boards/:slug/members ─────────────────

  orgs.get(path("org.board.members.list"), async (c) =>
    runJson(
      c,
      listBoardMembers(
        actionInput<undefined, Claims | null>(
          c.get("claims") ?? null,
          { orgSlug: c.req.param("org_slug"), boardSlug: c.req.param("slug") },
          undefined,
          { grants: grantsOf(c) },
        ),
      ),
    ),
  );

  orgs.post(path("org.board.member.add"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* readJsonBody(c);
      return yield* addBoardMember(
        actionInput(
          claims,
          { orgSlug: c.req.param("org_slug"), boardSlug: c.req.param("slug") },
          body,
          { grants: grantsOf(c), token: c.get("token") ?? "" },
        ),
      );
    });
    return runJson(c, program, 201);
  });

  orgs.patch(path("org.board.member.update"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      const body = yield* readJsonBody(c);
      return yield* updateBoardMember(
        actionInput(
          claims,
          {
            orgSlug: c.req.param("org_slug"),
            boardSlug: c.req.param("slug"),
            pubkey: c.req.param("pubkey"),
          },
          body,
          { grants: grantsOf(c), token: c.get("token") ?? "" },
        ),
      );
    });
    return runJson(c, program);
  });

  orgs.delete(path("org.board.member.remove"), async (c) => {
    const program = Effect.gen(function* () {
      const claims = yield* requireCaller(c.get("claims"));
      return yield* removeBoardMember(
        actionInput(
          claims,
          {
            orgSlug: c.req.param("org_slug"),
            boardSlug: c.req.param("slug"),
            pubkey: c.req.param("pubkey"),
          },
          undefined,
          { grants: grantsOf(c), token: c.get("token") ?? "" },
        ),
      );
    });
    return runJson(c, program);
  });

  return orgs;
};
