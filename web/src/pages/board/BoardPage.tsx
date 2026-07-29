// BoardPage — shell for the three board views. Owns: the store, the dnd
// handle (drop → transition/container-move), the SSE subscription (any
// issue.* event refetches the board; comment.* bumps the sheet's comment
// version), "The Current" sparkline, the view tabs, the + New Issue modal,
// and the butterfly.

import { useLocation, useNavigate, useParams } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import "../../lib/board.css";
import { AuthManager, SseStream, appRuntime, type BoardEvent } from "../../effects";
import { createDnd, parseZone } from "../../lib/dnd";
import { pubkeyOfJwt } from "../../lib/jwt";
import { CONTAINER_OF_MOVE, type ContainerMove } from "../../lib/types";
import { Butterfly, NewIssueModal } from "../../components/NewIssueModal";
import { OrgSwitcher } from "../../components/OrgSwitcher";
import { UserNav } from "../../components/UserNav";
import { IssueSheet } from "../../components/IssueSheet";
import { createBoardStore, type NewIssueInput } from "./store";
import { KanbanView } from "./KanbanView";
import { BacklogView } from "./BacklogView";
import { IceboxView } from "./IceboxView";

const LOADING_LINES = ["Finding the rhythm…", "Catching the current…", "Following the thread…"];
const DAY_MS = 86_400_000;
const BUTTERFLY_FLIGHT_MS = 1_700;

/** Trailing-7d daily buckets of estimate points completed while active. */
const velocityBuckets = (
  feed: ReadonlyArray<{ to: string | null; container_at_completion: string | null; occurred_at_ms: number; issue_id: string }>,
  estimateOf: (issueId: string) => number,
  now: number,
): number[] => {
  const start = now - 7 * DAY_MS;
  const buckets = [0, 0, 0, 0, 0, 0, 0];
  for (const item of feed) {
    if (item.to !== "Done" || item.container_at_completion !== "active") continue;
    if (item.occurred_at_ms < start) continue;
    const day = Math.min(6, Math.floor((item.occurred_at_ms - start) / DAY_MS));
    buckets[day] = (buckets[day] ?? 0) + estimateOf(item.issue_id);
  }
  return buckets;
};

const Sparkline = (props: { buckets: number[] }) => {
  const points = () => {
    const max = Math.max(1, ...props.buckets);
    return props.buckets
      .map((v, i) => `${(i * 84) / 6 + 3},${21 - (v / max) * 16}`)
      .join(" ");
  };
  return (
    <svg width="90" height="24" viewBox="0 0 90 24" aria-label="velocity, trailing 7 days">
      <polyline
        points={points()}
        fill="none"
        stroke="var(--color-ink)"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        opacity="0.75"
      />
    </svg>
  );
};

export const BoardPage = () => {
  // Two addressing modes: canonical /@{handle}/{board_slug} (org-scoped API)
  // and legacy /boards/{slug} (compat alias; LegacyBoardRedirect usually
  // bounces before this renders).
  const params = useParams<{ slug?: string; handle?: string; board_slug?: string; issueRef?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const orgHandle = () => params.handle?.replace(/^@/, "") ?? null;
  const boardSlug = params.board_slug ?? params.slug ?? "";
  const apiBase =
    params.handle !== undefined && params.board_slug !== undefined
      ? `/api/v0/orgs/${encodeURIComponent(params.handle.replace(/^@/, ""))}/boards/${encodeURIComponent(params.board_slug)}`
      : `/api/v0/boards/${encodeURIComponent(boardSlug)}`;
  const store = createBoardStore(boardSlug, undefined, apiBase);
  const base = () =>
    orgHandle() !== null ? `/@${orgHandle()}/${boardSlug}` : `/boards/${boardSlug}`;

  const [callerPubkey, setCallerPubkey] = createSignal<string | null>(null);
  const [showNewIssue, setShowNewIssue] = createSignal(false);
  const [flutter, setFlutter] = createSignal<{ x: number; y: number } | null>(null);
  const [commentsVersion, setCommentsVersion] = createSignal(0);
  let newIssueButton: HTMLButtonElement | undefined;
  let sseFiber: RuntimeFiber<void, unknown> | undefined;

  const loadingLine = LOADING_LINES[Math.floor(Math.random() * LOADING_LINES.length)];

  const view = () => {
    if (location.pathname.endsWith("/backlog")) return "backlog";
    if (location.pathname.endsWith("/icebox")) return "icebox";
    return "kanban";
  };

  // The deep-link segment is a short id (FLOW-42, preferred) or a UUID
  // (pre-migration bookmarks, SSE payloads).
  const openIssue = createMemo(() => {
    const ref = params.issueRef;
    if (ref === undefined) return null;
    const upper = ref.toUpperCase();
    return store.issues().find((i) => i.short_id === upper || i.id === ref) ?? null;
  });

  // Canonicalize UUID (or lowercase) URLs to the short-id form in place.
  createEffect(() => {
    const issue = openIssue();
    if (issue?.short_id != null && params.issueRef !== issue.short_id) {
      navigate(`${base()}/issues/${issue.short_id}`, { replace: true });
    }
  });

  const dnd = createDnd((issueId, zone) => {
    const issue = store.issues().find((i) => i.id === issueId);
    const target = parseZone(zone);
    if (issue === undefined || target === null) return;
    if (target.type === "transition") void store.transition(issue, target.column);
    else if (target.action in CONTAINER_OF_MOVE) {
      void store.moveContainer(issue, target.action as ContainerMove);
    }
  });

  const handleSse = (event: BoardEvent) => {
    if (event.kind.startsWith("issue.")) {
      void store.refetchIssues();
      void store.refetchStatusFeed();
    } else if (event.kind.startsWith("comment.")) {
      setCommentsVersion((v) => v + 1);
    }
  };

  onMount(() => {
    void appRuntime
      .runPromise(Effect.flatMap(AuthManager, (a) => a.get()))
      .then((jwt) => {
        if (jwt === null) {
          navigate("/", { replace: true });
          return;
        }
        setCallerPubkey(pubkeyOfJwt(jwt));
        void store.load();
        void store.refetchStatusFeed();
        sseFiber = appRuntime.runFork(
          Effect.flatMap(SseStream, (sse) =>
            Stream.runForEach(
              sse.subscribe(`${apiBase}/stream`),
              (event) => Effect.sync(() => handleSse(event)),
            ),
          ),
        );
      });
  });

  onCleanup(() => {
    if (sseFiber !== undefined) appRuntime.runFork(Fiber.interrupt(sseFiber));
  });

  const buckets = createMemo(() => {
    const estimates = new Map(store.issues().map((i) => [i.id, i.estimate ?? 0]));
    return velocityBuckets(store.statusFeed(), (id) => estimates.get(id) ?? 0, Date.now());
  });
  const velocityTotal = () => buckets().reduce((a, b) => a + b, 0);

  const createIssue = async (input: NewIssueInput) => {
    await store.createIssue(input);
    setShowNewIssue(false);
    const rect = newIssueButton?.getBoundingClientRect();
    if (rect !== undefined) {
      setFlutter({ x: rect.left + rect.width / 2, y: rect.top });
      setTimeout(() => setFlutter(null), BUTTERFLY_FLIGHT_MS);
    }
  };

  return (
    <main class="board-page">
      <Show when={!store.loading()} fallback={<p class="empty-state">{loadingLine}</p>}>
        <Show
          when={store.board()}
          fallback={
            <p class="empty-state">
              This board is drifting. <a href="/boards">Back to your boards →</a>
            </p>
          }
        >
          {(board) => (
            <>
              <nav class="crumb muted">
                <a href="/boards">← Boards</a>
                <Show when={orgHandle()}>
                  {(handle) => (
                    <>
                      {" / "}
                      <a href={`/@${handle()}`}>@{handle()}</a>
                      {" / "}
                      <a href={base()}>{board().title}</a>
                    </>
                  )}
                </Show>
              </nav>
              <header class="board-header">
                <Show when={orgHandle()}>
                  <OrgSwitcher current={orgHandle() ?? undefined} />
                </Show>
                <h1>{board().title}</h1>
                <Show when={board().issue_prefix}>
                  {(prefix) => <span class="prefix-chip">{prefix()}</span>}
                </Show>
                <div class="current" title="Estimate points completed from Active, trailing 7 days">
                  <span class="label">The Current</span>
                  <Sparkline buckets={buckets()} />
                  <span class="figure">{velocityTotal()}</span>
                </div>
                <div class="spacer" />
                <Show when={orgHandle()}>
                  <a class="btn" href={`${base()}/settings`} title="Board settings">
                    Settings
                  </a>
                </Show>
                <button ref={newIssueButton} class="btn btn-solid" onClick={() => setShowNewIssue(true)}>
                  + New issue
                </button>
                <UserNav />
              </header>

              <nav class="view-tabs">
                <a href={base()} classList={{ active: view() === "kanban" }}>
                  Kanban
                </a>
                <a href={`${base()}/backlog`} classList={{ active: view() === "backlog" }}>
                  Backlog
                </a>
                <a href={`${base()}/icebox`} classList={{ active: view() === "icebox" }}>
                  Icebox
                </a>
              </nav>

              <Show when={store.lastError()}>
                <p class="muted" role="alert">
                  The current pushed back: {store.lastError()}
                </p>
              </Show>

              <Show when={view() === "kanban"}>
                <KanbanView store={store} dnd={dnd} onOpen={(id) => navigate(`${base()}/issues/${id}`)} />
              </Show>
              <Show when={view() === "backlog"}>
                <BacklogView store={store} dnd={dnd} onOpen={(id) => navigate(`${base()}/issues/${id}`)} />
              </Show>
              <Show when={view() === "icebox"}>
                <IceboxView store={store} dnd={dnd} onOpen={(id) => navigate(`${base()}/issues/${id}`)} />
              </Show>

              <Show when={dnd.draggingId()}>
                {(id) => (
                  <div class="drag-ghost" style={{ left: `${dnd.pos().x}px`, top: `${dnd.pos().y}px` }}>
                    {store.issues().find((i) => i.id === id())?.title ?? ""}
                  </div>
                )}
              </Show>

              <Show when={openIssue()}>
                {(issue) => (
                  <IssueSheet
                    issue={issue()}
                    board={board()}
                    store={store}
                    callerPubkey={callerPubkey()}
                    commentsVersion={commentsVersion}
                    onClose={() => navigate(base())}
                  />
                )}
              </Show>

              <Show when={showNewIssue()}>
                <NewIssueModal board={board()} onClose={() => setShowNewIssue(false)} onCreate={createIssue} />
              </Show>

              <Show when={flutter()}>{(at) => <Butterfly x={at().x} y={at().y} />}</Show>
            </>
          )}
        </Show>
      </Show>
    </main>
  );
};

export { velocityBuckets };
