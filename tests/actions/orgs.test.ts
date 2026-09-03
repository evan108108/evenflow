// EFB-98: org actions tested DIRECTLY, no URL named.
//
// Same posture as tests/actions/comments.test.ts — a behaviour is asserted by
// calling the action, and routing is proved separately and once by the
// manifest, check-rest-conventions and tests/router.test.ts.
//
// The first test here exists for a family-specific reason. This file's routes
// carry TWO slug-shaped params: `:org_slug` (the org) and `:slug` (the board),
// side by side in the four board-member routes. Reading one where the other is
// meant is an AUTHORIZATION bug rather than a type error — both are strings
// and both resolve to something real — so it cannot be caught by tsc and would
// not be caught by a test that merely passes distinct-looking values. It is
// pinned below by making the two collide on purpose.

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  Jwt,
  JwtTest,
  JWT_TEST_CLAIMS,
  makeAuditLogTest,
  makeAudienceTest,
  makeFourATest,
  type AppServices,
} from "../../src/effects";
import { createOrg, deleteOrg, getOrg, listBoardMembers } from "../../src/actions/orgs";
import { actionInput } from "../../src/actions/types";
import { makeDbMock } from "../dbMock";
import { CALLER } from "../harness";

/** A layer with just the services the org actions ask for. */
const makeDeps = () => {
  const db = makeDbMock();
  const audit = makeAuditLogTest();
  const audience = makeAudienceTest();
  const foura = makeFourATest();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtTest as Layer.Layer<Jwt>,
    db.layer,
    audit.layer,
    audience.layer,
    foura.layer,
  ) as unknown as Layer.Layer<AppServices>;
  return { db, audit, audience, foura, layer };
};

const run = <A, E>(deps: ReturnType<typeof makeDeps>, program: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(Effect.provide(program as never, deps.layer));

const seedOrg = (
  deps: ReturnType<typeof makeDeps>,
  id: string,
  slug: string,
  overrides: Record<string, unknown> = {},
) => {
  deps.db.orgs.push({
    id, slug, display_name: slug, avatar_url: null, bio: null, kind: "team",
    created_by: CALLER, substrate_event_id: null, created_at_ms: 1, updated_at_ms: 1,
    deleted_at_ms: null, ...overrides,
  });
  deps.db.orgMembers.push({
    org_id: id, pubkey: CALLER, role: "owner", added_by: CALLER, added_at_ms: 1,
    substrate_event_id: null,
  });
};

const seedBoard = (deps: ReturnType<typeof makeDeps>, id: string, slug: string, orgId: string) => {
  deps.db.boards.push({
    id, pubkey: CALLER, slug, title: slug, description: null,
    columns: JSON.stringify(["Todo", "Done"]), labels: "[]", member_policy: "invite",
    is_encrypted: 0, org_id: orgId, visibility: "private", created_at_ms: 1, updated_at_ms: 1,
  });
};

describe("org actions", () => {
  it("resolves the board from boardSlug, never from orgSlug", async () => {
    // The trap: an org whose slug is ALSO the slug of one of its boards. If
    // the board lookup ever read `params.orgSlug` — the shape the fan-out
    // brief mistakenly described — it would resolve board "acme" here and
    // answer with the wrong board's roster, with every string still a string
    // and every layer still succeeding. Distinct-looking fixtures would let
    // that pass; colliding ones will not.
    const deps = makeDeps();
    seedOrg(deps, "o1", "acme");
    seedBoard(deps, "b-acme", "acme", "o1");
    seedBoard(deps, "b-roadmap", "roadmap", "o1");
    deps.db.boardMembers.push({
      board_id: "b-acme", pubkey: "test:on-acme", role: "contributor",
      added_by: CALLER, added_at_ms: 1, substrate_event_id: null,
    });
    deps.db.boardMembers.push({
      board_id: "b-roadmap", pubkey: "test:on-roadmap", role: "contributor",
      added_by: CALLER, added_at_ms: 1, substrate_event_id: null,
    });

    const exit = await run(
      deps,
      listBoardMembers(
        actionInput(JWT_TEST_CLAIMS, { orgSlug: "acme", boardSlug: "roadmap" }, undefined, { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Success");
    const members = (exit as { value: { members: Array<{ pubkey: string }> } }).value.members;
    const pubkeys = members.map((m) => m.pubkey);
    expect(pubkeys).toContain("test:on-roadmap");
    // The assertion that would fail if the two params were transposed.
    expect(pubkeys).not.toContain("test:on-acme");
  });

  it("unions org members into the board roster, projecting their role", async () => {
    // The invariant from docs/decisions/2026-08-org-teams.md: an org member
    // has an effective role on every board in the org via boardRoleFromOrgRole
    // (owner→owner, admin→admin, member→contributor). listBoardMembers used
    // to read only boardMemberCache, which meant the assignee picker could
    // not offer a person the authz layer would happily assign.
    const deps = makeDeps();
    seedOrg(deps, "o1", "acme");
    seedBoard(deps, "b-roadmap", "roadmap", "o1");
    // A plain org member — never added to the board directly.
    deps.db.orgMembers.push({
      org_id: "o1", pubkey: "test:org-only", role: "member",
      added_by: CALLER, added_at_ms: 2, substrate_event_id: null,
    });
    // Someone who is both an org member AND has an explicit board grant with
    // a WEAKER role; the projected org role must win.
    deps.db.orgMembers.push({
      org_id: "o1", pubkey: "test:both", role: "admin",
      added_by: CALLER, added_at_ms: 3, substrate_event_id: null,
    });
    deps.db.boardMembers.push({
      board_id: "b-roadmap", pubkey: "test:both", role: "viewer",
      added_by: CALLER, added_at_ms: 4, substrate_event_id: null,
    });

    const exit = await run(
      deps,
      listBoardMembers(
        actionInput(JWT_TEST_CLAIMS, { orgSlug: "acme", boardSlug: "roadmap" }, undefined, { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Success");
    const members = (exit as { value: { members: Array<{ pubkey: string; role: string }> } }).value.members;
    const byPubkey = new Map(members.map((m) => [m.pubkey, m.role]));
    // Org member surfaces with the projected board role.
    expect(byPubkey.get("test:org-only")).toBe("contributor");
    // Explicit + org: strongest wins (admin from org projection > viewer explicit).
    expect(byPubkey.get("test:both")).toBe("admin");
    // The caller (org owner) also projects onto the board as owner.
    expect(byPubkey.get(CALLER)).toBe("owner");
  });

  it("shows an anonymous reader the public view and withholds the member view", async () => {
    // The auth posture is visible in the signature: getOrg takes a
    // PublicActionInput, so claims === null is a case it has to answer rather
    // than something that happens to work.
    const deps = makeDeps();
    seedOrg(deps, "o1", "acme");

    const exit = await run(
      deps,
      getOrg(actionInput(null, { orgSlug: "acme" }, undefined, { grants: null })),
    );

    expect(exit._tag).toBe("Success");
    const value = (exit as { value: { org: Record<string, unknown>; role: string | null } }).value;
    expect(value.role).toBeNull();
    expect(value.org["slug"]).toBe("acme");
    // memberOrgView's additions must not leak to an anonymous caller.
    expect(value.org["id"]).toBeUndefined();
    expect(value.org["created_by"]).toBeUndefined();
  });

  it("refuses to create anything but a team org", async () => {
    // Personal orgs are only ever auto-created by session bootstrap.
    const deps = makeDeps();

    const exit = await run(
      deps,
      createOrg(
        actionInput(JWT_TEST_CLAIMS, {}, { kind: "personal", slug: "mine", display_name: "Mine" }, { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(deps.db.orgs).toHaveLength(0);
  });

  it("refuses to delete a personal org, which would orphan the caller's handle", async () => {
    const deps = makeDeps();
    seedOrg(deps, "o1", "tester", { kind: "personal" });

    const exit = await run(
      deps,
      deleteOrg(actionInput(JWT_TEST_CLAIMS, { orgSlug: "tester" }, undefined, { grants: null })),
    );

    expect(exit._tag).toBe("Failure");
    // Still live — a refused delete must not have stamped deleted_at_ms on its
    // way to discovering the org was personal.
    expect(deps.db.orgs[0]!["deleted_at_ms"]).toBeNull();
  });
});
