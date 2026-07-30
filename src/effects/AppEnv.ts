// Top-level Effect environment for the Evenflow Worker.
//
// AppEnv is the Context.Tag carrying the raw Cloudflare bindings for the
// current request (Hono's `c.env`). Every Live service layer reads what it
// needs from AppEnv, so the only per-request wiring is
// `Layer.succeed(AppEnv, c.env)` — done once inside `bootstrap`.
//
// Handlers are written against the service Tags (Db, Jwt, FourA,
// AuditLog) and never touch AppEnv directly.

import { Context, Layer } from "effect";
import { Db, DbLive } from "./Db";
import { FourA, FourALive } from "./FourA";
import { Jwt, JwtLive } from "./Jwt";
import { AuditLog, AuditLogLive } from "./AuditLog";
import { BoardEmitter, BoardEmitterLive } from "./BoardEmitter";
import { Email, EmailLive } from "./Email";
import { Blossom, BlossomLive } from "./Blossom";
import { S3, S3Live } from "./S3";
import { Audience, AudienceLive } from "./Audience";

/**
 * Raw Cloudflare Worker bindings. Members are optional while their
 * wrangler.toml bindings are still commented out — Live layers construct
 * fine without them and fail typed at call time instead.
 */
export interface WorkerEnv {
  readonly DB?: D1Database;
  readonly BOARD?: DurableObjectNamespace;
  readonly ASSETS?: Fetcher;
  readonly JWT_SIGNING_KEY?: string;
  readonly OAUTH_CLIENT_SECRET_4A?: string;
  readonly AGENTMAIL_API_KEY?: string;
  /** Default Evenflow-managed Blossom host (phase 18a attachments). */
  readonly EVENFLOW_DEFAULT_BLOSSOM_URL?: string;
  /** 32-byte hex Nostr secret for the service key that signs BUD-01 uploads. */
  readonly EVENFLOW_BLOSSOM_SECRET?: string;
  /**
   * 32-byte hex secret deriving the static server storage keypair that BYO
   * S3 credentials are NIP-44-encrypted to (phase 18b). Deliberately a
   * separate secret from EVENFLOW_BLOSSOM_SECRET — no key reuse across
   * schnorr signing and ECDH.
   */
  readonly EVENFLOW_STORAGE_SECRET?: string;
  /**
   * 32-byte hex secret deriving the server audience keypair that seals
   * private-board aud_id/epoch scalars at rest in D1 (phase 16.5). A third
   * distinct secret — no key reuse with blossom or storage.
   */
  readonly EVENFLOW_AUDIENCE_SECRET?: string;
  /**
   * 32-byte hex AES-GCM key sealing per-board GitHub webhook secrets at
   * rest in D1 (phase 21). A fourth distinct secret — symmetric this time,
   * and no key reuse with blossom (schnorr), storage (ECDH), or audience.
   * Unlike an API key hash, a webhook secret must be recoverable: HMAC
   * verification needs the shared secret back on every delivery.
   */
  readonly EVENFLOW_WEBHOOK_SECRET?: string;
}

export class AppEnv extends Context.Tag("evenflow/AppEnv")<AppEnv, WorkerEnv>() {}

/** Union of every service a handler can require. */
export type AppServices = Db | Jwt | FourA | AuditLog | BoardEmitter | Email | Blossom | S3 | Audience;

/** All Live services merged, still awaiting the per-request AppEnv. */
export const AppLive: Layer.Layer<AppServices, never, AppEnv> = Layer.mergeAll(
  DbLive,
  JwtLive,
  FourALive,
  AuditLogLive,
  BoardEmitterLive,
  EmailLive,
  BlossomLive,
  S3Live,
  AudienceLive,
);

/** Compose the full Live environment for one request from Hono's `c.env`. */
export const bootstrap = (env: WorkerEnv): Layer.Layer<AppServices> =>
  Layer.provide(AppLive, Layer.succeed(AppEnv, env));
