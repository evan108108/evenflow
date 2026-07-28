// Browser-side Effect environment — same vocabulary as the Worker: Tags,
// Layers, one composed AppLayer, and a ManagedRuntime pages run programs on.

import { Layer, ManagedRuntime } from "effect";
import { ApiClientLive, ApiConfigLive } from "./ApiClient";
import { AuthManagerLive } from "./AuthManager";
import { SseStreamLive } from "./SseStream";

export {
  ApiClient,
  ApiClientLive,
  ApiConfig,
  ApiConfigLive,
  ApiError,
  type ApiClientService,
  type ApiConfigService,
} from "./ApiClient";
export {
  AuthManager,
  AuthManagerLive,
  makeAuthManagerTest,
  type AuthManagerService,
  type AuthManagerTestHandle,
  type OAuthProvider,
} from "./AuthManager";
export {
  SseStream,
  SseStreamLive,
  SseError,
  parseSseBuffer,
  type BoardEvent,
  type SseStreamService,
} from "./SseStream";

const base = Layer.mergeAll(ApiConfigLive, AuthManagerLive);

/** Everything a page can yield*: ApiClient, SseStream, AuthManager, ApiConfig. */
export const AppLayer = Layer.mergeAll(
  base,
  Layer.provide(ApiClientLive, base),
  Layer.provide(SseStreamLive, base),
);

/** The app-wide runtime; pages call appRuntime.runPromise(program). */
export const appRuntime = ManagedRuntime.make(AppLayer);
