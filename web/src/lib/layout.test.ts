import { describe, expect, it } from "vitest";
import {
  AUTO_VERTICAL_MAX_PX,
  FORCE_VERTICAL_MAX_PX,
  effectiveKanbanLayout,
  resolveKanbanLayout,
} from "./layout";

describe("resolveKanbanLayout", () => {
  it("an explicit stored preference always wins, at any width", () => {
    expect(resolveKanbanLayout("columns", 320)).toBe("columns");
    expect(resolveKanbanLayout("vertical", 1920)).toBe("vertical");
  });

  it("with no preference, narrow viewports default vertical, wide default columns", () => {
    expect(resolveKanbanLayout(null, AUTO_VERTICAL_MAX_PX - 1)).toBe("vertical");
    expect(resolveKanbanLayout(null, AUTO_VERTICAL_MAX_PX)).toBe("columns");
    expect(resolveKanbanLayout(null, 1440)).toBe("columns");
  });

  it("garbage in storage falls back to the viewport default", () => {
    expect(resolveKanbanLayout("sideways", 320)).toBe("vertical");
    expect(resolveKanbanLayout("", 1440)).toBe("columns");
  });
});

describe("effectiveKanbanLayout", () => {
  it("honors the preference above the force breakpoint", () => {
    expect(effectiveKanbanLayout("columns", FORCE_VERTICAL_MAX_PX)).toBe("columns");
    expect(effectiveKanbanLayout("vertical", 1440)).toBe("vertical");
  });

  it("forces vertical rendering below the breakpoint without touching the preference", () => {
    expect(effectiveKanbanLayout("columns", FORCE_VERTICAL_MAX_PX - 1)).toBe("vertical");
  });
});
