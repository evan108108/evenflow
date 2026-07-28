// Db — Effect service for Cloudflare D1 access.
//
// The Live layer reads `env.DB` from AppEnv. The D1 binding is not wired in
// wrangler.toml yet, so the layer must construct cleanly without it: calls
// against a missing binding fail with DbError("no-binding") rather than
// crashing layer construction (which would take down routes that never
// touch the database).

import { Context, Data, Effect, Layer } from "effect";
import { AppEnv } from "./AppEnv";

export class DbError extends Data.TaggedError("DbError")<{
  readonly reason: "no-binding" | "query-failed";
  readonly cause?: unknown;
}> {}

export interface DbService {
  readonly execute: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<void, DbError>;
  readonly queryFirst: <Row = unknown>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<Row | null, DbError>;
  readonly queryAll: <Row = unknown>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<Row>, DbError>;
}

export class Db extends Context.Tag("evenflow/Db")<Db, DbService>() {}

const makeD1 = (d1: D1Database | undefined): DbService => {
  if (d1 === undefined) {
    const dead = Effect.fail(new DbError({ reason: "no-binding" }));
    return {
      execute: () => dead,
      queryFirst: () => dead,
      queryAll: () => dead,
    };
  }

  const bind = (sql: string, params?: ReadonlyArray<unknown>) =>
    params && params.length > 0 ? d1.prepare(sql).bind(...params) : d1.prepare(sql);

  return {
    execute: (sql, params) =>
      Effect.tryPromise({
        try: async () => {
          await bind(sql, params).run();
        },
        catch: (cause) => new DbError({ reason: "query-failed", cause }),
      }),
    queryFirst: <Row>(sql: string, params?: ReadonlyArray<unknown>) =>
      Effect.tryPromise({
        try: () => bind(sql, params).first<Row>(),
        catch: (cause) => new DbError({ reason: "query-failed", cause }),
      }),
    queryAll: <Row>(sql: string, params?: ReadonlyArray<unknown>) =>
      Effect.tryPromise({
        try: async () => {
          const result = await bind(sql, params).all<Row>();
          return result.results;
        },
        catch: (cause) => new DbError({ reason: "query-failed", cause }),
      }),
  };
};

export const DbLive: Layer.Layer<Db, never, AppEnv> = Layer.effect(
  Db,
  Effect.gen(function* () {
    const env = yield* AppEnv;
    return makeD1(env.DB);
  }),
);

/** In-memory stub: succeeds with empty results, never touches D1. */
export const DbTest: Layer.Layer<Db> = Layer.succeed(Db, {
  execute: () => Effect.void,
  queryFirst: () => Effect.succeed(null),
  queryAll: () => Effect.succeed([]),
});
