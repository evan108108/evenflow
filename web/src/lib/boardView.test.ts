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
    expect(boardViewOf(`${BASE}/backlog/issue/EFB-28`, BASE)).toBe("backlog");
    expect(boardViewOf(`${BASE}/icebox/issue/EFB-28`, BASE)).toBe("icebox");
  });

  // EFB-89 renamed the segment to the singular. The plural is every URL
  // minted before that — bookmarks, PR bodies, pasted links — and must read
  // back identically forever, not merely route.
  it("reads the legacy plural segment the same way", () => {
    expect(boardViewOf(`${BASE}/backlog/issues/EFB-28`, BASE)).toBe("backlog");
    expect(boardViewOf(`${BASE}/icebox/issues/EFB-28`, BASE)).toBe("icebox");
  });

  it("treats a bare issue URL as kanban, so old bookmarks still resolve", () => {
    expect(boardViewOf(`${BASE}/issue/EFB-28`, BASE)).toBe("kanban");
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
    expect(boardViewOf("/@evan108108/icebox/issue/EFB-1", "/@evan108108/icebox")).toBe("kanban");
  });

  it("matches a percent-encoded pathname against a raw base", () => {
    expect(boardViewOf("/@evan108108/my%20board/backlog", "/@evan108108/my board")).toBe("backlog");
  });

  it("falls back to positional reading when the base doesn't match", () => {
    expect(boardViewOf("/@someone/other/backlog", BASE)).toBe("backlog");
    expect(boardViewOf("/@someone/other/icebox/issue/EFB-9", BASE)).toBe("icebox");
    expect(boardViewOf("/@someone/other/issue/EFB-9", BASE)).toBe("kanban");
  });

  // The positional fallback splices a known issue segment off the tail; it
  // has to know both spellings, or a legacy URL on an exotic slug reads its
  // ref as the view name and lands on kanban.
  it("splices the legacy plural segment in the positional fallback too", () => {
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
    expect(issuePath(BASE, "kanban", "EFB-28")).toBe(`${BASE}/issue/EFB-28`);
    expect(issuePath(BASE, "backlog", "EFB-28")).toBe(`${BASE}/backlog/issue/EFB-28`);
    expect(issuePath(BASE, "icebox", "EFB-28")).toBe(`${BASE}/icebox/issue/EFB-28`);
  });

  // EFB-89: the plural is read, never written. If this fails, the rename
  // regressed and new links are being minted in the old shape again.
  it("mints only the singular segment", () => {
    for (const view of ["kanban", "backlog", "icebox"] as const) {
      expect(issuePath(BASE, view, "EFB-28")).not.toContain("/issues/");
    }
  });

  // open → close → open has to be a fixed point, or the view drifts.
  it("round-trips: the view an issue URL is built from is the one read back", () => {
    for (const view of ["kanban", "backlog", "icebox"] as const) {
      expect(boardViewOf(issuePath(BASE, view, "EFB-28"), BASE)).toBe(view);
      expect(boardViewOf(viewPath(BASE, view), BASE)).toBe(view);
    }
  });
});
