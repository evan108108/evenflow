// Shared HTTP-layer types: the Hono environment (bindings + typed context
// variables) and the layer-factory seam that lets tests swap the Live
// Effect environment for Test layers.

import type { Context } from "hono";
import type { Layer } from "effect";
import type { AppServices, Claims, WorkerEnv } from "./effects";
import type { Grant } from "./scopes";

export interface AuthVariables {
  // Both optional since phase 16: /api/v0 runs behind optionalAuth so public
  // boards can be read anonymously. `claims` is set iff the request carried
  // a valid JWT; `token` is that raw JWT (routes forward it to 4a publish
  // calls). Mutations gate on requireCaller(claims).
  claims?: Claims;
  token?: string;
  /**
   * EFB-100 — what the caller's API key may do, or null when nothing narrows
   * them (a JWT session, or a key minted before scoping existed).
   *
   * Deliberately NOT folded into `claims`. Claims answer "who is this?" and
   * are what a JWT signs; grants answer "what may they do?" and are read from
   * the key row at verification time. Keeping them apart means a JWT can
   * never arrive carrying an authorization field it did not earn, and the two
   * questions stay separable at every call site that only needs one.
   *
   * The auth middleware enforces the domain+access half itself; this variable
   * exists so `authorizeBoard` can enforce the instance half once the board is
   * resolved.
   */
  grants?: readonly Grant[] | null;
}

export type AppHonoEnv = {
  Bindings: WorkerEnv;
  Variables: AuthVariables;
};

/**
 * EFB-100 — the one correct way to read a caller's grants off a request.
 *
 * Exists so the right value is CHEAPER TO WRITE than any wrong one. Every
 * route shell says `grants: grantsOf(c)` — four tokens, identical everywhere,
 * greppable in one line for review. The alternative, hand-writing
 * `c.get("grants") ?? null` at every call site, is the shape where somebody
 * eventually types something subtly different and nobody notices, because a
 * wrong-but-valid grants value fails OPEN.
 *
 * `grants` is REQUIRED on ActionInput rather than optional, so a route that
 * forgets to thread it is a compile error rather than a silent widening. That
 * is the same reasoning twice over in one ticket: on this table, absence has
 * always meant permission — an omitted INSERT column and an omitted options
 * field would both have granted full owner authority — so any field whose
 * absence grants authority must be one the compiler will not let you omit.
 */
export const grantsOf = (c: Context<AppHonoEnv>): readonly Grant[] | null =>
  c.get("grants") ?? null;

/**
 * Resolves the Effect environment for one request. Production code passes
 * nothing and gets `bootstrap`; tests pass `() => testLayer`.
 */
export type LayerFor = (env: WorkerEnv) => Layer.Layer<AppServices>;
