// Phase-16 org surface tests: OrgSwitcher, /@handle identity + claim CTA,
// invite preview + accept, /o/new, /profile redirect, members panel, and
// board settings role changes. Transport is mocked at global fetch (the
// ApiClient seam every page runs through) plus the orgStore bootstrap seam.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import type { JSX } from "solid-js";
import {
  __resetOrgStore,
  __setBootstrapFetcher,
  bootstrap,
  type BootstrapResponse,
} from "../lib/orgStore";
import { __resetProfileStore, __setProfileFetcher } from "../lib/profileStore";
import { OrgSwitcher } from "../components/OrgSwitcher";
import { MembersPanel } from "../components/MembersPanel";
import { HandlePage } from "./HandlePage";
import { InvitePreview } from "./InvitePreview";
import { NewOrg } from "./NewOrg";
import { Profile } from "./Profile";
import { BoardSettings } from "./BoardSettings";

const BOOTSTRAP: BootstrapResponse = {
  me: {
    handle: "evan108108",
    pubkey: "google:1",
    login: "evan108108@gmail.com",
    orgs: [
      { slug: "evan108108", display_name: "Evan", avatar_url: null, kind: "personal", role: "owner" },
      { slug: "acme", display_name: "Acme", avatar_url: null, kind: "team", role: "admin" },
    ],
  },
  last_active_org: "evan108108",
};

/** header.payload.sig with just enough claims for pubkeyOfJwt. */
const FAKE_JWT = `x.${btoa(
  JSON.stringify({ provider: "google", oauth_id: "1", login: "evan108108@gmail.com" }),
)}.y`;

type FetchRoute = (url: string, init?: RequestInit) => { status: number; body: unknown } | null;

let fetchCalls: Array<{ url: string; method: string; body: unknown }> = [];

const installFetch = (route: FetchRoute) => {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      fetchCalls.push({ url, method, body });
      const matched = route(url, init) ?? { status: 404, body: { error: "not-found" } };
      return new Response(JSON.stringify(matched.body), {
        status: matched.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
};

const mountAt = (path: string, routePath: string, component: () => JSX.Element) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const history = createMemoryHistory();
  history.set({ value: path });
  const dispose = render(
    () => (
      <MemoryRouter history={history}>
        <Route path={routePath} component={component} />
        <Route path="*rest" component={() => <p>elsewhere</p>} />
      </MemoryRouter>
    ),
    container,
  );
  return {
    container,
    history,
    dispose: () => {
      dispose();
      container.remove();
    },
  };
};

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  __resetOrgStore();
  __resetProfileStore();
  __setProfileFetcher(() => Promise.resolve([]));
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setBootstrapFetcher(null);
  __setProfileFetcher(null);
});

describe("orgStore.bootstrap", () => {
  it("coalesces concurrent callers into one request and caches the result", async () => {
    let calls = 0;
    __setBootstrapFetcher(() => {
      calls += 1;
      return Promise.resolve(BOOTSTRAP);
    });
    const [a, b] = await Promise.all([bootstrap(), bootstrap()]);
    await bootstrap();
    expect(calls).toBe(1);
    expect(a?.handle).toBe("evan108108");
    expect(b?.orgs.length).toBe(2);
  });

  it("forwards a stashed claimed handle exactly once", async () => {
    const bodies: Array<{ claim?: string }> = [];
    __setBootstrapFetcher((body) => {
      bodies.push(body);
      return Promise.resolve(BOOTSTRAP);
    });
    window.localStorage.setItem("evenflow.claimHandle", "wavelength");
    await bootstrap();
    await bootstrap({ force: true });
    expect(bodies[0]).toEqual({ claim: "wavelength" });
    expect(bodies[1]).toEqual({});
  });
});

describe("OrgSwitcher", () => {
  it("renders every org with role chips and the create hand-off", async () => {
    __setBootstrapFetcher(() => Promise.resolve(BOOTSTRAP));
    const { container, dispose } = mountAt("/boards", "/boards", () => <OrgSwitcher current="acme" />);
    await tick();
    container.querySelector<HTMLButtonElement>(".org-switcher-btn")?.click();
    await tick();
    const items = [...container.querySelectorAll(".org-switcher-item")];
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Evan"),
      expect.stringContaining("Acme"),
      expect.stringContaining("Create org"),
    ]);
    expect(container.textContent).toContain("owner");
    expect(container.textContent).toContain("admin");
    expect(container.querySelector(".org-switcher-create")?.getAttribute("href")).toBe("/o/new");
    dispose();
  });

  it("navigates to the picked org and persists it as last-active", async () => {
    __setBootstrapFetcher(() => Promise.resolve(BOOTSTRAP));
    const { container, history, dispose } = mountAt("/boards", "/boards", () => <OrgSwitcher />);
    await tick();
    container.querySelector<HTMLButtonElement>(".org-switcher-btn")?.click();
    await tick();
    const acme = [...container.querySelectorAll<HTMLButtonElement>(".org-switcher-item")].find(
      (i) => i.textContent?.includes("Acme"),
    );
    acme?.click();
    await tick();
    expect(history.get()).toBe("/@acme");
    expect(window.localStorage.getItem("evenflow.lastActiveOrg")).toBe("acme");
    dispose();
  });
});

describe("HandlePage", () => {
  it("renders the org header and boards for a known handle", async () => {
    installFetch((url) => {
      if (url.endsWith("/api/v0/orgs/acme")) {
        return {
          status: 200,
          body: {
            org: { slug: "acme", display_name: "Acme", avatar_url: null, bio: "We flow.", kind: "team" },
            role: null,
          },
        };
      }
      if (url.endsWith("/api/v0/orgs/acme/boards")) {
        return {
          status: 200,
          body: {
            boards: [
              { id: "b1", slug: "roadmap", title: "Roadmap", visibility: "public", updated_at_ms: 1 },
            ],
            total: 1,
          },
        };
      }
      return null;
    });
    __setBootstrapFetcher(() => Promise.reject(new Error("signed out")));
    const { container, dispose } = mountAt("/@acme", "/:handle", () => <HandlePage />);
    await tick(60);
    expect(container.textContent).toContain("Acme");
    expect(container.textContent).toContain("We flow.");
    const link = container.querySelector('a[href="/@acme/roadmap"]');
    expect(link?.textContent).toContain("Roadmap");
    dispose();
  });

  it("renders the claim CTA for an unknown handle", async () => {
    installFetch(() => ({ status: 404, body: { error: "not-found" } }));
    __setBootstrapFetcher(() => Promise.reject(new Error("signed out")));
    const { container, dispose } = mountAt("/@wavelength", "/:handle", () => <HandlePage />);
    await tick(60);
    expect(container.textContent).toContain("This handle is available");
    expect(container.textContent).toContain("Sign up with Google");
    dispose();
  });
});

describe("InvitePreview", () => {
  const PREVIEW = {
    code: "inv-abc12345",
    org: { slug: "acme", display_name: "Acme", avatar_url: null },
    board: { slug: "roadmap", title: "Roadmap" },
    role: "contributor",
    invited_by_profile: { pubkey: "google:9", name: null, display_name: "Ada", picture: null },
    expires_at_ms: Date.now() + 5 * 86_400_000,
    bind_to_email: false,
    valid: true,
  };

  it("renders inviter, target, and role from the anonymous resolve", async () => {
    installFetch((url) => {
      if (url.includes("/api/v0/invites/inv-abc12345") && !url.includes("accept")) {
        return { status: 200, body: PREVIEW };
      }
      return null;
    });
    const { container, dispose } = mountAt("/i/inv-abc12345", "/i/:code", () => <InvitePreview />);
    await tick(60);
    expect(container.textContent).toContain("Ada invited you");
    expect(container.textContent).toContain("Roadmap");
    expect(container.textContent).toContain("contributor");
    expect(container.textContent).toContain("Accept with Google");
    dispose();
  });

  it("signed-in Accept POSTs and navigates to the returned target", async () => {
    window.localStorage.setItem("evenflow.jwt", FAKE_JWT);
    installFetch((url, init) => {
      if (url.endsWith("/accept") && init?.method === "POST") {
        return { status: 200, body: { accepted: true, target_url: "/@acme/roadmap" } };
      }
      if (url.includes("/api/v0/invites/inv-abc12345")) return { status: 200, body: PREVIEW };
      return null;
    });
    const { container, history, dispose } = mountAt("/i/inv-abc12345", "/i/:code", () => <InvitePreview />);
    await tick(60);
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Accept")?.click();
    await tick(60);
    expect(
      fetchCalls.some((c) => c.url.endsWith("/api/v0/invites/inv-abc12345/accept") && c.method === "POST"),
    ).toBe(true);
    expect(history.get()).toBe("/@acme/roadmap");
    dispose();
  });

  it("shows the lapse reason instead of Accept for dead invites", async () => {
    installFetch((url) => {
      if (url.includes("/api/v0/invites/")) {
        return { status: 200, body: { ...PREVIEW, valid: false, reason: "expired" } };
      }
      return null;
    });
    const { container, dispose } = mountAt("/i/inv-abc12345", "/i/:code", () => <InvitePreview />);
    await tick(60);
    expect(container.textContent).toContain("drifted past its expiration");
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Accept",
    );
    dispose();
  });
});

describe("NewOrg", () => {
  it("derives the handle from the name and POSTs the team-org body", async () => {
    window.localStorage.setItem("evenflow.jwt", FAKE_JWT);
    installFetch((url, init) => {
      if (url.endsWith("/api/v0/orgs") && init?.method === "POST") {
        return { status: 201, body: { org: { slug: "wave-crest" }, role: "owner" } };
      }
      if (url.endsWith("/api/v0/session/bootstrap")) return { status: 200, body: BOOTSTRAP };
      return null;
    });
    const { container, dispose } = mountAt("/o/new", "/o/new", () => <NewOrg />);
    await tick();
    const name = container.querySelector<HTMLInputElement>("#org-name")!;
    name.value = "Wave Crest";
    name.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await tick();
    expect(container.querySelector<HTMLInputElement>("#org-slug")!.value).toBe("wave-crest");
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true }));
    await tick(60);
    const post = fetchCalls.find((c) => c.url.endsWith("/api/v0/orgs") && c.method === "POST");
    expect(post?.body).toEqual({ kind: "team", slug: "wave-crest", display_name: "Wave Crest" });
    dispose();
  });
});

describe("Profile redirect", () => {
  it("bounces /profile to /@{me}/settings", async () => {
    window.localStorage.setItem("evenflow.jwt", FAKE_JWT);
    __setBootstrapFetcher(() => Promise.resolve(BOOTSTRAP));
    const { history, dispose } = mountAt("/profile", "/profile", () => <Profile />);
    await tick(60);
    expect(history.get()).toBe("/@evan108108/settings");
    dispose();
  });
});

describe("MembersPanel", () => {
  const MEMBERS = [
    { pubkey: "google:1", role: "admin", added_at_ms: 1 },
    { pubkey: "google:2", role: "viewer", added_at_ms: 2 },
  ];

  it("gives managed rows a role dropdown + kick, but never on the caller's own row", () => {
    const changes: Array<[string, string]> = [];
    const kicks: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <MembersPanel
          members={MEMBERS}
          roles={["admin", "contributor", "viewer"]}
          canManage={true}
          selfPubkey="google:1"
          onRoleChange={(p, r) => changes.push([p, r])}
          onKick={(p) => kicks.push(p)}
        />
      ),
      container,
    );
    const rows = [...container.querySelectorAll(".member-row")];
    expect(rows.length).toBe(2);
    expect(rows[0]?.querySelector("select")).toBeNull(); // self — read-only
    const select = rows[1]?.querySelector("select");
    expect(select).not.toBeNull();
    select!.value = "contributor";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(changes).toEqual([["google:2", "contributor"]]);
    rows[1]?.querySelector<HTMLButtonElement>("button.btn-danger")?.click();
    expect(kicks).toEqual(["google:2"]);
    dispose();
    container.remove();
  });

  it("renders read-only chips when the caller cannot manage", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <MembersPanel
          members={MEMBERS}
          roles={["admin", "viewer"]}
          canManage={false}
          selfPubkey={null}
          onRoleChange={() => {}}
          onKick={() => {}}
        />
      ),
      container,
    );
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).toContain("admin");
    expect(container.textContent).toContain("viewer");
    dispose();
    container.remove();
  });
});

describe("BoardSettings", () => {
  it("renders the members panel and fires PATCH on a role change", async () => {
    window.localStorage.setItem("evenflow.jwt", FAKE_JWT);
    installFetch((url, init) => {
      if (url.endsWith("/api/v0/orgs/acme/boards/roadmap")) {
        return {
          status: 200,
          body: { board: { id: "b1", slug: "roadmap", title: "Roadmap", visibility: "private" } },
        };
      }
      if (url.endsWith("/members") && (init?.method ?? "GET") === "GET") {
        return {
          status: 200,
          body: {
            members: [
              { pubkey: "google:1", role: "admin", added_at_ms: 1 },
              { pubkey: "google:2", role: "viewer", added_at_ms: 2 },
            ],
          },
        };
      }
      if (url.includes("/members/") && init?.method === "PATCH") {
        return { status: 200, body: { pubkey: "google:2", role: "contributor" } };
      }
      if (url.endsWith("/invites")) return { status: 200, body: { invites: [] } };
      if (url.endsWith("/api/v0/profile/me")) {
        return { status: 200, body: { profile: { pubkey: "google:1" } } };
      }
      return null;
    });
    const { container, dispose } = mountAt("/@acme/roadmap/settings", "/:handle/:board_slug/settings", () => <BoardSettings />);
    await tick(80);
    expect(container.textContent).toContain("Board settings");
    expect(container.textContent).toContain("Private");
    const select = container.querySelector<HTMLSelectElement>(".member-row select");
    expect(select).not.toBeNull();
    select!.value = "contributor";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(60);
    expect(
      fetchCalls.some(
        (c) =>
          c.url.endsWith("/api/v0/orgs/acme/boards/roadmap/members/google%3A2") &&
          c.method === "PATCH" &&
          (c.body as { role: string }).role === "contributor",
      ),
    ).toBe(true);
    dispose();
  });
});
