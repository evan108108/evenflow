// Phase 19 web tests: the DeveloperKeys page (list, one-time mint reveal,
// revoke) over stubbed fetch, and the public /docs render.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { url } from "@routes-manifest";
import { render } from "solid-js/web";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { DeveloperKeys } from "./DeveloperKeys";
import { Docs } from "./Docs";
import { pathOf, REST_SECTIONS, MCP_TOOLS } from "./docs/rest-spec";

const KEYS = [
  { id: "k1", name: "CI bot", prefix: "evk_abcd1234", created_at_ms: 1_700_000_000_000, last_used_at_ms: null, revoked_at_ms: null },
  { id: "k2", name: "Old key", prefix: "evk_dead0000", created_at_ms: 1_600_000_000_000, last_used_at_ms: 1_650_000_000_000, revoked_at_ms: 1_690_000_000_000 },
];

let calls: Array<{ method: string; url: string; body?: unknown }>;

beforeEach(() => {
  calls = [];
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

  it("revoke fires the DELETE", async () => {
    const { container, cleanup } = await mountPage(DeveloperKeys);
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Revoke")!
      .click();
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(url("key.delete", { id: "k1" })))).toBe(true);
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
