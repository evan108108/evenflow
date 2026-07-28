// AuthManager — the browser-side JWT holder. localStorage is the store
// (PLAN.md: "OAuth flow through api.4a4.ai, JWT in localStorage"); signIn
// hands the browser to the Worker's /auth/oauth/start, which 302s to 4a's
// AS for the provider dance.

import { Context, Effect, Layer } from "effect";

const STORAGE_KEY = "evenflow.jwt";

export type OAuthProvider = "google" | "github";

export interface AuthManagerService {
  readonly get: () => Effect.Effect<string | null>;
  readonly set: (jwt: string) => Effect.Effect<void>;
  readonly clear: () => Effect.Effect<void>;
  readonly signIn: (provider: OAuthProvider) => Effect.Effect<void>;
}

export class AuthManager extends Context.Tag("evenflow-web/AuthManager")<
  AuthManager,
  AuthManagerService
>() {}

export const AuthManagerLive: Layer.Layer<AuthManager> = Layer.succeed(AuthManager, {
  get: () => Effect.sync(() => window.localStorage.getItem(STORAGE_KEY)),
  set: (jwt) => Effect.sync(() => window.localStorage.setItem(STORAGE_KEY, jwt)),
  clear: () => Effect.sync(() => window.localStorage.removeItem(STORAGE_KEY)),
  signIn: (provider) =>
    Effect.sync(() => {
      window.location.assign(`/auth/oauth/start?provider=${provider}`);
    }),
});

export interface AuthManagerTestHandle {
  readonly layer: Layer.Layer<AuthManager>;
  readonly redirects: string[];
  jwt: string | null;
}

/** In-memory stand-in: no localStorage, records signIn redirects. */
export const makeAuthManagerTest = (initialJwt: string | null = null): AuthManagerTestHandle => {
  const handle: AuthManagerTestHandle = {
    jwt: initialJwt,
    redirects: [],
    layer: Layer.succeed(AuthManager, {
      get: () => Effect.sync(() => handle.jwt),
      set: (jwt) =>
        Effect.sync(() => {
          handle.jwt = jwt;
        }),
      clear: () =>
        Effect.sync(() => {
          handle.jwt = null;
        }),
      signIn: (provider) =>
        Effect.sync(() => {
          handle.redirects.push(provider);
        }),
    }),
  };
  return handle;
};
