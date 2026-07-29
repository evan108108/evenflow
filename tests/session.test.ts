// /api/v0/session/bootstrap — personal-org auto-creation + org roster.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonReq, makeHarness, tokenFor, CALLER } from "./harness";

interface BootstrapBody {
  me: { handle: string; pubkey: string; login: string; orgs: Array<{ slug: string; role: string; kind: string }> };
  last_active_org: string;
  personal_org_created: boolean;
}

const bootstrap = (h: ReturnType<typeof makeHarness>, token?: string, body?: unknown) =>
  h.app.request("/api/v0/session/bootstrap", jsonReq("POST", body ?? {}, token), {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/v0/session/bootstrap", () => {
  it("creates the personal org on first call: slug from login-prefix, owner membership", async () => {
    const h = makeHarness();
    const res = await bootstrap(h);
    expect(res.status).toBe(200);
    const body = (await res.json()) as BootstrapBody;
    expect(body.me.handle).toBe("tester");
    expect(body.me.pubkey).toBe(CALLER);
    expect(body.last_active_org).toBe("tester");
    expect(body.personal_org_created).toBe(true);
    expect(body.me.orgs).toMatchObject([{ slug: "tester", kind: "personal", role: "owner" }]);
    expect(h.db.orgs).toHaveLength(1);
    expect(h.db.orgMembers).toMatchObject([{ pubkey: CALLER, role: "owner" }]);
  });

  it("is idempotent: a second call reuses the org", async () => {
    const h = makeHarness();
    await bootstrap(h);
    const res = await bootstrap(h);
    const body = (await res.json()) as BootstrapBody;
    expect(body.personal_org_created).toBe(false);
    expect(h.db.orgs).toHaveLength(1);
    expect(h.db.orgMembers).toHaveLength(1);
  });

  it("digit-suffixes the slug when the login-prefix is taken", async () => {
    const h = makeHarness();
    h.db.orgs.push({
      id: "org-x", slug: "tester", display_name: "Squatter", avatar_url: null, bio: null,
      kind: "team", created_by: "test:squatter", substrate_event_id: null,
      created_at_ms: 1, updated_at_ms: 1, deleted_at_ms: null,
    });
    const res = await bootstrap(h);
    const body = (await res.json()) as BootstrapBody;
    expect(body.me.handle).toBe("tester2");
  });

  it("skips reserved slugs — login 'admin@…' never claims /@admin", async () => {
    const h = makeHarness();
    const res = await bootstrap(h, tokenFor("admin"));
    const body = (await res.json()) as BootstrapBody;
    expect(body.me.handle).toBe("admin2");
  });

  it("honors a valid ?claim= handle hint from the sign-up CTA", async () => {
    const h = makeHarness();
    const res = await bootstrap(h, undefined, { claim: "wavemaker" });
    const body = (await res.json()) as BootstrapBody;
    expect(body.me.handle).toBe("wavemaker");
  });

  it("falls back to login-prefix when the claim hint is malformed", async () => {
    const h = makeHarness();
    const res = await bootstrap(h, undefined, { claim: "Not A Handle!" });
    const body = (await res.json()) as BootstrapBody;
    expect(body.me.handle).toBe("tester");
  });

  it("401s anonymous callers", async () => {
    const h = makeHarness();
    const res = await h.app.request("/api/v0/session/bootstrap", { method: "POST" }, {});
    expect(res.status).toBe(401);
  });

  it("still succeeds when 4a publishes fail — substrate_event_id stays null", async () => {
    const h = makeHarness();
    h.fourA.failPublishes = true;
    const res = await bootstrap(h);
    expect(res.status).toBe(200);
    expect(h.db.orgs[0]!["substrate_event_id"]).toBeNull();
    expect(h.db.orgMembers[0]!["substrate_event_id"]).toBeNull();
  });
});
