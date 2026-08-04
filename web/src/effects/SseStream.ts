// SseStream — Effect Stream over the Worker's per-board SSE endpoint.
//
// Deliberately NOT EventSource: the /boards/:slug/stream endpoint requires
// Authorization: Bearer, and native EventSource cannot send headers. So we
// fetch() with the header and hand-parse the SSE framing off the response
// body reader — comments (": heartbeat") are dropped, "event:"+"data:"
// frames become BoardEvents.
//
// Reconnect: any failure (network drop, non-200, stream end) retries the
// whole subscription on an exponential backoff from 1s.

import { Chunk, Context, Data, Effect, Layer, Option, Schedule, Stream } from "effect";
import { AuthManager } from "./AuthManager";
import { ApiConfig } from "./ApiClient";
// Type-only: erased at build time, so this never pulls Worker code into the
// web bundle. board-events.ts is import-free precisely so this resolves.
import type { BoardEventKind as WorkerBoardEventKind } from "../../../src/durable-objects/board-events";

/**
 * Mirror of the Worker's BoardEvent kind union (src/durable-objects/board-events.ts).
 *
 * The mirror is kept rather than importing the Worker's `BoardEvent` wholesale
 * because the client's envelope is deliberately narrower — it carries only the
 * fields this app reads. What must NOT diverge is the `kind` union, and
 * `_AssertKindsInSync` below makes divergence a tsc error instead of the silent
 * drift that accumulated through EFB-22 and EFB-24 (8 kinds went unmirrored,
 * unnoticed, because BoardPage dispatches by prefix with a silent
 * fall-through). Widen the Worker union and this file goes red. See EFB-34.
 */
export interface BoardEvent {
  readonly kind: BoardEventKind;
  readonly board_id: string;
  readonly issue_id?: string;
  readonly comment_id?: string;
  readonly at_ms: number;
  readonly payload: unknown;
}

type BoardEventKind =
  | "issue.created"
  | "issue.updated"
  | "issue.transitioned"
  | "issue.container_changed"
  | "issue.deleted"
  | "comment.created"
  | "comment.deleted"
  | "board.created"
  | "board.updated"
  | "board.deleted"
  | "sprint.created"
  | "sprint.updated"
  | "sprint.started"
  | "sprint.completed"
  | "sprint.deleted"
  | "sprint.tide.updated"
  // EFB-15 — aggregate CSV import. Carries no issue_id: N issues landed, so
  // there is no single one to name. A board view refetches on receipt.
  | "issues.imported";

// Invariant (bidirectional): the mirror above and the Worker's canonical union
// must be the same set. `Equal` compares via conditional-type identity rather
// than mutual assignability, so a MISSING member and an EXTRA member both fail
// — plain `extends` would let the mirror silently narrow.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type _AssertKindsInSync = Assert<Equal<BoardEventKind, WorkerBoardEventKind>>;

export class SseError extends Data.TaggedError("SseError")<{
  readonly reason: "connect" | "http" | "read";
  readonly status?: number;
}> {}

/** Longest a tab will ever wait before trying to reconnect. */
export const MAX_RECONNECT_DELAY = "30 seconds";

/**
 * EFB-104 — the reconnect policy, and the root cause of EFB-102.
 *
 * This was `Schedule.exponential("1 second")`, uncapped. Its delay sequence is
 *
 *     1s 2s 4s 8s 16s 32s 64s 128s 256s 512s 1024s 2048s …
 *
 * so the 9th consecutive failure waits 4m16s and the 12th waits 34m, growing
 * without bound. That is the whole of EFB-102: an issue was transitioned
 * through the REST API, the board UI still showed the old column minutes
 * later, and a cache-busted read confirmed the server was right. The audit in
 * this same ticket proved the emit was never missing — `transitionIssue` emits
 * `issue.transitioned`, and 25 of 30 board-domain routes emit. Nothing was
 * wrong on the write side. The tab simply was not connected to hear it.
 *
 * WHY A LONG-LIVED TAB GETS THERE, which is the part that surprised me:
 * `Stream.retry` resets its schedule driver on every OUTPUT the stream emits
 * (`channel.mapOutEffect(out => Effect.as(driver.reset, out))` in Effect's
 * internal/stream). The pull loop below consumes heartbeats and the
 * `: connected` comment WITHOUT emitting — only a real BoardEvent produces a
 * chunk. So on a quiet board, every reconnect succeeds and none of them reset
 * the backoff. The exponential stops meaning "consecutive failures" and starts
 * meaning "failures for the lifetime of this tab", which on a board with
 * little traffic is a one-way ratchet.
 *
 * WHY THE CAP AND NOT A RESET-ON-CONNECT: resetting the moment a connection is
 * established would make a FLAPPING connection retry every second forever,
 * which is how a client-side reconnect turns into a self-inflicted outage on
 * the server it is trying to reach. Resetting only once a connection has
 * proven itself is the correct shape, and "proven itself" is exactly what
 * receiving an event demonstrates. So the reset stays where it is and the
 * unbounded growth — the actual defect — is bounded instead.
 *
 * WHAT THIS DOES NOT FIX, and why the poll is still load-bearing rather than
 * belt-and-braces: BoardDO's subscriber set is in-memory with no replay, so an
 * event emitted while a tab is disconnected is gone for that tab even after it
 * reconnects. The cap shrinks that window from unbounded to ≤30s; it cannot
 * close it. Backfill-on-reconnect would, and EFB-104 explicitly scoped it out
 * because the 60s poll covers the same ground for every cause at once —
 * including causes nobody has diagnosed yet. See web/src/lib/boardPoll.ts.
 */
export const RECONNECT_POLICY = Schedule.union(
  Schedule.exponential("1 second"),
  Schedule.spaced(MAX_RECONNECT_DELAY),
);

export interface SseStreamService {
  readonly subscribe: (path: string) => Stream.Stream<BoardEvent, SseError>;
}

export class SseStream extends Context.Tag("evenflow-web/SseStream")<
  SseStream,
  SseStreamService
>() {}

/** Parse complete SSE frames out of a text buffer; returns [events, rest]. */
export const parseSseBuffer = (buffer: string): [BoardEvent[], string] => {
  const events: BoardEvent[] = [];
  const frames = buffer.split("\n\n");
  const rest = frames.pop() ?? "";
  for (const frame of frames) {
    const dataLines = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) continue; // comment / heartbeat frame
    try {
      events.push(JSON.parse(dataLines.join("\n")) as BoardEvent);
    } catch {
      // Malformed frame: skip rather than kill the stream.
    }
  }
  return [events, rest];
};

export const SseStreamLive: Layer.Layer<SseStream, never, ApiConfig | AuthManager> = Layer.effect(
  SseStream,
  Effect.gen(function* () {
    const config = yield* ApiConfig;
    const auth = yield* AuthManager;

    const connect = (path: string): Stream.Stream<BoardEvent, SseError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const jwt = yield* auth.get();
          const headers: Record<string, string> = { Accept: "text/event-stream" };
          if (jwt !== null) headers["Authorization"] = `Bearer ${jwt}`;

          const res = yield* Effect.tryPromise({
            try: () => fetch(`${config.baseUrl}${path}`, { headers }),
            catch: () => new SseError({ reason: "connect" }),
          });
          if (!res.ok || res.body === null) {
            return yield* new SseError({ reason: "http", status: res.status });
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          // Each pull reads until at least one full frame is buffered (or
          // the stream ends). Heartbeat-only reads just loop again.
          //
          // On `done: true`: the server-side reader has ended, which happens
          // in production most commonly when Cloudflare replaces the Worker
          // instance on a deploy (the DO drops open SSE connections). Fail
          // with a real SseError so Stream.retry below fires and we
          // reconnect — Option.none() would terminate the stream cleanly and
          // the client would silently stop receiving updates. Symptom: SSE
          // worked pre-deploy, went dark post-deploy until the user hit
          // reload. (Filed as EFB-19 during dogfood 2026-07-30.)
          const pull = Effect.gen(function* () {
            for (;;) {
              const { value, done } = yield* Effect.tryPromise({
                try: () => reader.read(),
                catch: () => new SseError({ reason: "read" }),
              });
              if (done) return yield* Effect.fail(new SseError({ reason: "read" }));
              buffer += decoder.decode(value, { stream: true });
              const [events, rest] = parseSseBuffer(buffer);
              buffer = rest;
              if (events.length > 0) return Chunk.fromIterable(events);
            }
          }).pipe(Effect.mapError((e) => (Option.isOption(e) ? e : Option.some(e as SseError))));

          return Stream.fromPull(
            Effect.acquireRelease(Effect.succeed(pull), () =>
              Effect.promise(() => reader.cancel().catch(() => undefined)),
            ),
          );
        }),
      );

    return {
      subscribe: (path) => connect(path).pipe(Stream.retry(RECONNECT_POLICY)),
    };
  }),
);
