// Phase 22 client tests: the infinite-scroll sentinel and the store's
// per-stream paging.
//
// The property that actually matters is re-entrancy. A fast scroll fires
// the observer callback many times before the first page lands; if each
// call issued a request they would all page from the SAME cursor, so the
// list would show one page repeated N times and skip the rest.

import { describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { StreamSentinel, type StreamHandle } from "./StreamSentinel";

const mount = (component: () => unknown) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(component as () => any, container);
  return {
    container,
    cleanup: () => {
      dispose();
      container.remove();
    },
  };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Minimal IntersectionObserver stand-in; jsdom ships none. */
class FakeIO {
  static instances: FakeIO[] = [];
  readonly cb: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    FakeIO.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  unobserve() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** Simulate the sentinel scrolling into view. */
  fire() {
    this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as never);
  }
}

const withFakeIO = (fn: () => Promise<void> | void) => async () => {
  FakeIO.instances = [];
  const original = (globalThis as Record<string, unknown>)["IntersectionObserver"];
  (globalThis as Record<string, unknown>)["IntersectionObserver"] = FakeIO as never;
  try {
    await fn();
  } finally {
    (globalThis as Record<string, unknown>)["IntersectionObserver"] = original as never;
  }
};

/**
 * A stream whose loadNext coalesces concurrent calls, like the real store.
 * hasMore/loading are SIGNALS because the real store's are too — the
 * sentinel's <Show> and its observer teardown both depend on that
 * reactivity, so a plain-closure fake would silently not exercise them.
 */
const makeStream = (pages: number) => {
  let served = 0;
  let inflight: Promise<void> | null = null;
  const [loading, setLoading] = createSignal(false);
  const [hasMore, setHasMore] = createSignal(true);
  const calls: number[] = [];
  const handle: StreamHandle = {
    hasMore,
    loading,
    started: () => served > 0,
    loadNext: () => {
      if (inflight !== null) return inflight;
      if (!hasMore()) return Promise.resolve();
      setLoading(true);
      calls.push(served);
      const p = (async () => {
        await flush();
        served++;
        setHasMore(served < pages);
        setLoading(false);
        inflight = null;
      })();
      inflight = p;
      return p;
    },
  };
  return { handle, calls, servedCount: () => served };
};

describe("StreamSentinel", () => {
  it(
    "loads a page when the sentinel scrolls into view",
    withFakeIO(async () => {
      const { handle, servedCount } = makeStream(3);
      const { cleanup } = mount(() => <StreamSentinel stream={handle} />);
      await flush();
      FakeIO.instances[0]!.fire();
      await flush();
      await flush();
      expect(servedCount()).toBe(1);
      cleanup();
    }),
  );

  it(
    "fires exactly one request per cursor even on a rapid scroll",
    withFakeIO(async () => {
      const { handle, calls } = makeStream(3);
      const { cleanup } = mount(() => <StreamSentinel stream={handle} />);
      await flush();
      const io = FakeIO.instances[0]!;
      // Ten intersection callbacks before the first page resolves.
      for (let i = 0; i < 10; i++) io.fire();
      await flush();
      await flush();
      // All ten coalesced onto the one in-flight page.
      expect(calls).toEqual([0]);
      cleanup();
    }),
  );

  it(
    "unmounts the sentinel once the stream is exhausted",
    withFakeIO(async () => {
      const { handle } = makeStream(1);
      const { container, cleanup } = mount(() => <StreamSentinel stream={handle} />);
      await flush();
      expect(container.querySelector(".stream-sentinel")).not.toBeNull();
      FakeIO.instances[0]!.fire();
      await flush();
      await flush();
      // hasMore false → no sentinel, no observer, no DOM weight.
      expect(container.querySelector(".stream-sentinel")).toBeNull();
      cleanup();
    }),
  );

  it(
    "renders no sentinel at all for an already-exhausted stream",
    withFakeIO(async () => {
      const exhausted: StreamHandle = {
        hasMore: () => false,
        loading: () => false,
        started: () => true,
        loadNext: vi.fn(async () => undefined),
      };
      const { container, cleanup } = mount(() => <StreamSentinel stream={exhausted} />);
      await flush();
      expect(container.querySelector(".stream-sentinel")).toBeNull();
      expect(exhausted.loadNext).not.toHaveBeenCalled();
      cleanup();
    }),
  );

  it("falls back to a direct load when IntersectionObserver is absent", async () => {
    // jsdom has no IO; without the guard in StreamSentinel the board would
    // throw on mount under test rather than degrade.
    const original = (globalThis as Record<string, unknown>)["IntersectionObserver"];
    delete (globalThis as Record<string, unknown>)["IntersectionObserver"];
    try {
      const { handle, servedCount } = makeStream(2);
      const { cleanup } = mount(() => <StreamSentinel stream={handle} />);
      await flush();
      await flush();
      expect(servedCount()).toBe(1);
      cleanup();
    } finally {
      (globalThis as Record<string, unknown>)["IntersectionObserver"] = original as never;
    }
  });
});
