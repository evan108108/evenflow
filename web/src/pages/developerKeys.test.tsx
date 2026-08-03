// Phase 19 web tests: the DeveloperKeys page (list, one-time mint reveal,
// revoke) over stubbed fetch, and the public /docs render.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { url } from "@routes-manifest";
import { render } from "solid-js/web";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { DeveloperKeys } from "./DeveloperKeys";
import { Docs } from "./Docs";
import { pathOf, REST_SECTIONS, MCP_TOOLS } from "./docs/rest-spec";

// EFB-95. `key.create` and `key.list` both render "/keys" and differ only by
// verb, so a test that asserts the resulting URL cannot tell them apart — it
// passes with either id in the source. (Verified, not assumed: reinstating the
// bug left a URL-asserting version of this test green.) The only observable
// that distinguishes them is the ARGUMENT handed to url(), so the manifest
// module is wrapped to record ids. vi.hoisted because vi.mock is hoisted above
// const initialisation.
const { urlIds } = vi.hoisted(() => ({ urlIds: [] as string[] }));

vi.mock("@routes-manifest", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@routes-manifest")>();
  return {
    ...mod,
    url: (id: string, ...rest: unknown[]) => {
      urlIds.push(id);
      return (mod.url as unknown as (...a: unknown[]) => string)(id, ...rest);
    },
  };
});

const KEYS = [
  { id: "k1", name: "CI bot", prefix: "evk_abcd1234", created_at_ms: 1_700_000_000_000, last_used_at_ms: null, revoked_at_ms: null },
  { id: "k2", name: "Old key", prefix: "evk_dead0000", created_at_ms: 1_600_000_000_000, last_used_at_ms: 1_650_000_000_000, revoked_at_ms: 1_690_000_000_000 },
];

let calls: Array<{ method: string; url: string; body?: unknown }>;

beforeEach(() => {
  calls = [];
  urlIds.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: method === "POST" ? 201 : 200, headers: { "Content-Type": "application/json" } });
      if (method === "POST") {
        return json({
          key: { id: "k3", name: "fresh", prefix: "evk_fresh000", created_at_ms: 1, last_used_at_ms: null, revoked_at_ms: null },
          plaintext: "evk_fresh000_THE_ONE_TIME_PLAINTEXT",
        });
      }
      if (method === "DELETE") return json({ revoked: true });
      return json({ keys: KEYS });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const mountPage = async (component: () => unknown, path = "/settings/keys", route = "/settings/keys") => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const history = createMemoryHistory();
  history.set({ value: path });
  const dispose = render(
    () => (
      <MemoryRouter history={history}>
        <Route path={route} component={component as () => any} />
      </MemoryRouter>
    ),
    container,
  );
  await flush();
  await flush();
  return { container, cleanup: () => { dispose(); container.remove(); } };
};

describe("DeveloperKeys", () => {
  it("lists keys with prefixes; revoked rows are marked, not actionable", async () => {
    const { container, cleanup } = await mountPage(DeveloperKeys);
    const rows = [...container.querySelectorAll<HTMLElement>(".key-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector(".key-prefix")!.textContent).toBe("evk_abcd1234…");
    expect(rows[0]!.querySelector("button")!.textContent).toBe("Revoke");
    expect(rows[1]!.classList.contains("revoked")).toBe(true);
    expect(rows[1]!.querySelector("button")).toBeNull();
    expect(rows[1]!.textContent).toContain("revoked");
    cleanup();
  });

  it("mints a key and reveals the plaintext exactly once, with copy", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container, cleanup } = await mountPage(DeveloperKeys);

    const input = container.querySelector<HTMLInputElement>(".key-create input")!;
    input.value = "fresh";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Create key")!
      .click();
    await flush();
    await flush();

    expect(calls.some((c) => c.method === "POST" && c.url.endsWith(url("key.create")))).toBe(true);
    const modal = container.querySelector(".modal")!;
    expect(modal.textContent).toContain("only a hash");
    expect(modal.querySelector("code")!.textContent).toBe("evk_fresh000_THE_ONE_TIME_PLAINTEXT");

    modal.querySelector<HTMLButtonElement>(".key-reveal button")!.click();
    expect(writeText).toHaveBeenCalledWith("evk_fresh000_THE_ONE_TIME_PLAINTEXT");

    [...modal.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "I've stored it")!
      .click();
    await flush();
    expect(container.querySelector(".modal")).toBeNull();
    expect(container.textContent).not.toContain("THE_ONE_TIME_PLAINTEXT");
    cleanup();
  });

  // EFB-95. Asking for `key.create` and issuing a GET produced a working
  // request, so the page and the manifest disagreed in silence about what it
  // was doing — the exact class the manifest exists to eliminate. What is
  // pinned is the id, because the URL cannot distinguish them (see the mock).
  it("asks the manifest for the LIST id, not the create id", async () => {
    const { cleanup } = await mountPage(DeveloperKeys);
    expect(urlIds).toContain("key.list");
    expect(urlIds).not.toContain("key.create");
    cleanup();
  });

  // EFB-95. The page had a route and no way in: every link to /settings/keys
  // lived in /docs prose, so the only users who could reach their own key
  // management were the ones who already knew the URL. A management surface
  // nobody can navigate to is not covered, whatever the page itself does — so
  // the menu entry is pinned here alongside the page's own behaviour.
  it("is reachable from the user menu, not just by knowing the URL", async () => {
    const { container, cleanup } = await mountPage(DeveloperKeys);
    container.querySelector<HTMLButtonElement>(".user-nav-btn")!.click();
    await flush();
    const entry = [...container.querySelectorAll<HTMLAnchorElement>(".user-nav-menu a")].find(
      (a) => a.getAttribute("href") === "/settings/keys",
    );
    expect(entry).toBeDefined();
    expect(entry!.textContent!.trim()).toBe("API keys");
    cleanup();
  });

  // EFB-95. Revoke is destructive and has no inverse, so it asks first — the
  // same window.confirm gate the issue and sprint deletes use.
  it("revoke fires the DELETE once confirmed, naming the key in the prompt", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container, cleanup } = await mountPage(DeveloperKeys);
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Revoke")!
      .click();
    await flush();
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("CI bot"));
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(url("key.delete", { id: "k1" })))).toBe(true);
    confirmSpy.mockRestore();
    cleanup();
  });

  it("sends nothing at all when the revoke confirm is dismissed", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container, cleanup } = await mountPage(DeveloperKeys);
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Revoke")!
      .click();
    await flush();
    expect(confirmSpy).toHaveBeenCalled();
    // The point of the gate: a dismissed prompt must not have already fired.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    cleanup();
  });
});

describe("Docs", () => {
  it("renders every spec'd REST endpoint and MCP tool, publicly", async () => {
    const { container, cleanup } = await mountPage(Docs, "/docs", "/docs");
    // No authed fetches — the page is static.
    expect(calls).toHaveLength(0);
    const text = container.textContent!;
    for (const section of REST_SECTIONS) {
      expect(text).toContain(section.title);
      for (const e of section.endpoints) expect(text).toContain(pathOf(e));
    }
    for (const tool of MCP_TOOLS) expect(text).toContain(tool.name);
    expect(text).toContain("https://evenflow.work/mcp");
    expect(text).toContain("/evenflow skill");
    cleanup();
  });

  // EFB-57. The attachment-privacy notice on the issue sheet links here by
  // anchor. If this section is ever renamed or dropped, that notice silently
  // becomes a link to nothing — which is worse than no link, because a user
  // who clicks for the details and lands nowhere concludes there aren't any.
  it("carries the #attachment-privacy anchor the upload notice points at", async () => {
    const { container, cleanup } = await mountPage(Docs, "/docs", "/docs");
    expect(container.querySelector("#attachment-privacy")).not.toBeNull();
    expect([...container.querySelectorAll("a")].some(
      (a) => a.getAttribute("href") === "#attachment-privacy",
    )).toBe(true);
    const text = container.textContent!;
    // The two facts the notice defers to this page to explain.
    expect(text).toContain("sharing the link is sharing the file");
    expect(text).toContain("content-addressed");
    cleanup();
  });
});
