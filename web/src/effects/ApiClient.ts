// ApiClient — typed Effect wrapper over fetch() for the Evenflow REST API.
// Same-origin by default (the SPA is served by the Worker that serves the
// API); ApiConfig exists so tests and previews can point elsewhere.
// Every request auto-attaches Authorization: Bearer <jwt> from AuthManager
// when a token is present.

import { Context, Data, Effect, Layer } from "effect";
import { AuthManager } from "./AuthManager";

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly reason: "network" | "http" | "json";
  readonly status?: number;
  readonly body?: unknown;
}> {}

export interface ApiConfigService {
  readonly baseUrl: string;
}

export class ApiConfig extends Context.Tag("evenflow-web/ApiConfig")<
  ApiConfig,
  ApiConfigService
>() {}

/** Same-origin default: paths hit the Worker that served the SPA. */
export const ApiConfigLive: Layer.Layer<ApiConfig> = Layer.succeed(ApiConfig, { baseUrl: "" });

export interface ApiClientService {
  readonly get: <T>(path: string) => Effect.Effect<T, ApiError>;
  readonly post: <T>(path: string, body: unknown) => Effect.Effect<T, ApiError>;
  readonly patch: <T>(path: string, body: unknown) => Effect.Effect<T, ApiError>;
  readonly delete: <T>(path: string) => Effect.Effect<T, ApiError>;
}

export class ApiClient extends Context.Tag("evenflow-web/ApiClient")<
  ApiClient,
  ApiClientService
>() {}

export const ApiClientLive: Layer.Layer<ApiClient, never, ApiConfig | AuthManager> = Layer.effect(
  ApiClient,
  Effect.gen(function* () {
    const config = yield* ApiConfig;
    const auth = yield* AuthManager;

    const request = <T>(method: string, path: string, body?: unknown): Effect.Effect<T, ApiError> =>
      Effect.gen(function* () {
        const jwt = yield* auth.get();
        const headers: Record<string, string> = {};
        if (jwt !== null) headers["Authorization"] = `Bearer ${jwt}`;
        if (body !== undefined) headers["Content-Type"] = "application/json";

        const res = yield* Effect.tryPromise({
          try: () =>
            fetch(`${config.baseUrl}${path}`, {
              method,
              headers,
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          catch: () => new ApiError({ reason: "network" }),
        });

        const parsed = yield* Effect.tryPromise({
          try: () => res.json() as Promise<unknown>,
          catch: () => new ApiError({ reason: "json", status: res.status }),
        });

        if (!res.ok) {
          return yield* new ApiError({ reason: "http", status: res.status, body: parsed });
        }
        return parsed as T;
      });

    return {
      get: <T>(path: string) => request<T>("GET", path),
      post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
      patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
      delete: <T>(path: string) => request<T>("DELETE", path),
    };
  }),
);
