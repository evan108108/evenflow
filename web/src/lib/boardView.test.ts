import { describe, expect, it } from "vitest";
import { boardViewOf, issuePath, viewPath } from "./boardView";

const BASE = "/@evan108108/evan-s-flow-board";

describe("boardViewOf", () => {
  it("reads the three plain view URLs", () => {
    expect(boardViewOf(BASE, BASE)).toBe("kanban");
    expect(boardViewOf(`${BASE}/backlog`, BASE)).toBe("backlog");
    expect(boardViewOf(`${BASE}/icebox`, BASE)).toBe("icebox");
  });

  // The bug EFB-28 fixes: an open issue used to drop the view segment, so
  // every sheet read as kanban and the view swapped out behind it.
  it("keeps the view when an issue is open over it", () => {
    expect(boardViewOf(`${BASE}/backlog/issues/EFB-28`, BASE)).toBe("backlog");
    expect(boardViewOf(`${BASE}/icebox/issues/EFB-28`, BASE)).toBe("icebox");
  });

  it("treats a bare issue URL as kanban, so old bookmarks still resolve", () => {
    expect(boardViewOf(`${BASE}/issues/EFB-28`, BASE)).toBe("kanban");
  });

  it("ignores a trailing slash", () => {
    expect(boardViewOf(`${BASE}/`, BASE)).toBe("kanban");
    expect(boardViewOf(`${BASE}/backlog/`, BASE)).toBe("backlog");
  });

  it("reads the legacy /boards/:slug base too", () => {
    expect(boardViewOf("/boards/flow/backlog", "/boards/flow")).toBe("backlog");
    expect(boardViewOf("/boards/flow", "/boards/flow")).toBe("kanban");
  });

  // A board can be *named* "backlog" — its kanban URL then ends in
  // /backlog, which is why the base prefix decides rather than the tail.
  it("does not mistake a board named backlog for the backlog view", () => {
    expect(boardViewOf("/@evan108108/backlog", "/@evan108108/backlog")).toBe("kanban");
    expect(boardViewOf("/@evan108108/backlog/backlog", "/@evan108108/backlog")).toBe("backlog");
    expect(boardViewOf("/@evan108108/icebox/issues/EFB-1", "/@evan108108/icebox")).toBe("kanban");
  });

  it("matches a percent-encoded pathname against a raw base", () => {
    expect(boardViewOf("/@evan108108/my%20board/backlog", "/@evan108108/my board")).toBe("backlog");
  });

  it("falls back to positional reading when the base doesn't match", () => {
    expect(boardViewOf("/@someone/other/backlog", BASE)).toBe("backlog");
    expect(boardViewOf("/@someone/other/icebox/issues/EFB-9", BASE)).toBe("icebox");
    expect(boardViewOf("/@someone/other/issues/EFB-9", BASE)).toBe("kanban");
  });
});

describe("viewPath / issuePath", () => {
  it("gives kanban no suffix and the named views theirs", () => {
    expect(viewPath(BASE, "kanban")).toBe(BASE);
    expect(viewPath(BASE, "backlog")).toBe(`${BASE}/backlog`);
    expect(viewPath(BASE, "icebox")).toBe(`${BASE}/icebox`);
  });

  it("nests the issue under whichever view it was opened from", () => {
    expect(issuePath(BASE, "kanban", "EFB-28")).toBe(`${BASE}/issues/EFB-28`);
    expect(issuePath(BASE, "backlog", "EFB-28")).toBe(`${BASE}/backlog/issues/EFB-28`);
    expect(issuePath(BASE, "icebox", "EFB-28")).toBe(`${BASE}/icebox/issues/EFB-28`);
  });

  // open → close → open has to be a fixed point, or the view drifts.
  it("round-trips: the view an issue URL is built from is the one read back", () => {
    for (const view of ["kanban", "backlog", "icebox"] as const) {
      expect(boardViewOf(issuePath(BASE, view, "EFB-28"), BASE)).toBe(view);
      expect(boardViewOf(viewPath(BASE, view), BASE)).toBe(view);
    }
  });
});
