import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_FILTERS, type BoardFilters } from "./boardFilters";
import { filterStorageKey, parseFilters, readFilters, writeFilters } from "./filterPersistence";

const BOARD = "4042afb7";
const SONA = "nostr:049b628c";
const EVAN = "google:1045090";

beforeEach(() => window.localStorage.clear());

describe("filterStorageKey", () => {
  it("scopes by board and viewer", () => {
    expect(filterStorageKey(BOARD, SONA)).toBe(`evenflow:board-filters:${BOARD}:${SONA}`);
  });

  // Signed-out filtering persists, but in its own scope — it must never be
  // read back as though it belonged to whoever signs in next.
  it("gives a signed-out viewer its own scope", () => {
    expect(filterStorageKey(BOARD, null)).toBe(`evenflow:board-filters:${BOARD}:anon`);
    expect(filterStorageKey(BOARD, null)).not.toBe(filterStorageKey(BOARD, SONA));
  });

  it("separates viewers and boards from each other", () => {
    expect(filterStorageKey(BOARD, SONA)).not.toBe(filterStorageKey(BOARD, EVAN));
    expect(filterStorageKey("other", SONA)).not.toBe(filterStorageKey(BOARD, SONA));
  });
});

describe("parseFilters", () => {
  it("returns the empty set for a missing entry", () => {
    expect(parseFilters(null)).toEqual(EMPTY_FILTERS);
  });

  // A stored value that predates a shape change — or that someone hand-edited
  // — must not be able to break the board it belongs to.
  it("survives anything unparseable or wrongly shaped", () => {
    for (const raw of ["", "{", "null", "[]", '"a string"', "42"]) {
      expect(parseFilters(raw)).toEqual(EMPTY_FILTERS);
    }
  });

  it("drops fields of the wrong type rather than trusting them", () => {
    expect(parseFilters('{"mineOnly":"yes","assignees":"nope","labels":[1,2]}')).toEqual(
      EMPTY_FILTERS,
    );
    expect(parseFilters('{"assignees":["a",3]}').assignees).toEqual([]);
  });

  it("keeps a well-formed value", () => {
    expect(parseFilters('{"mineOnly":true,"assignees":["a"],"labels":["bug"]}')).toEqual({
      mineOnly: true,
      assignees: ["a"],
      labels: ["bug"],
      sprintId: null,
      text: "",
    });
  });
});

describe("read/write round-trip", () => {
  const filters: BoardFilters = {
    mineOnly: true,
    assignees: [SONA],
    labels: ["bug"],
    sprintId: null,
      text: "",
  };

  it("restores what it stored", () => {
    writeFilters(BOARD, SONA, filters);
    expect(readFilters(BOARD, SONA)).toEqual(filters);
  });

  it("does not leak across viewers or boards", () => {
    writeFilters(BOARD, SONA, filters);
    expect(readFilters(BOARD, EVAN)).toEqual(EMPTY_FILTERS);
    expect(readFilters(BOARD, null)).toEqual(EMPTY_FILTERS);
    expect(readFilters("other", SONA)).toEqual(EMPTY_FILTERS);
  });

  // Storing "{}" for every unfiltered board would leave an entry per
  // board/viewer pair the user merely visited. Clearing keeps stale keys to
  // the pairs that actually filtered something.
  it("removes the entry instead of storing an empty set", () => {
    writeFilters(BOARD, SONA, filters);
    expect(window.localStorage.getItem(filterStorageKey(BOARD, SONA))).not.toBeNull();

    writeFilters(BOARD, SONA, EMPTY_FILTERS);
    expect(window.localStorage.getItem(filterStorageKey(BOARD, SONA))).toBeNull();
    expect(readFilters(BOARD, SONA)).toEqual(EMPTY_FILTERS);
  });

  it("reads a corrupt entry as unfiltered rather than throwing", () => {
    window.localStorage.setItem(filterStorageKey(BOARD, SONA), "{not json");
    expect(readFilters(BOARD, SONA)).toEqual(EMPTY_FILTERS);
  });
});

// EFB-45 lean (a): sprint became a filter dimension but deliberately NOT a
// persisted one — it resets on reload exactly as the phase-21c scalar did.
describe("sprint is never persisted", () => {
  it("keeps sprintId out of the stored blob", () => {
    writeFilters(BOARD, SONA, {
      mineOnly: true,
      assignees: [],
      labels: [],
      sprintId: "s1",
      text: "",
    });
    const raw = window.localStorage.getItem(filterStorageKey(BOARD, SONA));
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("s1");
    expect(raw).not.toContain("sprintId");
  });

  it("never restores a sprint, even from a hand-edited blob", () => {
    window.localStorage.setItem(
      filterStorageKey(BOARD, SONA),
      JSON.stringify({ mineOnly: false, assignees: [], labels: ["bug"], sprintId: "s1", text: "" }),
    );
    expect(readFilters(BOARD, SONA).sprintId).toBeNull();
    // ...while still restoring the dimensions that DO persist.
    expect(readFilters(BOARD, SONA).labels).toEqual(["bug"]);
  });

  // A sprint selection alone must not create a storage entry: isEmpty weighs
  // only the persisted dimensions, so this stays a no-trace board.
  it("writes nothing when the sprint is the only thing set", () => {
    writeFilters(BOARD, SONA, { mineOnly: false, assignees: [], labels: [], sprintId: "s1", text: "" });
    expect(window.localStorage.getItem(filterStorageKey(BOARD, SONA))).toBeNull();
  });
});
