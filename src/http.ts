// Shared HTTP-layer types: the Hono environment (bindings + typed context
// variables) and the layer-factory seam that lets tests swap the Live
// Effect environment for Test layers.

import type { Layer } from "effect";
import type { AppServices, Claims, WorkerEnv } from "./effects";

export interface AuthVariables {
  // Both optional since phase 16: /api/v0 runs behind optionalAuth so public
  // boards can be read anonymously. `claims` is set iff the request carried
  // a valid JWT; `token` is that raw JWT (routes forward it to 4a publish
  // calls). Mutations gate on requireCaller(claims).
  claims?: Claims;
  token?: string;
}

export type AppHonoEnv = {
  Bindings: WorkerEnv;
  Variables: AuthVariables;
};

/**
 * Resolves the Effect environment for one request. Production code passes
 * nothing and gets `bootstrap`; tests pass `() => testLayer`.
 */
export type LayerFor = (env: WorkerEnv) => Layer.Layer<AppServices>;
