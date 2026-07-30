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

/** Mirror of the Worker's BoardEvent (src/durable-objects/BoardDO.ts). */
export interface BoardEvent {
  readonly kind:
    | "issue.created"
    | "issue.updated"
    | "issue.transitioned"
    | "issue.container_changed"
    | "issue.deleted"
    | "comment.created"
    | "comment.deleted";
  readonly board_id: string;
  readonly issue_id?: string;
  readonly comment_id?: string;
  readonly at_ms: number;
  readonly payload: unknown;
}

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
