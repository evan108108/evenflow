// EFB-104 — the poll's schedule, including the half that is about NOT firing.
//
// Extracted from BoardPage precisely so these can be asserted. Every one of
// these rules is invisible in review: "polls a hidden tab 1,440 times a day"
// and "makes a returning tab wait 59 more seconds while showing the wrong
// column" both read as correct code.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_MS, startBoardPoll, type VisibilitySource } from "./boardPoll";

/** A `document` stand-in whose visibility the test drives. */
const fakeDoc = (initial: DocumentVisibilityState = "visible") => {
  const listeners = new Set<() => void>();
  let state = initial;
  return {
    source: {
      get visibilityState() {
        return state;
      },
      addEventListener: (_type: "visibilitychange", l: () => void) => void listeners.add(l),
      removeEventListener: (_type: "visibilitychange", l: () => void) => void listeners.delete(l),
    } as VisibilitySource,
    /** Flip visibility and fire the event the browser would fire. */
    setVisibility: (next: DocumentVisibilityState) => {
      state = next;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
  };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startBoardPoll", () => {
  it("polls a visible tab once per interval", () => {
    const poll = vi.fn();
    const doc = fakeDoc("visible");
    startBoardPoll({ poll, doc: doc.source });

    expect(poll).not.toHaveBeenCalled(); // nothing on mount; load() just ran
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 2);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("never polls a hidden tab", () => {
    const poll = vi.fn();
    const doc = fakeDoc("hidden");
    startBoardPoll({ poll, doc: doc.source });

    vi.advanceTimersByTime(POLL_INTERVAL_MS * 10);
    expect(poll).not.toHaveBeenCalled();
  });

  it("polls immediately when the tab comes back, without waiting out the interval", () => {
    const poll = vi.fn();
    const doc = fakeDoc("hidden");
    startBoardPoll({ poll, doc: doc.source });

    vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    expect(poll).not.toHaveBeenCalled();

    doc.setVisibility("visible");
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("does not poll on the way OUT to hidden", () => {
    // visibilitychange fires on both edges; only the return is worth a request.
    const poll = vi.fn();
    const doc = fakeDoc("visible");
    startBoardPoll({ poll, doc: doc.source });

    doc.setVisibility("hidden");
    expect(poll).not.toHaveBeenCalled();
  });

  it("stops completely once disposed", () => {
    // A surviving interval refetches a board that is no longer mounted, and a
    // surviving listener pins the disposed store in memory.
    const poll = vi.fn();
    const doc = fakeDoc("visible");
    const stop = startBoardPoll({ poll, doc: doc.source });

    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(poll).toHaveBeenCalledTimes(1);

    stop();
    expect(doc.listenerCount()).toBe(0);

    vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    doc.setVisibility("hidden");
    doc.setVisibility("visible");
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
