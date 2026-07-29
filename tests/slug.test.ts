import { describe, expect, it } from "vitest";
import {
  PREFIX_MAX_LEN,
  PREFIX_MIN_LEN,
  SHORT_ID_RE,
  asShortId,
  derivePrefix,
  uniquePrefix,
} from "../src/slug";

describe("derivePrefix", () => {
  const cases: ReadonlyArray<[title: string, expected: string]> = [
    ["Evan's Flow", "EF"],
    ["Evenflow Roadmap", "ER"],
    ["Foo", "FOO"],
    ["Foo Bar Baz Qux Quux Quuz", "FBBQQ"],
    ["The Board", "BOA"],
    ["My Flow", "FLO"],
    ["Infra & Ops", "IO"],
    ["Web App V2", "WAV"],
    ["A B C", "BC"],
    ["  spaced   out  title ", "SOT"],
    ["lower case words", "LCW"],
    ["2026 Planning", "2P"],
  ];
  for (const [title, expected] of cases) {
    it(`"${title}" → ${expected}`, () => {
      expect(derivePrefix(title)).toBe(expected);
    });
  }

  it("yields a valid prefix or the documented empty string for degenerate titles", () => {
    // "No more XX placeholder": derivePrefix deliberately returns "" when a
    // title has no derivable identity — the caller must demand an explicit
    // issue_prefix. Non-degenerate inputs still derive a real 2-5 char one.
    for (const title of ["!!!", "x", "-", "a b", "ThisIsOneVeryLongSingleWord"]) {
      const p = derivePrefix(title);
      if (p !== "") {
        expect(p.length).toBeGreaterThanOrEqual(PREFIX_MIN_LEN);
        expect(p.length).toBeLessThanOrEqual(PREFIX_MAX_LEN);
        expect(p).toMatch(/^[A-Z0-9]+$/);
      }
    }
    expect(derivePrefix("!!!")).toBe("");
    expect(derivePrefix("ThisIsOneVeryLongSingleWord")).not.toBe("");
  });
});

describe("uniquePrefix", () => {
  it("returns the base when free", () => {
    expect(uniquePrefix("FLOW", new Set(["WEB"]))).toBe("FLOW");
  });

  it("suffixes a digit on conflict: FLOW → FLOW2 → FLOW3", () => {
    expect(uniquePrefix("FLOW", new Set(["FLOW"]))).toBe("FLOW2");
    expect(uniquePrefix("FLOW", new Set(["FLOW", "FLOW2"]))).toBe("FLOW3");
  });

  it("trims a max-length base to make room for the suffix", () => {
    expect(uniquePrefix("FBBQQ", new Set(["FBBQQ"]))).toBe("FBBQ2");
  });

  it("stays within PREFIX_MAX_LEN through double-digit suffixes", () => {
    const taken = new Set(["FLOW", ...Array.from({ length: 8 }, (_, i) => `FLOW${i + 2}`)]);
    const next = uniquePrefix("FLOW", taken);
    expect(next).toBe("FLO10");
    expect(next.length).toBeLessThanOrEqual(PREFIX_MAX_LEN);
  });
});

describe("asShortId", () => {
  it("normalizes case-insensitively", () => {
    expect(asShortId("flow-42")).toBe("FLOW-42");
    expect(asShortId("FLOW-1")).toBe("FLOW-1");
  });

  it("rejects UUIDs and malformed refs", () => {
    expect(asShortId("0b81444f-3d15-4dc1-a5a2-9a7f4f2a2c9d")).toBeNull();
    expect(asShortId("TOOLONG-1")).toBeNull();
    expect(asShortId("F-1")).toBeNull();
    expect(asShortId("FLOW-")).toBeNull();
    expect(asShortId("FLOW42")).toBeNull();
    expect(asShortId("")).toBeNull();
  });

  it("SHORT_ID_RE anchors the whole string", () => {
    expect(SHORT_ID_RE.test("XFLOW-42Y")).toBe(false);
  });
});
