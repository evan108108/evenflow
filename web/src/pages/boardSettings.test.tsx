// BoardSettings Columns tab in jsdom: rendering, add, and the two delete
// paths (move-and-delete via column_move_map, hide-in-place). The page
// talks through appRuntime's ApiClient, so these tests stub global fetch
// with canned per-URL responses and capture the PATCH body.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import type { Column } from "../lib/columns";
import { BoardSettings } from "./BoardSettings";

const col = (id: string, name: string, order: number, category: Column["category"]): Column => ({
  id,
  name,
  order,
  enabled: true,
  category,
});

const COLUMNS = [
  col("c1", "Todo", 0, "todo"),
  col("c2", "In Cluster", 1, "in_progress"),
  col("c3", "Done", 2, "done"),
];

const boardResponse = () => ({
  board: {
    id: "b1",
    slug: "kb",
    title: "Board",
    visibility: "private",
    columns: COLUMNS,
    default_sprint_days: 14,
  },
});

const issuesResponse = () => ({
  issues: [
    { id: "i1", column_id: "c2", status: "In Cluster" },
    { id: "i2", column_id: "c2", status: "In Cluster" },
    { id: "i3", column_id: "c2", status: "In Cluster" },
  ],
});

let patches: unknown[];

beforeEach(() => {
  patches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return json(boardResponse());
      }
      if (path.includes("/issues")) return json(issuesResponse());
      if (path.includes("/members")) return json({ members: [] });
      if (path.includes("/invites")) return json({ invites: [] });
      return json(boardResponse());
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const mountSettings = async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const history = createMemoryHistory();
  history.set({ value: "/@acme/kb/settings" });
  const dispose = render(
    () => (
      <MemoryRouter history={history}>
        <Route path="/:handle/:board_slug/settings" component={BoardSettings} />
      </MemoryRouter>
    ),
    container,
  );
  await flush();
  await flush();
  // Open the Columns tab.
  const tab = [...container.querySelectorAll(".settings-tabs button")].find(
    (b) => b.textContent === "Columns",
  ) as HTMLButtonElement;
  tab.click();
  await flush();
  return {
    container,
    cleanup: () => {
      dispose();
      container.remove();
    },
  };
};

const rowByName = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLElement>(".column-row")].find(
    (r) => r.querySelector<HTMLInputElement>(".column-name")!.value === name,
  );

const save = async (container: HTMLElement) => {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
  buttons.find((b) => b.textContent === "Save columns")!.click();
  await flush();
  await flush();
};

describe("BoardSettings — Columns tab", () => {
  it("lists every column with name, category, and issue count", async () => {
    const { container, cleanup } = await mountSettings();
    const rows = [...container.querySelectorAll<HTMLElement>(".column-row")];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.querySelector<HTMLInputElement>(".column-name")!.value)).toEqual([
      "Todo",
      "In Cluster",
      "Done",
    ]);
    expect(rowByName(container, "In Cluster")!.querySelector(".column-category")!.textContent).toContain(
      "In progress",
    );
    expect(rowByName(container, "In Cluster")!.querySelector(".column-count")!.textContent).toBe("3");
    cleanup();
  });

  it("adds a column and PATCHes the whole set on save", async () => {
    const { container, cleanup } = await mountSettings();
    const add = container.querySelector<HTMLInputElement>(".column-add input")!;
    add.value = "Blocked";
    add.dispatchEvent(new Event("input", { bubbles: true }));
    const category = container.querySelector<HTMLSelectElement>(".column-add select")!;
    category.value = "blocked";
    category.dispatchEvent(new Event("input", { bubbles: true }));
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "+ Add column")!
      .click();
    await flush();
    await save(container);

    const body = patches[0] as { columns: Column[] };
    expect(body.columns).toHaveLength(4);
    expect(body.columns[3]).toMatchObject({ name: "Blocked", category: "blocked", order: 3, enabled: true });
    cleanup();
  });

  it("deleting a column with issues offers a move — the map rides the PATCH", async () => {
    const { container, cleanup } = await mountSettings();
    rowByName(container, "In Cluster")!.querySelector<HTMLButtonElement>(".column-delete")!.click();
    await flush();

    expect(container.textContent).toContain("“In Cluster” holds 3 issues");
    const target = container.querySelector<HTMLSelectElement>("#col-move-target")!;
    expect([...target.options].map((o) => o.textContent)).toEqual(["—", "Todo", "Done"]);
    target.value = "c3";
    target.dispatchEvent(new Event("input", { bubbles: true }));
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent!.startsWith("Move"))!
      .click();
    await flush();
    await save(container);

    const body = patches[0] as { columns: Column[]; column_move_map: Record<string, string> };
    expect(body.columns.map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(body.column_move_map).toEqual({ c2: "c3" });
    cleanup();
  });

  it("'Just hide the column' flips enabled off instead of deleting", async () => {
    const { container, cleanup } = await mountSettings();
    rowByName(container, "In Cluster")!.querySelector<HTMLButtonElement>(".column-delete")!.click();
    await flush();
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Just hide the column")!
      .click();
    await flush();
    await save(container);

    const body = patches[0] as { columns: Column[]; column_move_map?: unknown };
    expect(body.columns.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(body.columns[1]).toMatchObject({ id: "c2", enabled: false });
    expect(body.column_move_map).toBeUndefined();
    cleanup();
  });

  it("empty columns delete straight away, no modal", async () => {
    const { container, cleanup } = await mountSettings();
    rowByName(container, "Todo")!.querySelector<HTMLButtonElement>(".column-delete")!.click();
    await flush();
    expect(container.querySelector("#col-move-target")).toBeNull();
    expect(rowByName(container, "Todo")).toBeUndefined();
    await save(container);
    const body = patches[0] as { columns: Column[] };
    expect(body.columns.map((c) => c.id)).toEqual(["c2", "c3"]);
    // Orders reindex to stay 0-based contiguous.
    expect(body.columns.map((c) => c.order)).toEqual([0, 1]);
    cleanup();
  });
});

describe("BoardSettings — General tab sprint length", () => {
  const mountGeneral = async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const history = createMemoryHistory();
    history.set({ value: "/@acme/kb/settings" });
    const dispose = render(
      () => (
        <MemoryRouter history={history}>
          <Route path="/:handle/:board_slug/settings" component={BoardSettings} />
        </MemoryRouter>
      ),
      container,
    );
    await flush();
    await flush();
    return { container, cleanup: () => { dispose(); container.remove(); } };
  };

  it("round-trips default_sprint_days through PATCH", async () => {
    const { container, cleanup } = await mountGeneral();
    const input = container.querySelector<HTMLInputElement>("#default-sprint-days")!;
    expect(input.value).toBe("14");
    input.value = "7";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(patches).toEqual([{ default_sprint_days: 7 }]);
    cleanup();
  });

  it("rejects an out-of-range value locally, resetting to the saved default", async () => {
    const { container, cleanup } = await mountGeneral();
    const input = container.querySelector<HTMLInputElement>("#default-sprint-days")!;
    input.value = "120";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(patches).toEqual([]);
    expect(input.value).toBe("14");
    cleanup();
  });
});
