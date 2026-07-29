// BoardsList — first protected page. Redirects home when signed out, then
// runs the ApiClient Effect for GET /api/v0/boards and lists what came
// back. Deliberately unpolished otherwise: Phase 8 owns the real board UI.

import { useNavigate } from "@solidjs/router";
import { For, Show, createResource, createSignal, onMount } from "solid-js";
import { Effect } from "effect";
import type { ApiError } from "../effects";
import { ApiClient, AuthManager, appRuntime } from "../effects";
import { NewBoardModal, type CreatedBoard, type NewBoardInput } from "../components/NewBoardModal";

interface BoardRow {
  id: string;
  slug: string;
  title: string;
  issue_prefix: string | null;
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

const createBoard = (input: NewBoardInput): Promise<{ board: BoardRow }> =>
  appRuntime.runPromise(
    Effect.gen(function* () {
      const client = yield* ApiClient;
      return yield* client.post<{ board: BoardRow }>("/api/v0/boards", input);
    }),
  );

export const BoardsList = () => {
  const navigate = useNavigate();
  const [showModal, setShowModal] = createSignal(false);

  onMount(() => {
    void appRuntime
      .runPromise(Effect.flatMap(AuthManager, (a) => a.get()))
      .then((jwt) => {
        if (jwt === null) navigate("/", { replace: true });
      });
  });

  const [page, { refetch }] = createResource(fetchBoards);

  const onCreate = async (input: NewBoardInput): Promise<CreatedBoard> => {
    const { board } = await createBoard(input);
    void refetch();
    return board;
  };

  const onDone = (board: CreatedBoard) => {
    setShowModal(false);
    navigate(`/boards/${board.slug}`);
  };

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
        <div style={{ display: "flex", gap: "0.6rem", "align-items": "baseline" }}>
          <a class="btn" href="/profile">
            Profile
          </a>
          <button class="btn btn-solid" onClick={() => setShowModal(true)}>
            Create board
          </button>
        </div>
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
                  <li style={{ "margin-bottom": "0.8rem" }}>
                    <a
                      href={`/boards/${board.slug}`}
                      style={{
                        padding: "1.1rem 1.2rem",
                        background: "var(--color-paper-raised)",
                        border: "1px solid var(--color-ink-faint)",
                        "border-radius": "var(--radius-chamfer)",
                        display: "flex",
                        "justify-content": "space-between",
                        "align-items": "baseline",
                        "text-decoration": "none",
                      }}
                    >
                      <span class="serif" style={{ "font-size": "1.25rem" }}>
                        {board.title}
                      </span>
                      <span class="muted" style={{ "font-size": "0.85rem" }}>
                        {new Date(board.updated_at_ms).toLocaleDateString()}
                      </span>
                    </a>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>

      <Show when={showModal()}>
        <NewBoardModal onClose={() => setShowModal(false)} onCreate={onCreate} onDone={onDone} />
      </Show>
    </main>
  );
};
