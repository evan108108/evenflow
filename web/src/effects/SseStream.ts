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
  | "sprint.created"
  | "sprint.updated"
  | "sprint.started"
  | "sprint.completed"
  | "sprint.deleted"
  | "sprint.tide.updated";

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
      subscribe: (path) =>
        connect(path).pipe(Stream.retry(Schedule.exponential("1 second"))),
    };
  }),
);
