// Infinite-scroll sentinel (phase 22).
//
// A zero-height marker at the bottom of a paged list. When it scrolls into
// view the list asks its stream for the next page; when the stream is
// exhausted the sentinel unmounts entirely, so a fully-loaded list carries
// no observer and no DOM weight.
//
// Two properties matter and both are easy to get wrong:
//
//  1. `rootMargin` pre-fetches BEFORE the sentinel is actually visible,
//     otherwise the user reaches true bottom and then waits.
//  2. Re-entrancy. A fast scroll fires the callback repeatedly before the
//     first page lands. The store's loadNext coalesces concurrent calls
//     onto one in-flight promise, so this component may call freely — but
//     it still skips while `loading()` to avoid queueing pointless work.

import { Show, createEffect, onCleanup } from "solid-js";

export interface StreamHandle {
  readonly loadNext: () => Promise<void>;
  readonly hasMore: () => boolean;
  readonly loading: () => boolean;
  readonly started: () => boolean;
}

/** Start fetching this far before the sentinel actually enters the viewport. */
const ROOT_MARGIN = "300px";

export const StreamSentinel = (props: { stream: StreamHandle; label?: string }) => {
  let el: HTMLDivElement | undefined;

  createEffect(() => {
    const node = el;
    if (node === undefined) return;
    // Read reactively so the observer is torn down once the stream ends.
    if (!props.stream.hasMore()) return;

    // jsdom has no IntersectionObserver; without this guard the board
    // simply throws on mount under test.
    if (typeof IntersectionObserver === "undefined") {
      void props.stream.loadNext();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (props.stream.loading()) return;
        void props.stream.loadNext();
      },
      { rootMargin: ROOT_MARGIN },
    );
    observer.observe(node);
    onCleanup(() => observer.disconnect());
  });

  return (
    <Show when={props.stream.hasMore()}>
      <div ref={el} class="stream-sentinel" aria-hidden="true">
        <Show when={props.stream.loading()}>
          <span class="stream-sentinel-dots">…</span>
        </Show>
      </div>
    </Show>
  );
};
