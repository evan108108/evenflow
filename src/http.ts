// Shared HTTP-layer types: the Hono environment (bindings + typed context
// variables) and the layer-factory seam that lets tests swap the Live
// Effect environment for Test layers.

import type { Layer } from "effect";
import type { AppServices, Claims, WorkerEnv } from "./effects";

export interface AuthVariables {
  claims: Claims;
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
