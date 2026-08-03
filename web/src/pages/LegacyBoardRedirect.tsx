// /boards/{slug}[/…] — legacy URLs bounce to the canonical
// /@{handle}/{board_slug} form. Resolution: probe each org the caller
// belongs to (bootstrap list, personal first) for a board with this slug;
// first hit wins. If nothing resolves (signed out on a private link,
// pre-backfill data), fall back to rendering the legacy board in place so
// old links never dead-end.

import { useLocation, useParams } from "@solidjs/router";
import { url } from "@routes-manifest";
import { Show, createSignal, onMount } from "solid-js";
import { Effect } from "effect";
import { ApiClient, appRuntime, type ApiClientService, type ApiError } from "../effects";
import { bootstrap } from "../lib/orgStore";
import { BoardPage } from "./board/BoardPage";

const api = <T,>(f: (c: ApiClientService) => Effect.Effect<T, ApiError>): Promise<T> =>
  appRuntime.runPromise(Effect.flatMap(ApiClient, f));

export const LegacyBoardRedirect = () => {
  const params = useParams<{ slug: string }>();
  const location = useLocation();
  const [fallthrough, setFallthrough] = createSignal(false);

  onMount(() => {
    void (async () => {
      const me = await bootstrap();
      if (me === null) {
        setFallthrough(true);
        return;
      }
      for (const org of me.orgs) {
        try {
          await api((c) =>
            c.get(
              url("board.get", { slug: params.slug }, org.slug),
            ),
          );
          // Preserve the sub-path (backlog/icebox/issues/…) across the bounce.
          const suffix = location.pathname.replace(`/boards/${params.slug}`, "");
          window.location.replace(`/@${org.slug}/${params.slug}${suffix}`);
          return;
        } catch {
          // not in this org — keep probing
        }
      }
      setFallthrough(true);
    })();
  });

  return (
    <Show
      when={fallthrough()}
      fallback={
        <main style={{ display: "grid", "place-items": "center", "min-height": "100vh" }}>
          <p class="muted">Catching the current…</p>
        </main>
      }
    >
      <BoardPage />
    </Show>
  );
};
