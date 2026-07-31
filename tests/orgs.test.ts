// /api/v0/orgs — org CRUD, membership management, and the per-role board
// access matrix.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALLER,
  bearer,
  bearerFor,
  createBoard,
  callerOrg,
  createIssue,
  jsonReq,
  makeHarness,
  pubkeyFor,
  seedBoardMember,
  seedOrgMember,
  tokenFor,
  type Harness,
} from "./harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const createTeam = (h: Harness, overrides?: Record<string, unknown>, token?: string) =>
  h.app.request(
    "/api/v0/orgs",
    jsonReq("POST", { slug: "acme", display_name: "Acme", kind: "team", ...overrides }, token),
    {},
  );

describe("POST /api/v0/orgs", () => {
  it("creates a team org with the creator as owner", async () => {
    const h = makeHarness();
    const res = await createTeam(h);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { org: { slug: string; kind: string; id: string }; role: string };
    expect(body.org).toMatchObject({ slug: "acme", kind: "team" });
    expect(body.role).toBe("owner");
    expect(h.db.orgMembers).toMatchObject([{ org_id: body.org.id, pubkey: CALLER, role: "owner" }]);
  });

  it("rejects kind personal — personal orgs are only auto-created", async () => {
    const h = makeHarness();
    const res = await createTeam(h, { kind: "personal" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid-body", reason: "kind-must-be-team" });
  });

  it("409s reserved slugs from the blocklist", async () => {
    const h = makeHarness();
    for (const slug of ["boards", "api", "settings", "evenflow"]) {
      const res = await createTeam(h, { slug });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "conflict", reason: "slug-reserved" });
    }
  });

  it("409s a duplicate slug", async () => {
    const h = makeHarness();
    expect((await createTeam(h)).status).toBe(201);
    const res = await createTeam(h);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", reason: "slug-in-use" });
  });

  it("401s anonymous callers", async () => {
    const h = makeHarness();
    const res = await h.app.request(
      "/api/v0/orgs",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      {},
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v0/orgs/:slug", () => {
  it("serves public info to anyone — anonymous included — and internals to members", async () => {
    const h = makeHarness();
    await createTeam(h);
    const anon = await h.app.request("/api/v0/orgs/acme", {}, {});
    expect(anon.status).toBe(200);
    const anonBody = (await anon.json()) as { org: Record<string, unknown>; role: null };
    expect(anonBody.role).toBeNull();
    expect(anonBody.org["slug"]).toBe("acme");
    expect(anonBody.org["id"]).toBeUndefined(); // member-only field

    const member = await h.app.request("/api/v0/orgs/acme", { headers: bearer }, {});
    const memberBody = (await member.json()) as { org: Record<string, unknown>; role: string };
    expect(memberBody.role).toBe("owner");
    expect(memberBody.org["id"]).toBeDefined();
  });

  it("404s unknown orgs", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/v0/orgs/nope", { headers: bearer }, {});
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/v0/orgs/:slug", () => {
  it("updates display_name for admins", async () => {
    const h = makeHarness();
    await createTeam(h);
    const res = await h.app.request("/api/v0/orgs/acme", jsonReq("PATCH", { display_name: "Acme Industries" }), {});
    expect(res.status).toBe(200);
    expect(h.db.orgs[0]!["display_name"]).toBe("Acme Industries");
  });

  it("403s plain members and 404s outsiders", async () => {
    const h = makeHarness();
    await createTeam(h);
    seedOrgMember(h, h.db.orgs[0]!["id"] as string, pubkeyFor("mem"), "member");
    const asMember = await h.app.request(
      "/api/v0/orgs/acme",
      jsonReq("PATCH", { display_name: "X" }, tokenFor("mem")),
      {},
    );
    expect(asMember.status).toBe(403);
    const asOutsider = await h.app.request(
      "/api/v0/orgs/acme",
      jsonReq("PATCH", { display_name: "X" }, tokenFor("stranger")),
      {},
    );
    expect(asOutsider.status).toBe(404);
  });

  it("slug rename writes an alias; the old slug resolves via_alias", async () => {
    const h = makeHarness();
    await createTeam(h);
    const res = await h.app.request("/api/v0/orgs/acme", jsonReq("PATCH", { slug: "acme-industries" }), {});
    expect(res.status).toBe(200);
    expect(h.db.orgAliases).toMatchObject([{ old_slug: "acme" }]);

    const viaOld = await h.app.request("/api/v0/orgs/acme", { headers: bearer }, {});
    expect(viaOld.status).toBe(200);
    const body = (await viaOld.json()) as { org: { slug: string }; via_alias: boolean };
    expect(body.org.slug).toBe("acme-industries");
    expect(body.via_alias).toBe(true);
  });
});

describe("DELETE /api/v0/orgs/:slug + transfer", () => {
  it("soft-deletes a team org (owner only); subsequent GET 404s", async () => {
    const h = makeHarness();
    await createTeam(h);
    seedOrgMember(h, h.db.orgs[0]!["id"] as string, pubkeyFor("adm"), "admin");
    const asAdmin = await h.app.request(
      "/api/v0/orgs/acme",
      { method: "DELETE", headers: bearerFor(tokenFor("adm")) },
      {},
    );
    expect(asAdmin.status).toBe(403);

    const res = await h.app.request("/api/v0/orgs/acme", { method: "DELETE", headers: bearer }, {});
    expect(res.status).toBe(200);
    expect(h.db.orgs[0]!["deleted_at_ms"]).toBe(1_000);
    expect((await h.app.request("/api/v0/orgs/acme", { headers: bearer }, {})).status).toBe(404);
  });

  it("refuses to delete a personal org", async () => {
    const h = makeHarness();
    await createBoard(h); // auto-creates personal org "tester"
    const res = await h.app.request("/api/v0/orgs/tester", { method: "DELETE", headers: bearer }, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "conflict", reason: "personal-org-undeletable" });
  });

  it("transfer demands the slug typed back and owner role; then swaps the owner seat", async () => {
    const h = makeHarness();
    await createTeam(h);
    const wrong = await h.app.request(
      "/api/v0/orgs/acme/transfer",
      jsonReq("POST", { to_pubkey: pubkeyFor("next"), confirmation_slug: "oops" }),
      {},
    );
    expect(wrong.status).toBe(400);

    seedOrgMember(h, h.db.orgs[0]!["id"] as string, pubkeyFor("adm"), "admin");
    const asAdmin = await h.app.request(
      "/api/v0/orgs/acme/transfer",
      jsonReq("POST", { to_pubkey: pubkeyFor("next"), confirmation_slug: "acme" }, tokenFor("adm")),
      {},
    );
    expect(asAdmin.status).toBe(403);

    // EFB-38 behaviour change: the target must already be an org member.
    // This test used to transfer straight to pubkeyFor("next"), who was in no
    // roster — it passed only because to_pubkey was unvalidated. Add first,
    // then transfer, which is also the audit trail we want.
    seedOrgMember(h, h.db.orgs[0]!["id"] as string, pubkeyFor("next"), "member");
    const res = await h.app.request(
      "/api/v0/orgs/acme/transfer",
      jsonReq("POST", { to_pubkey: pubkeyFor("next"), confirmation_slug: "acme" }),
      {},
    );
    expect(res.status).toBe(200);
    const roles = Object.fromEntries(h.db.orgMembers.map((m) => [m["pubkey"], m["role"]]));
    expect(roles[pubkeyFor("next")]).toBe("owner");
    expect(roles[CALLER]).toBe("admin");
  });
});

describe("org members", () => {
  const setup = async (h: Harness) => {
    await createTeam(h);
    return h.db.orgs[0]!["id"] as string;
  };

  it("admin adds a member; member list requires membership", async () => {
    const h = makeHarness();
    await setup(h);
    const add = await h.app.request(
      "/api/v0/orgs/acme/members",
      jsonReq("POST", { pubkey: pubkeyFor("mem"), role: "member" }),
      {},
    );
    expect(add.status).toBe(201);

    const list = await h.app.request("/api/v0/orgs/acme/members", { headers: bearerFor(tokenFor("mem")) }, {});
    expect(list.status).toBe(200);
    const { members } = (await list.json()) as { members: Array<{ pubkey: string }> };
    expect(members.map((m) => m.pubkey).sort()).toEqual([CALLER, pubkeyFor("mem")].sort());

    const outsider = await h.app.request("/api/v0/orgs/acme/members", { headers: bearerFor(tokenFor("out")) }, {});
    expect(outsider.status).toBe(404);
  });

  it("only owners mint owners", async () => {
    const h = makeHarness();
    const orgId = await setup(h);
    seedOrgMember(h, orgId, pubkeyFor("adm"), "admin");
    const asAdmin = await h.app.request(
      "/api/v0/orgs/acme/members",
      jsonReq("POST", { pubkey: pubkeyFor("x"), role: "owner" }, tokenFor("adm")),
      {},
    );
    expect(asAdmin.status).toBe(403);
    const asOwner = await h.app.request(
      "/api/v0/orgs/acme/members",
      jsonReq("POST", { pubkey: pubkeyFor("x"), role: "owner" }),
      {},
    );
    expect(asOwner.status).toBe(201);
  });

  it("role changes work; the last owner can never be demoted or kicked", async () => {
    const h = makeHarness();
    const orgId = await setup(h);
    seedOrgMember(h, orgId, pubkeyFor("mem"), "member");

    const promote = await h.app.request(
      `/api/v0/orgs/acme/members/${encodeURIComponent(pubkeyFor("mem"))}`,
      jsonReq("PATCH", { role: "admin" }),
      {},
    );
    expect(promote.status).toBe(200);

    const demoteLastOwner = await h.app.request(
      `/api/v0/orgs/acme/members/${encodeURIComponent(CALLER)}`,
      jsonReq("PATCH", { role: "member" }),
      {},
    );
    expect(demoteLastOwner.status).toBe(409);

    const kickLastOwner = await h.app.request(
      `/api/v0/orgs/acme/members/${encodeURIComponent(CALLER)}`,
      { method: "DELETE", headers: bearer },
      {},
    );
    expect(kickLastOwner.status).toBe(409);
  });

  it("kick removes the org row but explicit board grants survive", async () => {
    const h = makeHarness();
    const orgId = await setup(h);
    seedOrgMember(h, orgId, pubkeyFor("mem"), "member");
    seedBoardMember(h, "some-board", pubkeyFor("mem"), "contributor");

    const res = await h.app.request(
      `/api/v0/orgs/acme/members/${encodeURIComponent(pubkeyFor("mem"))}`,
      { method: "DELETE", headers: bearer },
      {},
    );
    expect(res.status).toBe(200);
    expect(h.db.orgMembers.some((m) => m["pubkey"] === pubkeyFor("mem"))).toBe(false);
    expect(h.db.boardMembers).toMatchObject([{ board_id: "some-board", pubkey: pubkeyFor("mem") }]);
  });

  it("still succeeds when 4a grant publishes fail — substrate_event_id stays null", async () => {
    const h = makeHarness();
    await setup(h);
    h.fourA.failPublishes = true;
    const add = await h.app.request(
      "/api/v0/orgs/acme/members",
      jsonReq("POST", { pubkey: pubkeyFor("mem"), role: "member" }),
      {},
    );
    expect(add.status).toBe(201);
    const row = h.db.orgMembers.find((m) => m["pubkey"] === pubkeyFor("mem"));
    expect(row!["substrate_event_id"]).toBeNull();
  });
});

describe("board access role matrix", () => {
  /** Board "kb" in the caller's personal org, plus one user per board role. */
  const setup = async (h: Harness) => {
    await createBoard(h);
    await createIssue(h);
    const boardId = h.db.boards[0]!["id"] as string;
    seedBoardMember(h, boardId, pubkeyFor("view"), "viewer");
    seedBoardMember(h, boardId, pubkeyFor("contrib"), "contributor");
    seedBoardMember(h, boardId, pubkeyFor("badmin"), "admin");
    return boardId;
  };

  it("viewer reads but cannot create issues", async () => {
    const h = makeHarness();
    await setup(h);
    const read = await h.app.request("/api/v0/boards/kb/issues", { headers: bearerFor(tokenFor("view")) }, {});
    expect(read.status).toBe(200);
    const write = await h.app.request(
      "/api/v0/boards/kb/issues",
      jsonReq("POST", { title: "Nope" }, tokenFor("view")),
      {},
    );
    expect(write.status).toBe(403);
  });

  it("contributor creates issues but cannot PATCH the board", async () => {
    const h = makeHarness();
    await setup(h);
    const write = await h.app.request(
      "/api/v0/boards/kb/issues",
      jsonReq("POST", { title: "Mine" }, tokenFor("contrib")),
      {},
    );
    expect(write.status).toBe(201);
    const patch = await h.app.request(
      "/api/v0/boards/kb",
      jsonReq("PATCH", { title: "Hijacked" }, tokenFor("contrib")),
      {},
    );
    expect(patch.status).toBe(403);
  });

  it("board admin PATCHes the board", async () => {
    const h = makeHarness();
    await setup(h);
    const patch = await h.app.request(
      "/api/v0/boards/kb",
      jsonReq("PATCH", { title: "Renamed" }, tokenFor("badmin")),
      {},
    );
    expect(patch.status).toBe(200);
  });

  it("non-members and anonymous get 404 on a private board; anonymous mutations 401", async () => {
    const h = makeHarness();
    await setup(h);
    expect(
      (await h.app.request("/api/v0/boards/kb", { headers: bearerFor(tokenFor("out")) }, {})).status,
    ).toBe(404);
    expect((await h.app.request("/api/v0/boards/kb", {}, {})).status).toBe(404);
    const anonWrite = await h.app.request("/api/v0/boards/kb/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Anon" }),
    }, {});
    expect(anonWrite.status).toBe(401);
  });

  it("org membership projects onto org boards: member acts as contributor", async () => {
    const h = makeHarness();
    await setup(h);
    const orgId = h.db.orgs[0]!["id"] as string;
    seedOrgMember(h, orgId, pubkeyFor("orgmem"), "member");
    const write = await h.app.request(
      "/api/v0/boards/kb/issues",
      jsonReq("POST", { title: "Via org" }, tokenFor("orgmem")),
      {},
    );
    expect(write.status).toBe(201);
    const patch = await h.app.request(
      "/api/v0/boards/kb",
      jsonReq("PATCH", { title: "Nope" }, tokenFor("orgmem")),
      {},
    );
    expect(patch.status).toBe(403);
  });
});

// ── EFB-38: identity references on membership write paths ─────────────────
//
// Same invariant as assignee_pubkey (see tests/issues.test.ts): a pubkey
// FIELD that means "which person" is a reference with one written form, not
// a free string. `validatePubkey` used to accept any string under 256 chars,
// so `049b628c…` and `nostr:049b628c…` could both land in a roster as two
// members for one key.
//
// These endpoints get NORMALIZATION ONLY, not a membership check — they
// exist to add somebody who is not yet a member, so there is no roster to
// validate against. `assertMember`-style checks belong at sites like
// assignee, where the referent must already be present.
//
// The one exception is org transfer, which now requires the target to
// already be a member: handing an org to a stranger in a single call is a
// security hole, and add-then-transfer leaves a legible audit trail.
describe("EFB-38 identity references on membership writes", () => {
  const HEX = "049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2";
  const CANON = `nostr:${HEX}`;
  const BAD_SHAPES = ["not a pubkey", "nostr:", ":abc", "deadbeef", "   "];

  describe("POST /orgs/:slug/members", () => {
    const add = (h: Harness, pubkey: unknown) =>
      h.app.request("/api/v0/orgs/acme/members", jsonReq("POST", { pubkey, role: "member" }), {});
    const roster = (h: Harness) => h.db.orgMembers.map((m) => m["pubkey"]);

    it("normalizes raw hex to nostr: form", async () => {
      const h = makeHarness();
      await createTeam(h);
      expect((await add(h, HEX)).status).toBe(201);
      expect(roster(h)).toContain(CANON);
      expect(roster(h)).not.toContain(HEX);
    });

    it("normalizes uppercase hex to lowercase", async () => {
      const h = makeHarness();
      await createTeam(h);
      expect((await add(h, HEX.toUpperCase())).status).toBe(201);
      expect(roster(h)).toContain(CANON);
    });

    it.each(BAD_SHAPES)("400s on unrecognized shape %j", async (v) => {
      const h = makeHarness();
      await createTeam(h);
      expect((await add(h, v)).status).toBe(400);
      expect(roster(h)).toEqual([CALLER]);
    });

    it("accepts an already-canonical ref and re-adding is idempotent", async () => {
      const h = makeHarness();
      await createTeam(h);
      expect((await add(h, CANON)).status).toBe(201);
      // Raw hex for the SAME key must land on the SAME row, not a second one.
      // Counting only CANON rows would pass either way — pre-fix the raw form
      // is stored verbatim as an extra row — so assert the whole roster.
      expect((await add(h, HEX)).status).toBe(201);
      expect(roster(h).sort()).toEqual([CALLER, CANON].sort());
    });
  });

  describe("POST /orgs/:org/boards/:slug/members", () => {
    // The board lives in the caller's personal org, addressed by that org's
    // slug — same shape audiences.test.ts uses. Creating a team org here and
    // pointing at /orgs/acme/boards/kb 404s, since createBoard doesn't put
    // the board there.
    const setup = async (h: Harness) => {
      await createBoard(h);
      return callerOrg(h)["slug"] as string;
    };
    const add = (h: Harness, orgSlug: string, pubkey: unknown) =>
      h.app.request(
        `/api/v0/orgs/${orgSlug}/boards/kb/members`,
        jsonReq("POST", { pubkey, role: "contributor" }),
        {},
      );
    const roster = (h: Harness) => h.db.boardMembers.map((m) => m["pubkey"]);

    it("normalizes raw hex to nostr: form", async () => {
      const h = makeHarness();
      const org = await setup(h);
      expect((await add(h, org, HEX)).status).toBe(201);
      expect(roster(h)).toContain(CANON);
      expect(roster(h)).not.toContain(HEX);
    });

    it.each(BAD_SHAPES)("400s on unrecognized shape %j", async (v) => {
      const h = makeHarness();
      const org = await setup(h);
      const before = roster(h).length;
      expect((await add(h, org, v)).status).toBe(400);
      expect(roster(h)).toHaveLength(before);
    });

    it("accepts an already-canonical ref and re-adding is idempotent", async () => {
      const h = makeHarness();
      const org = await setup(h);
      const before = roster(h).length;
      expect((await add(h, org, CANON)).status).toBe(201);
      // Same key in raw form must not create a second row — assert the total,
      // since counting CANON alone passes with or without the fix.
      expect((await add(h, org, HEX)).status).toBe(201);
      expect(roster(h)).toHaveLength(before + 1);
      expect(roster(h)).toContain(CANON);
    });
  });

  describe("POST /orgs/:slug/transfer", () => {
    const transfer = (h: Harness, to_pubkey: unknown) =>
      h.app.request(
        "/api/v0/orgs/acme/transfer",
        jsonReq("POST", { to_pubkey, confirmation_slug: "acme" }),
        {},
      );

    // Behaviour CHANGE, deliberate: you may only hand an org to somebody who
    // is already in it. Add-then-transfer instead of transfer-to-stranger.
    it("400s transferring to a non-member", async () => {
      const h = makeHarness();
      await createTeam(h);
      const res = await transfer(h, pubkeyFor("stranger"));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ reason: "not-a-member" });
      const roles = Object.fromEntries(h.db.orgMembers.map((m) => [m["pubkey"], m["role"]]));
      expect(roles[CALLER]).toBe("owner");
    });

    it("normalizes raw hex and transfers to that member", async () => {
      const h = makeHarness();
      await createTeam(h);
      seedOrgMember(h, h.db.orgs[0]!["id"] as string, CANON, "member");
      expect((await transfer(h, HEX)).status).toBe(200);
      const roles = Object.fromEntries(h.db.orgMembers.map((m) => [m["pubkey"], m["role"]]));
      expect(roles[CANON]).toBe("owner");
      expect(roles[CALLER]).toBe("admin");
    });

    it.each(BAD_SHAPES)("400s on unrecognized shape %j", async (v) => {
      const h = makeHarness();
      await createTeam(h);
      expect((await transfer(h, v)).status).toBe(400);
    });
  });
});

// EFB-42: a `:pubkey` route param is a lookup key, and the rosters it looks
// into store canonical refs (EFB-38). Passing the param through raw meant
// `…/members/049b628c…` missed a member stored as `nostr:049b628c…` and came
// back 404 — the member existed, the caller just spelled them differently.
// Since EFB-41 that includes the `npub1…` spelling a Nostr client displays.
describe("EFB-42 :pubkey route param normalization", () => {
  const HEX = "049b628c4e18d562627fd924dea8dd6fe98d4dd3094fd85a53d84c0f5219b3c2";
  const CANON = `nostr:${HEX}`;
  const NPUB = "npub1qjdk9rzwrr2kycnlmyjda2xadl5c6nwnp98askjnmpxq75sek0pqr3fl3a";

  /** The four lookup endpoints, each seeded with the SAME member as CANON. */
  const SITES = [
    {
      label: "PATCH /orgs/:slug/members/:pubkey",
      setup: async (h: Harness) => {
        await createTeam(h);
        seedOrgMember(h, h.db.orgs.find((o) => o["slug"] === "acme")!["id"] as string, CANON, "member");
      },
      req: (p: string) => ["/api/v0/orgs/acme/members/" + p, jsonReq("PATCH", { role: "admin" })] as const,
    },
    {
      label: "DELETE /orgs/:slug/members/:pubkey",
      setup: async (h: Harness) => {
        await createTeam(h);
        seedOrgMember(h, h.db.orgs.find((o) => o["slug"] === "acme")!["id"] as string, CANON, "member");
      },
      req: (p: string) =>
        ["/api/v0/orgs/acme/members/" + p, { method: "DELETE", headers: bearer }] as const,
    },
    {
      label: "PATCH /orgs/:org_slug/boards/:slug/members/:pubkey",
      setup: async (h: Harness) => {
        await createBoard(h);
        seedBoardMember(h, h.db.boards[0]!["id"] as string, CANON, "viewer");
      },
      req: (p: string) =>
        ["/api/v0/orgs/tester/boards/kb/members/" + p, jsonReq("PATCH", { role: "contributor" })] as const,
    },
    {
      label: "DELETE /orgs/:org_slug/boards/:slug/members/:pubkey",
      setup: async (h: Harness) => {
        await createBoard(h);
        seedBoardMember(h, h.db.boards[0]!["id"] as string, CANON, "viewer");
      },
      req: (p: string) =>
        ["/api/v0/orgs/tester/boards/kb/members/" + p, { method: "DELETE", headers: bearer }] as const,
    },
  ] as const;

  describe.each(SITES)("$label", ({ setup, req }) => {
    // Baseline: the spelling the roster already stores must keep working.
    // Without this the other two cases can't tell "normalization works" from
    // "this endpoint accepts anything".
    it("resolves the canonical ref", async () => {
      const h = makeHarness();
      await setup(h);
      const [url, init] = req(CANON);
      expect((await h.app.request(url, init as RequestInit, {})).status).toBe(200);
    });

    // The actual bug: same member, hex spelling, used to 404.
    it("resolves the raw-hex spelling of that same member", async () => {
      const h = makeHarness();
      await setup(h);
      const [url, init] = req(HEX);
      expect((await h.app.request(url, init as RequestInit, {})).status).toBe(200);
    });

    // EFB-41 + EFB-42 composed: the spelling a Nostr client shows the user.
    it("resolves the npub spelling of that same member", async () => {
      const h = makeHarness();
      await setup(h);
      const [url, init] = req(NPUB);
      expect((await h.app.request(url, init as RequestInit, {})).status).toBe(200);
    });

    // 400, not 404: "you sent junk" and "no such member" are different
    // answers, and collapsing them makes a typo look like a removed teammate.
    it.each(["not-a-pubkey", "deadbeef", "nostr:", "npub1bad"])(
      "400s reason=pubkey on malformed %j, not 404",
      async (bad) => {
        const h = makeHarness();
        await setup(h);
        const [url, init] = req(bad);
        const res = await h.app.request(url, init as RequestInit, {});
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ reason: "pubkey" });
      },
    );

    // Shape-valid but absent stays 404 — normalization must not turn a
    // genuine "no such member" into a 400.
    it("still 404s a well-formed pubkey that is not a member", async () => {
      const h = makeHarness();
      await setup(h);
      const [url, init] = req("nostr:" + "1".repeat(64));
      const res = await h.app.request(url, init as RequestInit, {});
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ reason: "member" });
    });
  });
});
