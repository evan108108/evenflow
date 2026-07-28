// BoardsList — first protected page. Redirects home when signed out, then
// runs the ApiClient Effect for GET /api/v0/boards and lists what came
// back. Deliberately unpolished: Phase 8 owns the real board UI; this page
// proves the auth → Effect → REST data flow.

import { useNavigate } from "@solidjs/router";
import { For, Show, createResource, onMount } from "solid-js";
import { Effect } from "effect";
import type { ApiError } from "../effects";
import { ApiClient, AuthManager, appRuntime } from "../effects";

interface BoardRow {
  id: string;
  slug: string;
  title: string;
  updated_at_ms: number;
}
interface BoardsPage {
  boards: BoardRow[];
  total: number;
}

const fetchBoards = (): Promise<BoardsPage> =>
  appRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* ApiClient;
      return yield* client.get<BoardsPage>("/api/v0/boards");
    }),
  );

export const BoardsList = () => {
  const navigate = useNavigate();

  onMount(() => {
    void appRuntime
      .runPromise(Effect.flatMap(AuthManager, (a) => a.get()))
      .then((jwt) => {
        if (jwt === null) navigate("/", { replace: true });
      });
  });

  const [page] = createResource(fetchBoards);

  return (
    <main style={{ "max-width": "var(--measure)", margin: "0 auto", padding: "4rem 1.5rem" }}>
      <header
        style={{
          display: "flex",
          "align-items": "baseline",
          "justify-content": "space-between",
          "margin-bottom": "2.5rem",
        }}
      >
        <h1 style={{ "font-size": "2.6rem" }}>Boards</h1>
        <button class="btn" disabled title="Coming in Phase 8">
          Create board
        </button>
      </header>

      <Show when={!page.loading} fallback={<p class="muted">Finding the rhythm…</p>}>
        <Show
          when={page.error === undefined}
          fallback={
            <p class="muted">
              The current pushed back ({((page.error as ApiError | undefined)?.status ?? "network")}
              ). <a href="/boards">Try again</a> or <a href="/">sign in afresh</a>.
            </p>
          }
        >
          <Show
            when={(page()?.boards.length ?? 0) > 0}
            fallback={<p class="muted">Still waters. What flows next?</p>}
          >
            <ul style={{ "list-style": "none", margin: 0, padding: 0 }}>
              <For each={page()?.boards}>
                {(board) => (
                  <li
                    style={{
                      padding: "1.1rem 1.2rem",
                      "margin-bottom": "0.8rem",
                      background: "var(--color-paper-raised)",
                      border: "1px solid var(--color-ink-faint)",
                      "border-radius": "var(--radius-chamfer)",
                      display: "flex",
                      "justify-content": "space-between",
                      "align-items": "baseline",
                    }}
                  >
                    <span class="serif" style={{ "font-size": "1.25rem" }}>
                      {board.title}
                    </span>
                    <span class="muted" style={{ "font-size": "0.85rem" }}>
                      {new Date(board.updated_at_ms).toLocaleDateString()}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </main>
  );
};
