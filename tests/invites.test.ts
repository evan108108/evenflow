// /api/v0/invites — full lifecycle: create, anonymous resolve, accept
// (including the single-use race), decline, revoke, expiry, email binding,
// rate limiting, and the email send.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALLER,
  bearer,
  bearerFor,
  createBoard,
  jsonReq,
  makeHarness,
  pubkeyFor,
  tokenFor,
  type Harness,
} from "./harness";

interface InviteCreateBody {
  invite: { id: string; code: string; role: string; expires_at_ms: number };
  url: string;
}

const createInvite = async (
  h: Harness,
  overrides?: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; body: InviteCreateBody }> => {
  const res = await h.app.request(
    "/api/v0/invites",
    jsonReq(
      "POST",
      { org_slug: "tester", board_slug: "kb", role: "contributor", ...overrides },
      token,
    ),
    {},
  );
  return { status: res.status, body: (await res.json()) as InviteCreateBody };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/v0/invites", () => {
  it("creates a board invite: inv- code, full URL, 7-day default expiry", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { status, body } = await createInvite(h);
    expect(status).toBe(201);
    expect(body.invite.code).toMatch(/^inv-[a-z0-9]{8}$/);
    expect(body.url).toBe(`https://evenflow.work/i/${body.invite.code}`);
    expect(body.invite.expires_at_ms).toBe(1_000 + 168 * 60 * 60 * 1000);
  });

  it("rejects the owner role and non-admin creators", async () => {
    const h = makeHarness();
    await createBoard(h);
    expect((await createInvite(h, { role: "owner", board_slug: undefined })).status).toBe(400);
    expect((await createInvite(h, {}, tokenFor("stranger"))).status).toBe(404);
  });

  it("rate-limits at 50 per admin per board per day", async () => {
    const h = makeHarness();
    await createBoard(h);
    for (let i = 0; i < 50; i++) {
      expect((await createInvite(h)).status).toBe(201);
    }
    const { status } = await createInvite(h);
    expect(status).toBe(429);
    // A different board is a separate bucket.
    await createBoard(h, "kb2");
    expect((await createInvite(h, { board_slug: "kb2" })).status).toBe(201);
  });
});

describe("GET /api/v0/invites/:code", () => {
  it("resolves anonymously with inviter/org/board preview", async () => {
    const h = makeHarness();
    await createBoard(h);
    h.db.profiles.push({ pubkey: CALLER, name: "tester", display_name: "The Tester", picture: null });
    const { body } = await createInvite(h);

    const res = await h.app.request(`/api/v0/invites/${body.invite.code}`, {}, {});
    expect(res.status).toBe(200);
    const preview = (await res.json()) as Record<string, unknown>;
    expect(preview["valid"]).toBe(true);
    expect(preview["org"]).toMatchObject({ slug: "tester" });
    expect(preview["board"]).toMatchObject({ slug: "kb" });
    expect(preview["role"]).toBe("contributor");
    expect(preview["invited_by_profile"]).toMatchObject({ display_name: "The Tester" });
  });

  it("404s unknown codes and flags expired ones", async () => {
    const h = makeHarness();
    await createBoard(h);
    expect((await h.app.request("/api/v0/invites/inv-nope1234", {}, {})).status).toBe(404);

    const { body } = await createInvite(h, { expires_hours: 1 });
    vi.setSystemTime(1_000 + 2 * 60 * 60 * 1000);
    const res = await h.app.request(`/api/v0/invites/${body.invite.code}`, {}, {});
    const preview = (await res.json()) as Record<string, unknown>;
    expect(preview["valid"]).toBe(false);
    expect(preview["reason"]).toBe("expired");
  });
});

describe("POST /api/v0/invites/:code/accept", () => {
  it("grants board membership, marks used, and returns the canonical target URL", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { body } = await createInvite(h);

    const res = await h.app.request(
      `/api/v0/invites/${body.invite.code}/accept`,
      jsonReq("POST", {}, tokenFor("guest")),
      {},
    );
    expect(res.status).toBe(200);
    const accepted = (await res.json()) as { target_url: string; role: string };
    expect(accepted.target_url).toBe("/@tester/kb");
    expect(accepted.role).toBe("contributor");
    expect(h.db.boardMembers).toMatchObject(
      expect.arrayContaining([
        expect.objectContaining({ pubkey: pubkeyFor("guest"), role: "contributor" }),
      ]),
    );
    const row = h.db.invites.find((i) => i["code"] === body.invite.code)!;
    expect(row["used_by"]).toBe(pubkeyFor("guest"));

    // The guest can now read the private board.
    const read = await h.app.request("/api/v0/boards/kb", { headers: bearerFor(tokenFor("guest")) }, {});
    expect(read.status).toBe(200);
  });

  it("single-use race: the second accept 409s", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { body } = await createInvite(h);
    const first = await h.app.request(
      `/api/v0/invites/${body.invite.code}/accept`,
      jsonReq("POST", {}, tokenFor("first")),
      {},
    );
    expect(first.status).toBe(200);
    const second = await h.app.request(
      `/api/v0/invites/${body.invite.code}/accept`,
      jsonReq("POST", {}, tokenFor("second")),
      {},
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "conflict", reason: "invite-used" });
  });

  it("multi-use invites admit several members", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { body } = await createInvite(h, { single_use: false });
    for (const who of ["a", "b"]) {
      const res = await h.app.request(
        `/api/v0/invites/${body.invite.code}/accept`,
        jsonReq("POST", {}, tokenFor(who)),
        {},
      );
      expect(res.status).toBe(200);
    }
  });

  it("org-scope invites write orgMemberCache", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { body } = await createInvite(h, { board_slug: undefined, role: "member" });
    const res = await h.app.request(
      `/api/v0/invites/${body.invite.code}/accept`,
      jsonReq("POST", {}, tokenFor("joiner")),
      {},
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { target_url: string }).target_url).toBe("/@tester");
    expect(h.db.orgMembers).toMatchObject(
      expect.arrayContaining([
        expect.objectContaining({ pubkey: pubkeyFor("joiner"), role: "member" }),
      ]),
    );
  });

  it("rejects expired, declined, and revoked invites with 409; anonymous with 401", async () => {
    const h = makeHarness();
    await createBoard(h);

    const expired = await createInvite(h, { expires_hours: 1 });
    vi.setSystemTime(1_000 + 2 * 60 * 60 * 1000);
    const late = await h.app.request(
      `/api/v0/invites/${expired.body.invite.code}/accept`,
      jsonReq("POST", {}, tokenFor("late")),
      {},
    );
    expect(late.status).toBe(409);

    const declined = await createInvite(h);
    await h.app.request(
      `/api/v0/invites/${declined.body.invite.code}/decline`,
      jsonReq("POST", {}, tokenFor("no")),
      {},
    );
    const afterDecline = await h.app.request(
      `/api/v0/invites/${declined.body.invite.code}/accept`,
      jsonReq("POST", {}, tokenFor("no")),
      {},
    );
    expect(afterDecline.status).toBe(409);
    expect(await afterDecline.json()).toEqual({ error: "conflict", reason: "invite-declined" });

    const revoked = await createInvite(h);
    const del = await h.app.request(
      `/api/v0/invites/${revoked.body.invite.id}`,
      { method: "DELETE", headers: bearer },
      {},
    );
    expect(del.status).toBe(200);
    const afterRevoke = await h.app.request(
      `/api/v0/invites/${revoked.body.invite.code}/accept`,
      jsonReq("POST", {}, tokenFor("later")),
      {},
    );
    expect(afterRevoke.status).toBe(409);

    const anon = await h.app.request(
      `/api/v0/invites/${revoked.body.invite.code}/accept`,
      { method: "POST" },
      {},
    );
    expect(anon.status).toBe(401);
  });

  it("bind_to_email only admits the invited mailbox", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { body } = await createInvite(h, {
      invited_email: "right@example.com",
      bind_to_email: true,
    });
    // tokenFor("wrong") carries login wrong@example.com.
    const wrong = await h.app.request(
      `/api/v0/invites/${body.invite.code}/accept`,
      jsonReq("POST", {}, tokenFor("wrong")),
      {},
    );
    expect(wrong.status).toBe(403);
    const right = await h.app.request(
      `/api/v0/invites/${body.invite.code}/accept`,
      jsonReq("POST", {}, tokenFor("right")),
      {},
    );
    expect(right.status).toBe(200);
  });

  it("still succeeds when the 4a grant publish fails — membership cached, event null", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { body } = await createInvite(h);
    h.fourA.failPublishes = true;
    const res = await h.app.request(
      `/api/v0/invites/${body.invite.code}/accept`,
      jsonReq("POST", {}, tokenFor("guest")),
      {},
    );
    expect(res.status).toBe(200);
    const row = h.db.boardMembers.find((m) => m["pubkey"] === pubkeyFor("guest"))!;
    expect(row["substrate_event_id"]).toBeNull();
  });
});

describe("invite email + pending lists", () => {
  it("POST /invites/:id/email sends via AgentMail with the editorial subject", async () => {
    const h = makeHarness();
    await createBoard(h);
    h.db.profiles.push({ pubkey: CALLER, name: "tester", display_name: "The Tester", picture: null });
    const { body } = await createInvite(h, { invited_email: "friend@example.com" });

    const res = await h.app.request(`/api/v0/invites/${body.invite.id}/email`, jsonReq("POST", {}), {});
    expect(res.status).toBe(200);
    expect(h.email.sent).toHaveLength(1);
    expect(h.email.sent[0]!.to).toBe("friend@example.com");
    expect(h.email.sent[0]!.subject).toBe("[Evenflow] The Tester invited you to @tester/kb");
    expect(h.email.sent[0]!.html).toContain(`/i/${body.invite.code}`);
  });

  it("400s emailing an invite that has no address", async () => {
    const h = makeHarness();
    await createBoard(h);
    const { body } = await createInvite(h);
    const res = await h.app.request(`/api/v0/invites/${body.invite.id}/email`, jsonReq("POST", {}), {});
    expect(res.status).toBe(400);
  });

  it("pending lists show live invites and drop revoked ones", async () => {
    const h = makeHarness();
    await createBoard(h);
    const a = await createInvite(h);
    const b = await createInvite(h);

    const list = await h.app.request("/api/v0/orgs/tester/boards/kb/invites", { headers: bearer }, {});
    expect(list.status).toBe(200);
    expect(((await list.json()) as { invites: unknown[] }).invites).toHaveLength(2);

    await h.app.request(`/api/v0/invites/${a.body.invite.id}`, { method: "DELETE", headers: bearer }, {});
    const after = await h.app.request("/api/v0/orgs/tester/boards/kb/invites", { headers: bearer }, {});
    const remaining = (await after.json()) as { invites: Array<{ id: string }> };
    expect(remaining.invites.map((i) => i.id)).toEqual([b.body.invite.id]);
  });
});
