// EFB-98: invite behaviours proved by calling the action DIRECTLY.
//
// No URL appears in this file. Routing is proved once by the manifest, its
// checker, and the mount table test; what is proved here is what an invite
// DOES — which of the five states a code is in, who is allowed to accept it,
// and that the single-use claim is atomic.
//
// `getInvite` takes a PublicActionInput and the test passes `null`, which is
// the whole point of that type: the preview page renders before sign-in, so
// anonymous is a case the action has thought about rather than one that
// happens to work.

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  Jwt,
  JwtTest,
  JWT_TEST_CLAIMS,
  makeAuditLogTest,
  makeAudienceTest,
  makeBoardEmitterTest,
  makeEmailTest,
  makeFourATest,
  type AppServices,
} from "../../src/effects";
import {
  acceptInvite,
  createInvite,
  declineInvite,
  deleteInvite,
  getInvite,
  listOrgInvites,
  sendInviteEmail,
} from "../../src/actions/invites";
import { actionInput } from "../../src/actions/types";
import { makeDbMock } from "../dbMock";
import { CALLER } from "../harness";

const makeDeps = () => {
  const db = makeDbMock();
  const audit = makeAuditLogTest();
  const email = makeEmailTest();
  const layer: Layer.Layer<AppServices> = Layer.mergeAll(
    JwtTest as Layer.Layer<Jwt>,
    db.layer,
    audit.layer,
    email.layer,
    makeBoardEmitterTest().layer,
    makeAudienceTest().layer,
    makeFourATest().layer,
  ) as unknown as Layer.Layer<AppServices>;
  return { db, audit, email, layer };
};

const run = <A, E>(deps: ReturnType<typeof makeDeps>, program: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(Effect.provide(program as never, deps.layer));

const HOUR_MS = 60 * 60 * 1000;

/** An org the caller administers. */
const seedOrg = (deps: ReturnType<typeof makeDeps>) => {
  deps.db.orgs.push({
    id: "o1", slug: "acme", display_name: "Acme", avatar_url: null, bio: null,
    kind: "team", created_by: CALLER, substrate_event_id: null,
    created_at_ms: 1, updated_at_ms: 1, deleted_at_ms: null,
  });
  deps.db.orgMembers.push({
    org_id: "o1", pubkey: CALLER, role: "owner", added_by: CALLER, added_at_ms: 1,
    substrate_event_id: null,
  });
};

/** A live org invite. `over` moves it into whichever state a test needs. */
const seedInvite = (deps: ReturnType<typeof makeDeps>, over: Record<string, unknown> = {}) => {
  deps.db.invites.push({
    id: "i1", code: "inv-abcd1234", org_id: "o1", board_id: null, role: "member",
    invited_by: CALLER, invited_email: null, bind_to_email: 0, bind_to_pubkey: null,
    expires_at_ms: Date.now() + 48 * HOUR_MS, single_use: 1, used_by: null,
    used_at_ms: null, revoked_at_ms: null, declined_at_ms: null,
    created_at_ms: 1, ...over,
  });
};

describe("invite actions", () => {
  // ── create ──────────────────────────────────────────────────────────────

  it("creates an org invite and hands back its share URL", async () => {
    const deps = makeDeps();
    seedOrg(deps);

    const exit = await run(
      deps,
      createInvite(actionInput(JWT_TEST_CLAIMS, {}, { org_slug: "acme", role: "member" }, { grants: null })),
    );

    expect(exit._tag).toBe("Success");
    expect(deps.db.invites).toHaveLength(1);
    if (exit._tag === "Success") {
      const { url } = exit.value as { url: string };
      expect(url).toBe(`https://evenflow.work/i/${deps.db.invites[0]!["code"]}`);
    }
  });

  it("refuses to mint an owner invite, whatever the scope", async () => {
    // `role === "owner"` is rejected explicitly, on top of the allowed-roles
    // membership test — ownership is not something an invite can confer.
    const deps = makeDeps();
    seedOrg(deps);

    const exit = await run(
      deps,
      createInvite(actionInput(JWT_TEST_CLAIMS, {}, { org_slug: "acme", role: "owner" }, { grants: null })),
    );

    expect(exit._tag).toBe("Failure");
    expect(deps.db.invites).toHaveLength(0);
  });

  it("requires invited_email before bind_to_email means anything", async () => {
    const deps = makeDeps();
    seedOrg(deps);

    const exit = await run(
      deps,
      createInvite(
        actionInput(JWT_TEST_CLAIMS, {}, {
          org_slug: "acme",
          role: "member",
          bind_to_email: true,
        }, { grants: null }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(deps.db.invites).toHaveLength(0);
  });

  // ── anonymous preview ───────────────────────────────────────────────────

  it("previews an invite for a signed-out visitor — the code IS the capability", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedInvite(deps);

    const exit = await run(
      deps,
      getInvite(actionInput(null, { code: "inv-abcd1234" }, undefined, { grants: null })),
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      const preview = exit.value as { valid: boolean; role: string; reason?: string };
      expect(preview.valid).toBe(true);
      expect(preview.role).toBe("member");
      // A valid invite carries no `reason` at all — the key is omitted, not null.
      expect("reason" in preview).toBe(false);
    }
  });

  it("names the state that invalidated a preview rather than 404ing it", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedInvite(deps, { revoked_at_ms: 2 });

    const exit = await run(
      deps,
      getInvite(actionInput(null, { code: "inv-abcd1234" }, undefined, { grants: null })),
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      const preview = exit.value as { valid: boolean; reason: string };
      expect(preview.valid).toBe(false);
      expect(preview.reason).toBe("revoked");
    }
  });

  // ── accept ──────────────────────────────────────────────────────────────

  it("accepts a valid invite and lands the caller in the org", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedInvite(deps, { invited_by: "github:999" });

    const exit = await run(
      deps,
      acceptInvite(
        actionInput(JWT_TEST_CLAIMS, { code: "inv-abcd1234" }, undefined, { grants: null, token: "t" }),
      ),
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect((exit.value as { target_url: string }).target_url).toBe("/@acme");
    }
    expect(deps.db.orgMembers.some((m) => m["pubkey"] === CALLER && m["role"] === "member")).toBe(
      true,
    );
  });

  it("refuses the second accept of a single-use invite", async () => {
    // The claim is a conditional UPDATE … RETURNING, so the loser of a race
    // sees null and 409s rather than both callers being admitted.
    const deps = makeDeps();
    seedOrg(deps);
    seedInvite(deps, { invited_by: "github:999" });

    const first = await run(
      deps,
      acceptInvite(
        actionInput(JWT_TEST_CLAIMS, { code: "inv-abcd1234" }, undefined, { grants: null, token: "t" }),
      ),
    );
    const second = await run(
      deps,
      acceptInvite(
        actionInput(JWT_TEST_CLAIMS, { code: "inv-abcd1234" }, undefined, { grants: null, token: "t" }),
      ),
    );

    expect(first._tag).toBe("Success");
    expect(second._tag).toBe("Failure");
  });

  it("refuses an email-bound invite offered to a different address", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedInvite(deps, {
      invited_by: "github:999",
      bind_to_email: 1,
      invited_email: "someone.else@example.com",
    });

    const exit = await run(
      deps,
      acceptInvite(
        actionInput(JWT_TEST_CLAIMS, { code: "inv-abcd1234" }, undefined, { grants: null, token: "t" }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    // Refused BEFORE the row was claimed — a bounced accept must not burn it.
    expect(deps.db.invites[0]!["used_by"]).toBeNull();
  });

  it("refuses a pubkey-bound invite to an OAuth caller, who has no real pubkey", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedInvite(deps, {
      invited_by: "github:999",
      bind_to_pubkey: "a".repeat(64),
    });

    const exit = await run(
      deps,
      acceptInvite(
        actionInput(JWT_TEST_CLAIMS, { code: "inv-abcd1234" }, undefined, { grants: null, token: "t" }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(deps.db.invites[0]!["used_by"]).toBeNull();
  });

  // ── decline / revoke / email ────────────────────────────────────────────

  it("declines an invite, and a declined invite can no longer be accepted", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedInvite(deps, { invited_by: "github:999" });

    const declined = await run(
      deps,
      declineInvite(actionInput(JWT_TEST_CLAIMS, { code: "inv-abcd1234" }, undefined, { grants: null })),
    );
    const accepted = await run(
      deps,
      acceptInvite(
        actionInput(JWT_TEST_CLAIMS, { code: "inv-abcd1234" }, undefined, { grants: null, token: "t" }),
      ),
    );

    expect(declined._tag).toBe("Success");
    expect(accepted._tag).toBe("Failure");
  });

  it("is idempotent about revoking — a second revoke still answers revoked", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedInvite(deps);

    const first = await run(deps, deleteInvite(actionInput(JWT_TEST_CLAIMS, { id: "i1" }, undefined, { grants: null })));
    const second = await run(deps, deleteInvite(actionInput(JWT_TEST_CLAIMS, { id: "i1" }, undefined, { grants: null })));

    expect(first._tag).toBe("Success");
    expect(second._tag).toBe("Success");
    // The second call short-circuits on the already-set timestamp rather than
    // overwriting it, so the audit trail records one revocation, not two.
    expect(deps.audit.events.filter((e) => e.event_type === "invite_revoked")).toHaveLength(1);
  });

  it("will not email an invite that carries no address", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedInvite(deps);

    const exit = await run(deps, sendInviteEmail(actionInput(JWT_TEST_CLAIMS, { id: "i1" }, undefined, { grants: null })));

    expect(exit._tag).toBe("Failure");
    expect(deps.email.sent).toHaveLength(0);
  });

  it("emails an invite that does carry one", async () => {
    const deps = makeDeps();
    seedOrg(deps);
    seedInvite(deps, { invited_email: "new.hire@example.com" });

    const exit = await run(deps, sendInviteEmail(actionInput(JWT_TEST_CLAIMS, { id: "i1" }, undefined, { grants: null })));

    expect(exit._tag).toBe("Success");
    expect(deps.email.sent).toHaveLength(1);
    expect(deps.email.sent[0]!.to).toBe("new.hire@example.com");
  });

  // ── pending list ────────────────────────────────────────────────────────

  it("lists pending org invites and omits the spent ones", async () => {
    // orgSlug is business input here too — it selects whose invites these are.
    const deps = makeDeps();
    seedOrg(deps);
    seedInvite(deps);
    seedInvite(deps, { id: "i2", code: "inv-revoked1", revoked_at_ms: 5 });
    seedInvite(deps, { id: "i3", code: "inv-expired1", expires_at_ms: 1 });

    const exit = await run(
      deps,
      listOrgInvites(actionInput(JWT_TEST_CLAIMS, {}, undefined, { grants: null, orgSlug: "acme" })),
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      const { invites } = exit.value as { invites: ReadonlyArray<{ id: string }> };
      expect(invites.map((i) => i.id)).toEqual(["i1"]);
    }
  });
});
