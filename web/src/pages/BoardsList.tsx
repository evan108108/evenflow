// /boards — the aggregate: every board the caller can see, grouped by org
// (personal org first, then teams alphabetically). Board links go to the
// canonical /@{handle}/{slug} URLs; "Create board" still posts the legacy
// endpoint, which lands the board in the personal org.

import { useNavigate } from "@solidjs/router";
import { For, Show, createResource, createSignal, onMount } from "solid-js";
import { Effect } from "effect";
import { ApiClient, AuthManager, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { NewBoardModal, type CreatedBoard, type NewBoardInput } from "../components/NewBoardModal";
import { TopBar } from "../components/TopBar";
import { bootstrap, type BootstrapMe, type OrgSummary } from "../lib/orgStore";

interface BoardRow {
  id: string;
  slug: string;
  title: string;
  visibility?: "private" | "public";
  issue_prefix: string | null;
  updated_at_ms: number;
}

interface OrgGroup {
  org: OrgSummary;
  boards: BoardRow[];
}

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

/** Personal org first, then teams alphabetically by slug. */
const orderOrgs = (orgs: ReadonlyArray<OrgSummary>): OrgSummary[] =>
  [...orgs].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "personal" ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });

const fetchGroups = async (me: BootstrapMe | null): Promise<OrgGroup[]> => {
  if (me === null) return [];
  const ordered = orderOrgs(me.orgs);
  const groups = await Promise.all(
    ordered.map(async (org) => {
      try {
        const res = await api<{ boards: BoardRow[] }>((c) =>
          c.get(`/api/v0/orgs/${encodeURIComponent(org.slug)}/boards`),
        );
        return { org, boards: res.boards };
      } catch {
        return { org, boards: [] as BoardRow[] };
      }
    }),
  );
  return groups;
};

const createBoard = (input: NewBoardInput): Promise<{ board: BoardRow }> =>
  api((c) => c.post<{ board: BoardRow }>("/api/v0/boards", input));

export const BoardsList = () => {
  const navigate = useNavigate();
  const [showModal, setShowModal] = createSignal(false);
  const [me, setMe] = createSignal<BootstrapMe | null | undefined>(undefined);

  onMount(() => {
    void appRuntime
      .runPromise(Effect.flatMap(AuthManager, (a) => a.get()))
      .then(async (jwt) => {
        if (jwt === null) {
          navigate("/", { replace: true });
          return;
        }
        setMe(await bootstrap());
      });
  });

  const [groups, { refetch }] = createResource(
    () => me(),
    (resolved) => fetchGroups(resolved ?? null),
  );

  const onCreate = async (input: NewBoardInput): Promise<CreatedBoard> => {
    const { board } = await createBoard(input);
    void refetch();
    return board;
  };

  const onDone = (board: CreatedBoard) => {
    setShowModal(false);
    const handle = me()?.handle;
    navigate(handle !== undefined ? `/@${handle}/${board.slug}` : `/boards/${board.slug}`);
  };

  const totalBoards = () => (groups() ?? []).reduce((n, g) => n + g.boards.length, 0);

  return (
    <main style={{ "max-width": "var(--measure)", margin: "0 auto", padding: "2.5rem 1.5rem 4rem var(--page-inset-left, 3rem)" }}>
      <TopBar crumbs={[{ label: "Boards" }]} />
      <header
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          "margin": "1.6rem 0 2.5rem",
        }}
      >
        <h1 style={{ "font-size": "2.6rem" }}>Boards</h1>
        <button class="btn btn-solid" onClick={() => setShowModal(true)}>
          Create board
        </button>
      </header>

      <Show
        when={me() !== undefined && !groups.loading}
        fallback={<p class="muted">Finding the rhythm…</p>}
      >
        <Show
          when={totalBoards() > 0}
          fallback={<p class="muted">Still waters. What flows next?</p>}
        >
          <For each={groups()}>
            {(group) => (
              <Show when={group.boards.length > 0}>
                <section style={{ "margin-bottom": "2.2rem" }}>
                  <h2
                    class="serif"
                    style={{ "font-size": "1.15rem", "margin-bottom": "0.8rem" }}
                  >
                    <a href={`/@${group.org.slug}`} style={{ "text-decoration": "none" }}>
                      @{group.org.slug}
                    </a>
                    <Show when={group.org.kind === "team"}>
                      <span class="chip role-chip" style={{ "margin-left": "0.6rem" }}>
                        {group.org.role}
                      </span>
                    </Show>
                  </h2>
                  <ul style={{ "list-style": "none", margin: 0, padding: 0 }}>
                    <For each={group.boards}>
                      {(board) => (
                        <li style={{ "margin-bottom": "0.8rem" }}>
                          <a class="board-card" href={`/@${group.org.slug}/${board.slug}`}>
                            <span class="serif" style={{ "font-size": "1.25rem" }}>
                              {board.title}
                            </span>
                            <span class="muted" style={{ "font-size": "0.85rem" }}>
                              <Show when={board.visibility === "public"}>
                                <span class="chip" style={{ "margin-right": "0.6rem" }}>
                                  public
                                </span>
                              </Show>
                              {new Date(board.updated_at_ms).toLocaleDateString()}
                            </span>
                          </a>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>
            )}
          </For>
        </Show>
      </Show>

      <Show when={showModal()}>
        <NewBoardModal onClose={() => setShowModal(false)} onCreate={onCreate} onDone={onDone} />
      </Show>
    </main>
  );
};
