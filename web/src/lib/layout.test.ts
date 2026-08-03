import { afterEach, describe, expect, it } from "vitest";
import {
  AUTO_VERTICAL_MAX_PX,
  FORCE_VERTICAL_MAX_PX,
  WIDE_VERTICAL_MIN_PX,
  effectiveKanbanLayout,
  isMobileHeader,
  isWideVertical,
  layoutViewportWidth,
  resolveKanbanLayout,
} from "./layout";

// EFB-77. This suite's own header warns that a pure function tested with clean
// synthetic widths proves nothing about the number the caller actually holds —
// that is exactly how EFB-67 v1 shipped green and broke prod. So this block
// tests the READ rather than the predicates: it pins the two DOM sources to
// different values, the way a horizontally overflowing page does, and asserts
// which one we take. Swap layoutViewportWidth back to window.innerWidth and
// this fails; that is the point of it existing.
//
// What jsdom can and cannot show: it will not reproduce Chromium's inflation
// on its own, so the divergence here is staged. The real behavior was
// reproduced under CDP mobile emulation at 393px — innerWidth 1572 vs
// clientWidth 393, flipping the layout branch from vertical to columns. See
// the PR body.
describe("layoutViewportWidth", () => {
  const realInner = window.innerWidth;
  const setClientWidth = (px: number) =>
    Object.defineProperty(document.documentElement, "clientWidth", {
      value: px,
      configurable: true,
    });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: realInner, configurable: true });
    setClientWidth(realInner);
  });

  it("reads the layout viewport, not the inflated innerWidth", () => {
    // The prod measurement from EFB-67 v1, and the shape the CDP probe
    // reproduced: a 393px phone whose document overflows.
    Object.defineProperty(window, "innerWidth", { value: 792, configurable: true });
    setClientWidth(393);
    expect(layoutViewportWidth()).toBe(393);
  });

  it("drives the layout branch off the true width when the two disagree", () => {
    Object.defineProperty(window, "innerWidth", { value: 1572, configurable: true });
    setClientWidth(393);
    // Feeding innerWidth here would force a horizontal kanban into a 393px
    // viewport — the EFB-67 v1 regression, one layer down.
    expect(effectiveKanbanLayout("columns", layoutViewportWidth())).toBe("vertical");
    expect(resolveKanbanLayout(null, layoutViewportWidth())).toBe("vertical");
    expect(effectiveKanbanLayout("columns", window.innerWidth)).toBe("columns");
  });

  it("is a no-op when nothing overflows — why EFB-77 was latent, not firing", () => {
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    setClientWidth(1440);
    expect(layoutViewportWidth()).toBe(1440);
    expect(effectiveKanbanLayout("columns", layoutViewportWidth())).toBe(
      effectiveKanbanLayout("columns", window.innerWidth),
    );
  });
});

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

describe("isWideVertical", () => {
  it("puts the rail beside the stack at the breakpoint and above", () => {
    expect(isWideVertical("vertical", WIDE_VERTICAL_MIN_PX)).toBe(true);
    expect(isWideVertical("vertical", 1920)).toBe(true);
  });

  it("drops the rail below the stack under the breakpoint", () => {
    expect(isWideVertical("vertical", WIDE_VERTICAL_MIN_PX - 1)).toBe(false);
    expect(isWideVertical("vertical", 375)).toBe(false);
  });

  it("never applies to the columns layout — it already uses full width", () => {
    expect(isWideVertical("columns", 1920)).toBe(false);
  });
});

// EFB-67 — the mobile board header.
describe("isMobileHeader", () => {
  it("engages on the phone widths the ticket was filed about", () => {
    // 375×812, 393×873, 428×926 — the viewports named in the brief.
    expect(isMobileHeader(375)).toBe(true);
    expect(isMobileHeader(393)).toBe(true);
    expect(isMobileHeader(428)).toBe(true);
  });

  // The desktop-regression guard. A mobile header that quietly reflows desktop
  // is the failure mode this ticket is one flip away from becoming, and it is
  // cheaper to assert here than to catch in a screenshot.
  it("leaves desktop alone", () => {
    expect(isMobileHeader(1024)).toBe(false);
    expect(isMobileHeader(1440)).toBe(false);
    expect(isMobileHeader(1920)).toBe(false);
  });

  // The exact edge is where drift shows up first — an off-by-one here is
  // precisely the bug the existing `@media (max-width: 479px)` vs
  // FORCE_VERTICAL_MAX_PX = 480 pair already demonstrates elsewhere.
  // The exact edge is where drift shows up first, and the comparison must be
  // STRICT to match resolveKanbanLayout. An inclusive `<=` would hand 640px a
  // mobile header while the board still defaulted to columns.
  it("switches exactly at the threshold, exclusive", () => {
    expect(isMobileHeader(AUTO_VERTICAL_MAX_PX - 1)).toBe(true);
    expect(isMobileHeader(AUTO_VERTICAL_MAX_PX)).toBe(false);
    expect(isMobileHeader(639)).toBe(true);
    expect(isMobileHeader(640)).toBe(false);
  });

  // THE load-bearing test. The lockstep invariant encoded as an executable
  // assertion rather than prose — which is what caught the original `<=`
  // off-by-one at exactly 640, a mismatch a comment would have shipped.
  //
  // This is the test that catches a future author who nudges either threshold
  // without the other. Do not weaken it to a fixed expectation; its whole value
  // is that it derives the expectation from the other function.
  it("switches in lockstep with the board's vertical default, at every width", () => {
    for (const w of [320, 375, 393, 428, 480, 500, 600, 639, 640, 641, 800, 1024, 1440]) {
      expect(isMobileHeader(w)).toBe(resolveKanbanLayout(null, w) === "vertical");
    }
  });
});
