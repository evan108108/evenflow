// EFB-103: the documentation's own falsification, as tests.
//
// The ticket's claims are all checkable, so they are checked here rather than
// asserted in a PR body: a signed-out reader sees everything, every declared
// endpoint appears in the reference, and the docs link is on every page rather
// than on most of them.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render } from "solid-js/web";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { ROUTES } from "@routes-manifest";
import { SECTIONS } from "@docs-content/sections";
import { apiRows } from "@docs-content/api-reference";
import { sectionsToMarkdown } from "@docs-content/model";
import { apiReferenceMarkdown } from "@docs-content/api-reference";
import { DocsSection } from "./DocsSection";
import { Docs } from "./Docs";
import { SiteFooter } from "../components/SiteFooter";
import { Shell } from "../App";

beforeEach(() => {
  // A signed-out reader has no token and makes no authed call. Any fetch at
  // all from a docs page is a bug: these pages must render with no network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("docs pages must not fetch");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const mount = async (component: () => unknown, path: string, route: string) => {
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

describe("docs are public", () => {
  it("renders every section for a signed-out reader, with no fetch and no sign-in prompt", async () => {
    for (const section of SECTIONS) {
      const { container, cleanup } = await mount(
        DocsSection,
        `/docs/${section.id}`,
        "/docs/:section",
      );
      const text = container.textContent ?? "";
      expect(text).toContain(section.title);
      expect(text).toContain(section.blurb);
      // No page may ask a reader to sign in to read it.
      expect(text.toLowerCase()).not.toContain("sign in to view");
      cleanup();
    }
  });

  it("puts every section in the sidebar of every section page", async () => {
    const { container, cleanup } = await mount(DocsSection, "/docs/concepts", "/docs/:section");
    const links = [...container.querySelectorAll(".docs-nav a")].map((a) => a.getAttribute("href"));
    for (const section of SECTIONS) expect(links).toContain(`/docs/${section.id}`);
    // And the single-document form, which is the whole point for agents.
    expect(links).toContain("/docs/llms.txt");
    cleanup();
  });

  it("answers an unknown section with a page rather than a blank screen", async () => {
    const { container, cleanup } = await mount(DocsSection, "/docs/nope", "/docs/:section");
    expect(container.textContent).toContain("No such page");
    cleanup();
  });
});

describe("the API reference is complete by construction", () => {
  // The ticket's falsification: "every endpoint from routes-manifest appears
  // in the reference". Asserting the COUNT rather than spot-checking is what
  // makes this survive route 109 — a curated list would pass a spot check and
  // silently omit the new one.
  it("covers every declared route, not a curated subset", () => {
    const documented = new Set(apiRows().map((r) => r.id));
    for (const entry of ROUTES) expect(documented.has(entry.id)).toBe(true);
    expect(documented.size).toBe(ROUTES.length);
  });

  it("gives every endpoint a runnable curl carrying its real path", () => {
    for (const row of apiRows()) {
      expect(row.curl).toContain("curl ");
      expect(row.curl).toContain(row.path);
      // Non-public endpoints must show how to authenticate, or the example is
      // not runnable — which is the failure this whole surface exists to avoid.
      if (row.scope !== "none (public)") expect(row.curl).toContain("Authorization: Bearer");
    }
  });

  it("renders the section index on the docs home", async () => {
    const { container, cleanup } = await mount(Docs, "/docs", "/docs");
    for (const section of SECTIONS) {
      expect(container.innerHTML).toContain(`/docs/${section.id}`);
    }
    cleanup();
  });
});

describe("the single-document form", () => {
  it("contains every section and every endpoint path", () => {
    const md = sectionsToMarkdown(SECTIONS, apiReferenceMarkdown);
    for (const section of SECTIONS) expect(md).toContain(section.title);
    for (const row of apiRows()) expect(md).toContain(row.path);
    // It has to announce what it is: an agent that fetches this should not
    // have to guess whether it is complete.
    expect(md).toContain("COMPLETE documentation set");
  });
});

describe("the docs link is on every page", () => {
  // The mechanism, not just the component: the footer has to be rendered by
  // the Router's root layout, or "every page" quietly means "every page
  // someone remembered". Shell wraps ARBITRARY children — which is what makes
  // it true for routes that do not exist yet.
  it("is rendered by the router shell that wraps every route", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <Shell>{"a page that knows nothing about docs"}</Shell>, container);
    expect(container.textContent).toContain("a page that knows nothing about docs");
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("/docs");
    dispose();
    container.remove();
  });

  it("is in the site footer, which the router renders for every route", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <SiteFooter />, container);
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("/docs");
    expect(links).toContain("/docs/llms.txt");
    dispose();
    container.remove();
  });
});
