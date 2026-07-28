// Top-level Effect environment for the Evenflow Worker.
//
// AppEnv is the Context.Tag carrying the raw Cloudflare bindings for the
// current request (Hono's `c.env`). Every Live service layer reads what it
// needs from AppEnv, so the only per-request wiring is
// `Layer.succeed(AppEnv, c.env)` — done once inside `bootstrap`.
//
// Handlers are written against the service Tags (Db, Jwt, KmsClient,
// AuditLog) and never touch AppEnv directly.

import { Context, Layer } from "effect";
import { Db, DbLive } from "./Db";
import { Jwt, JwtLive } from "./Jwt";
import { KmsClient, KmsClientLive } from "./KmsClient";
import { AuditLog, AuditLogLive } from "./AuditLog";

/**
 * Raw Cloudflare Worker bindings. Members are optional while their
 * wrangler.toml bindings are still commented out — Live layers construct
 * fine without them and fail typed at call time instead.
 */
export interface WorkerEnv {
  readonly DB?: D1Database;
  readonly JWT_SIGNING_KEY?: string;
}

export class AppEnv extends Context.Tag("evenflow/AppEnv")<AppEnv, WorkerEnv>() {}

/** Union of every service a handler can require. */
export type AppServices = Db | Jwt | KmsClient | AuditLog;

/** All Live services merged, still awaiting the per-request AppEnv. */
export const AppLive: Layer.Layer<AppServices, never, AppEnv> = Layer.mergeAll(
  DbLive,
  JwtLive,
  KmsClientLive,
  AuditLogLive,
);

/** Compose the full Live environment for one request from Hono's `c.env`. */
export const bootstrap = (env: WorkerEnv): Layer.Layer<AppServices> =>
  Layer.provide(AppLive, Layer.succeed(AppEnv, env));
