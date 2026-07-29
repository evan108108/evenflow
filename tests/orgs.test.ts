// /api/v0/orgs — org CRUD, membership management, and the per-role board
// access matrix.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALLER,
  bearer,
  bearerFor,
  createBoard,
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
