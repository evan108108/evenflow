// BoardSearch — the board header's search box (EFB-14).
//
// What is worth asserting here is the CONTRACT WITH THE SERVER and the shape
// of the panel, not the search itself. Whether FTS5 finds the right rows is
// settled against a real D1 in the Worker's tests/integration/search.test.ts;
// re-asserting it against a stubbed fetch would only test the stub.
//
// So these cases cover the parts that live in the browser and would otherwise
// go unproven: that an empty box issues no request at all, that typing sends
// exactly one POST with the documented body, that both result sections render
// and link to the right places, and that a comment hit stays on one line.

import { describe, expect, it, vi, afterEach } from "vitest";
import { render } from "solid-js/web";
import { BoardSearch } from "./BoardSearch";

const DEBOUNCE_SETTLE_MS = 260;

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

let calls: Call[] = [];

const installFetch = (payload: unknown) => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
};

const issueHit = (id: string, shortId: string, title: string, rank = -1) => ({
  issue: {
    id,
    short_id: shortId,
    board_id: "b1",
    title,
    body: null,
    body_format: "markdown",
    type: "task",
    status: "Todo",
    column_id: "c1",
    container: "backlog",
    assignee_pubkey: null,
    priority: null,
    estimate: null,
    labels: [],
    github_links: [],
    position: null,
    sprint_id: null,
    duplicate_of_issue_id: null,
    external_state: null,
    substrate_event_id: null,
    created_at_ms: 1,
    updated_at_ms: 1,
    completed_at_ms: null,
  },
  rank,
});

// No router: BoardSearch takes its API prefix and link prefix as props and
// emits plain anchors, so mounting it bare is the whole component under test.
const mount = () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(
    () => <BoardSearch apiBase="/api/v0/orgs/me/boards/kb" base="/@me/kb" />,
    container,
  );
  return { container, dispose };
};

const typeInto = (container: HTMLElement, value: string) => {
  const input = container.querySelector<HTMLInputElement>(".board-search-input");
  if (input === null) throw new Error("no search input rendered");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return input;
};

const settle = (ms = DEBOUNCE_SETTLE_MS) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("BoardSearch", () => {
  it("renders an input and issues no request until something is typed", async () => {
    installFetch({ issues: [], comments: [] });
    const { container, dispose } = mount();

    expect(container.querySelector(".board-search-input")).not.toBeNull();
    await settle();
    // An empty box must not poll the server on mount — the panel is closed
    // and there is nothing to search for.
    expect(calls.length).toBe(0);
    expect(container.querySelector(".board-search-panel")).toBeNull();

    dispose();
  });

  it("POSTs the documented body to the board-scoped search route", async () => {
    installFetch({ issues: [], comments: [] });
    const { container, dispose } = mount();

    typeInto(container, "widget");
    await settle();

    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/api/v0/orgs/me/boards/kb/search");
    // `q` is the trimmed query and `limit` is sent — the two keys the route's
    // schema accepts. An extra key here would be a 400 from parseRouteBody.
    expect(calls[0]?.body).toEqual({ q: "widget", limit: 8 });

    dispose();
  });

  it("debounces: several keystrokes produce one request", async () => {
    installFetch({ issues: [], comments: [] });
    const { container, dispose } = mount();

    typeInto(container, "w");
    typeInto(container, "wi");
    typeInto(container, "wid");
    await settle();

    expect(calls.length).toBe(1);
    expect(calls[0]?.body).toEqual({ q: "wid", limit: 8 });

    dispose();
  });

  it("trims the query before sending it", async () => {
    installFetch({ issues: [], comments: [] });
    const { container, dispose } = mount();

    typeInto(container, "  widget  ");
    await settle();

    expect(calls[0]?.body).toEqual({ q: "widget", limit: 8 });

    dispose();
  });

  it("renders issue hits in server order and links to the issue", async () => {
    installFetch({
      issues: [
        issueHit("i1", "KB-1", "Widget rendering is broken", -2),
        issueHit("i2", "KB-2", "Sprint planning notes", -1),
      ],
      comments: [],
    });
    const { container, dispose } = mount();

    typeInto(container, "widget");
    await settle();

    const rows = container.querySelectorAll(".board-search-row");
    expect(rows.length).toBe(2);
    // Order is the server's BM25 order, preserved — the client must not
    // re-sort, since it has no better ranking signal than the index does.
    expect(rows[0]?.textContent).toContain("Widget rendering is broken");
    expect(rows[1]?.textContent).toContain("Sprint planning notes");
    expect(rows[0]?.getAttribute("href")).toBe("/@me/kb/KB-1");

    dispose();
  });

  it("renders comment hits under their own heading, linking to the parent issue", async () => {
    installFetch({
      issues: [],
      comments: [
        {
          comment: { id: "c1", body: "the flibbertigibbet behaviour needs a repro" },
          issue_id: "i9",
          issue_title: "Discussion thread",
          issue_short_id: "KB-9",
          rank: -1,
        },
      ],
    });
    const { container, dispose } = mount();

    typeInto(container, "flibbertigibbet");
    await settle();

    const row = container.querySelector<HTMLAnchorElement>(".board-search-row-comment");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("flibbertigibbet");
    // A comment body alone is unlinkable, so the row names its issue and
    // navigates there — this is why the route hydrates parents.
    expect(row?.textContent).toContain("Discussion thread");
    expect(row?.getAttribute("href")).toBe("/@me/kb/KB-9");

    dispose();
  });

  it("truncates a long comment body so one hit stays one row", async () => {
    installFetch({
      issues: [],
      comments: [
        {
          comment: { id: "c1", body: "lorem ipsum ".repeat(60) },
          issue_id: "i9",
          issue_title: "Long thread",
          issue_short_id: "KB-9",
          rank: -1,
        },
      ],
    });
    const { container, dispose } = mount();

    typeInto(container, "lorem");
    await settle();

    const body = container.querySelector(".board-search-comment-body");
    expect(body?.textContent?.endsWith("…")).toBe(true);
    expect((body?.textContent ?? "").length).toBeLessThan(140);

    dispose();
  });

  it("says so when nothing matches, rather than showing an empty panel", async () => {
    installFetch({ issues: [], comments: [] });
    const { container, dispose } = mount();

    typeInto(container, "nothingmatchesthis");
    await settle();

    expect(container.querySelector(".board-search-panel")?.textContent).toContain(
      "Nothing matches",
    );

    dispose();
  });

  it("closes the panel on Escape", async () => {
    installFetch({ issues: [issueHit("i1", "KB-1", "Widget")], comments: [] });
    const { container, dispose } = mount();

    typeInto(container, "widget");
    await settle();
    expect(container.querySelector(".board-search-panel")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle(0);
    expect(container.querySelector(".board-search-panel")).toBeNull();

    dispose();
  });
});
