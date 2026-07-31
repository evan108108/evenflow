// EFB-31 done-window lift persistence.
//
// The scoping cases mirror filterPersistence.test.ts deliberately: the two
// share a storage discipline even though they cannot share a shape, and a
// divergence in scoping would leak one viewer's view onto another.

import { beforeEach, describe, expect, it } from "vitest";
import {
  doneWindowStorageKey,
  readDoneWindowLifted,
  writeDoneWindowLifted,
} from "./doneWindowPersistence";

const BOARD = "4042afb7";
const SONA = "nostr:049b628c";
const EVAN = "google:1045090";

beforeEach(() => window.localStorage.clear());

describe("doneWindowStorageKey", () => {
  it("scopes by board and viewer", () => {
    expect(doneWindowStorageKey(BOARD, SONA)).toBe(`evenflow:done-window:${BOARD}:${SONA}`);
  });

  it("gives a signed-out viewer its own scope", () => {
    expect(doneWindowStorageKey(BOARD, null)).toBe(`evenflow:done-window:${BOARD}:anon`);
    expect(doneWindowStorageKey(BOARD, null)).not.toBe(doneWindowStorageKey(BOARD, SONA));
  });

  it("separates viewers and boards from each other", () => {
    expect(doneWindowStorageKey(BOARD, SONA)).not.toBe(doneWindowStorageKey(BOARD, EVAN));
    expect(doneWindowStorageKey("other", SONA)).not.toBe(doneWindowStorageKey(BOARD, SONA));
  });

  // The whole reason this module exists rather than a BoardFilters member.
  it("does not collide with the EFB-44 filter key", () => {
    expect(doneWindowStorageKey(BOARD, SONA)).not.toBe(`evenflow:board-filters:${BOARD}:${SONA}`);
  });
});

describe("readDoneWindowLifted / writeDoneWindowLifted", () => {
  it("round-trips a lift", () => {
    writeDoneWindowLifted(BOARD, SONA, true);
    expect(readDoneWindowLifted(BOARD, SONA)).toBe(true);
  });

  it("defaults to windowed when nothing is stored", () => {
    expect(readDoneWindowLifted(BOARD, SONA)).toBe(false);
  });

  // This is the case the brief's original design would have failed: a lift
  // with no other filter active still has to survive a reload.
  it("persists a lift that is the only active view state", () => {
    writeDoneWindowLifted(BOARD, null, true);
    expect(readDoneWindowLifted(BOARD, null)).toBe(true);
  });

  it("clears the entry rather than storing a falsy marker", () => {
    writeDoneWindowLifted(BOARD, SONA, true);
    writeDoneWindowLifted(BOARD, SONA, false);
    expect(window.localStorage.getItem(doneWindowStorageKey(BOARD, SONA))).toBeNull();
    expect(readDoneWindowLifted(BOARD, SONA)).toBe(false);
  });

  it("keeps viewers from reading each other's lift", () => {
    writeDoneWindowLifted(BOARD, SONA, true);
    expect(readDoneWindowLifted(BOARD, EVAN)).toBe(false);
    expect(readDoneWindowLifted(BOARD, null)).toBe(false);
  });

  it("treats an unrecognised stored value as windowed", () => {
    window.localStorage.setItem(doneWindowStorageKey(BOARD, SONA), "yes");
    expect(readDoneWindowLifted(BOARD, SONA)).toBe(false);
  });
});
