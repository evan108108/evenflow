// BoardEmitter — Effect service bridging committed mutations to the
// per-board BoardDO fanout.
//
// Live resolves the board's DO instance (idFromName(board_id)) and POSTs the
// event to its /emit route. Same missing-binding posture as Db: the layer
// constructs without env.BOARD and calls fail typed instead.
//
// Handlers call emitBoardEvent, which swallows EmitError with a warn log —
// the D1 write already committed, so a fanout hiccup must never turn a
// successful mutation into a 500. Live clients recover on reconnect.

import { Context, Data, Effect, Layer } from "effect";
import { AppEnv } from "./AppEnv";
import type { BoardEvent } from "../durable-objects/BoardDO";

export type { BoardEvent, BoardEventKind } from "../durable-objects/BoardDO";

export class EmitError extends Data.TaggedError("EmitError")<{
  readonly reason: "no-binding" | "emit-failed";
  readonly cause?: unknown;
}> {}

export interface BoardEmitterService {
  readonly emit: (board_id: string, event: BoardEvent) => Effect.Effect<void, EmitError>;
}

export class BoardEmitter extends Context.Tag("evenflow/BoardEmitter")<
  BoardEmitter,
  BoardEmitterService
>() {}

export const BoardEmitterLive: Layer.Layer<BoardEmitter, never, AppEnv> = Layer.effect(
  BoardEmitter,
  Effect.gen(function* () {
    const env = yield* AppEnv;
    return {
      emit: (board_id, event) => {
        const ns = env.BOARD;
        if (ns === undefined) return Effect.fail(new EmitError({ reason: "no-binding" }));
        return Effect.tryPromise({
          try: async () => {
            const stub = ns.get(ns.idFromName(board_id));
            const res = await stub.fetch("https://board-do/emit", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(event),
            });
            if (!res.ok) throw new Error(`emit-status-${res.status}`);
          },
          catch: (cause) => new EmitError({ reason: "emit-failed", cause }),
        });
      },
    };
  }),
);

/** Best-effort fanout after a committed write: failures log, never fail the mutation. */
export const emitBoardEvent = (
  board_id: string,
  event: BoardEvent,
): Effect.Effect<void, never, BoardEmitter> =>
  Effect.gen(function* () {
    const emitter = yield* BoardEmitter;
    yield* emitter.emit(board_id, event).pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          console.log(
            JSON.stringify({ warn: "board-emit-failed", board_id, kind: event.kind, reason: e.reason }),
          );
        }),
      ),
    );
  });

export interface BoardEmitterTestHandle {
  readonly layer: Layer.Layer<BoardEmitter>;
  readonly events: Array<{ board_id: string; event: BoardEvent }>;
}

/** In-memory recorder standing in for the DO fanout in tests. */
export const makeBoardEmitterTest = (): BoardEmitterTestHandle => {
  const events: Array<{ board_id: string; event: BoardEvent }> = [];
  return {
    events,
    layer: Layer.succeed(BoardEmitter, {
      emit: (board_id, event) =>
        Effect.sync(() => {
          events.push({ board_id, event });
        }),
    }),
  };
};
