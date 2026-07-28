// SignIn — the /auth/callback pit stop. 4a's AS returns here with the JWT
// in the query (?jwt= / ?token=) or the fragment (#jwt=); we persist it via
// AuthManager and move on to /boards. No UI beyond a transitional line.

import { useNavigate } from "@solidjs/router";
import { createSignal, onMount } from "solid-js";
import { Effect } from "effect";
import { AuthManager, appRuntime } from "../effects";

/** Extract the JWT from a callback URL — query first, then fragment. */
export const jwtFromCallbackUrl = (url: URL): string | null => {
  const fromQuery = url.searchParams.get("jwt") ?? url.searchParams.get("token");
  if (fromQuery !== null && fromQuery !== "") return fromQuery;
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const fromFragment = fragment.get("jwt") ?? fragment.get("token");
  return fromFragment !== null && fromFragment !== "" ? fromFragment : null;
};

export const SignIn = () => {
  const navigate = useNavigate();
  const [failed, setFailed] = createSignal(false);

  onMount(() => {
    const jwt = jwtFromCallbackUrl(new URL(window.location.href));
    if (jwt === null) {
      setFailed(true);
      return;
    }
    void appRuntime
      .runPromise(
        Effect.gen(function* () {
          const auth = yield* AuthManager;
          yield* auth.set(jwt);
        }),
      )
      .then(() => navigate("/boards", { replace: true }));
  });

  return (
    <main style={{ display: "grid", "place-items": "center", "min-height": "100vh" }}>
      {failed() ? (
        <p class="muted">
          No token came back with you. <a href="/">Head back to the flow →</a>
        </p>
      ) : (
        <p class="muted">Catching the current…</p>
      )}
    </main>
  );
};
