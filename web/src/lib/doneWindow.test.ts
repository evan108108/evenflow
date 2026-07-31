// EFB-45: these tests carry EFB-31's no-regression guarantee across the
// ownership migration. The "sprint filter active → don't window" rule used to
// be enforced (and tested) inside StatusStack via the scalar filterSprintId
// prop; that prop is gone, so the rule lives here now and is tested here.

import { describe, expect, it } from "vitest";
import { effectiveDoneWindowMs } from "./doneWindow";

const DAY_MS = 86_400_000;

describe("effectiveDoneWindowMs", () => {
  it("windows to the board's configured days by default", () => {
    expect(effectiveDoneWindowMs(false, false, 14)).toBe(14 * DAY_MS);
    expect(effectiveDoneWindowMs(false, false, 30)).toBe(30 * DAY_MS);
  });

  it("returns null when the viewer lifted the window", () => {
    expect(effectiveDoneWindowMs(true, false, 14)).toBeNull();
  });

  // EFB-31's no-regression case: a sprint filter already narrows the deck, so
  // windowing on top would double-filter Done toward empty on sprint boards.
  it("returns null while a sprint filter is active", () => {
    expect(effectiveDoneWindowMs(false, true, 14)).toBeNull();
  });

  it("returns null when both lift and sprint filter apply", () => {
    expect(effectiveDoneWindowMs(true, true, 14)).toBeNull();
  });

  // A board configured to zero (or a nonsense negative) means "no window",
  // not "hide everything" — the old guard required doneWindowMs > 0.
  it("treats a non-positive window as no window", () => {
    expect(effectiveDoneWindowMs(false, false, 0)).toBeNull();
    expect(effectiveDoneWindowMs(false, false, -1)).toBeNull();
  });
});
