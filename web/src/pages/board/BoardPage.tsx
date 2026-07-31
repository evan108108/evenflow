// BoardPage — shell for the three board views. Owns: the store, the dnd
// handle (drop → transition/container-move), the SSE subscription (any
// issue.* event refetches the board; comment.* bumps the sheet's comment
// version), the TideBadge, the view tabs, the + New Issue modal, and the
// butterfly.

import { useLocation, useNavigate, useParams } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import "../../lib/board.css";
import { AuthManager, SseStream, appRuntime, type BoardEvent } from "../../effects";
import { createDnd, parseZone } from "../../lib/dnd";
import { decryptBoardPayload, isEncryptedPayload } from "../../lib/boardKeys";
import { pubkeyOfJwt } from "../../lib/jwt";
import {
  LAYOUT_STORAGE_KEY,
  effectiveKanbanLayout,
  isWideVertical,
  resolveKanbanLayout,
  type KanbanLayout,
} from "../../lib/layout";
import { boardViewOf, issuePath, viewPath } from "../../lib/boardView";
import {
  EMPTY_FILTERS,
  hasActiveFilters,
  matchesFilters,
  type BoardFilters,
} from "../../lib/boardFilters";
import { issuesInColumn } from "../../lib/order";
import { sprintCountdown } from "../../lib/sprints";
import { CONTAINER_OF_MOVE, type ContainerMove, type Issue } from "../../lib/types";
import { Butterfly, NewIssueModal } from "../../components/NewIssueModal";
import { TopBar } from "../../components/TopBar";
import { TideBadge } from "../../components/TideBadge";
import { IssueSheet } from "../../components/IssueSheet";
import { createBoardStore, type NewIssueInput } from "./store";
import { KanbanView } from "./KanbanView";
import { BacklogView } from "./BacklogView";
import { IceboxView } from "./IceboxView";

const LOADING_LINES = ["Finding the rhythm…", "Catching the current…", "Following the thread…"];
const BUTTERFLY_FLIGHT_MS = 1_700;

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
  const [highlightSprintId, setHighlightSprintId] = createSignal<string | null>(null);
  // Phase 21c — sprint chip is now a filter, not a spotlight. Default ON
  // when an active sprint exists (Linear posture: "here's the current
  // sprint's board"). Users toggle off with the chip to see everything.
  const [sprintFilterOff, setSprintFilterOff] = createSignal(false);
  // EFB-44 — board filters, applied as one predicate the views run over
  // already-loaded issues. Deliberately separate from the sprint chip
  // above: that one stays a scalar prop, and unifying the two mechanisms
  // is a follow-up rather than a change to shipped phase-21c behaviour.
  const [filters, setFilters] = createSignal<BoardFilters>(EMPTY_FILTERS);
  const filterPredicate = createMemo(() => {
    const active = filters();
    const viewer = callerPubkey();
    if (!hasActiveFilters(active)) return undefined;
    return (issue: Issue) => matchesFilters(issue, active, viewer);
  });
  // Bumped whenever something that could move the tide lands; TideBadge
  // refetches on the change rather than recomputing client-side.
  const [tideVersion, setTideVersion] = createSignal(0);

  // Kanban layout: explicit preference from localStorage, else the
  // viewport decides (narrow = vertical). Below the force breakpoint the
  // render is vertical no matter what — the preference itself is never
  // rewritten by a viewport change, only by the toggle.
  const storedLayout = (): string | null => {
    try {
      return window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    } catch {
      return null;
    }
  };
  const [layoutPref, setLayoutPref] = createSignal<KanbanLayout>(
    resolveKanbanLayout(storedLayout(), window.innerWidth),
  );
  const [viewportWidth, setViewportWidth] = createSignal(window.innerWidth);
  const kanbanLayout = () => effectiveKanbanLayout(layoutPref(), viewportWidth());
  // Wide + vertical → the Backlog/Icebox rail sits beside the stack. The
  // rail's markup renders either way; this only decides beside vs below.
  const wideRail = () => isWideVertical(kanbanLayout(), viewportWidth());
  const toggleLayout = () => {
    const next: KanbanLayout = layoutPref() === "vertical" ? "columns" : "vertical";
    setLayoutPref(next);
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, next);
    } catch {
      // Preference persistence is best-effort; the session keeps the signal.
    }
  };
  const [flutter, setFlutter] = createSignal<{ x: number; y: number } | null>(null);
  const [commentsVersion, setCommentsVersion] = createSignal(0);
  const [uploadNotice, setUploadNotice] = createSignal<string | null>(null);
  let newIssueButton: HTMLButtonElement | undefined;
  let sseFiber: RuntimeFiber<void, unknown> | undefined;

  const loadingLine = LOADING_LINES[Math.floor(Math.random() * LOADING_LINES.length)];

  const view = () => boardViewOf(location.pathname, base());
  // Opening an issue must not move you off the view you opened it from,
  // so every issue URL we mint carries the current view.
  const openPath = (ref: string) => issuePath(base(), view(), ref);

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
      navigate(openPath(issue.short_id), { replace: true });
    }
  });

  const dnd = createDnd((issueId, zone) => {
    const issue = store.issues().find((i) => i.id === issueId);
    const target = parseZone(zone);
    if (issue === undefined || target === null) return;
    if (target.type === "card") {
      // Dropped onto a card: same column → reorder around it; different
      // column → plain transition (the card just proxies its column).
      if (target.issue === issueId) return;
      const column = store.board()?.columns.find((c) => c.id === target.column);
      if (column === undefined) return;
      const mates = issuesInColumn(
        store.issues().filter((i) => i.container === "active"),
        column,
      );
      if (!mates.some((i) => i.id === issueId)) {
        void store.transition(issue, column);
        return;
      }
      const ordered = mates.filter((i) => i.id !== issueId);
      const idx = ordered.findIndex((i) => i.id === target.issue);
      if (idx === -1) return;
      const insertAt = target.half === "before" ? idx : idx + 1;
      const before = ordered[insertAt - 1] ?? null;
      const after = ordered[insertAt] ?? null;
      void store.reorderIssue(issue, before?.id ?? null, after?.id ?? null);
    } else if (target.type === "transition") {
      // Transition zones carry the column's stable id since phase 17.
      const column = store.board()?.columns.find((c) => c.id === target.column);
      if (column !== undefined) void store.transition(issue, column);
    } else if (target.type === "sprint") {
      void store.addIssueToSprint(issue, target.sprint);
    } else if (target.action in CONTAINER_OF_MOVE) {
      // Dropping a sprint-assigned issue onto Backlog or Icebox reads as
      // "take it out of the sprint" — otherwise the card visually stays put
      // (sprint sections filter by sprint_id, not container, so a container
      // move alone leaves the card inside the sprint). Also fire the
      // container move when the issue wasn't already in that container.
      if (
        (target.action === "promote_to_backlog" || target.action === "send_to_icebox") &&
        (issue.sprint_id ?? null) !== null
      ) {
        void store.removeIssueFromSprint(issue);
        if (issue.container !== CONTAINER_OF_MOVE[target.action as ContainerMove]) {
          void store.moveContainer(issue, target.action as ContainerMove);
        }
        return;
      }
      void store.moveContainer(issue, target.action as ContainerMove);
    }
  });

  const handleSse = (event: BoardEvent) => {
    // Private boards ship {enc, epoch, ciphertext} payloads. Decrypt with
    // the granted epoch key (fetching/regranting on first touch or after a
    // rotation); the refetch-driven UI below never needs the plaintext, so
    // an undecryptable event (we were rotated out) degrades to refetch —
    // where REST authz gives the authoritative answer.
    if (isEncryptedPayload(event.payload)) {
      void decryptBoardPayload(apiBase, event.board_id, event.payload);
    }
    if (event.kind.startsWith("issue.")) {
      // Echo suppression: if this issue.* event is the round-trip of a
      // mutation we JUST made, our local state is already right. A full
      // refetchIssues() would wipe every stream and re-prime — visible flash
      // right after every drag. Other users' changes still refetch.
      if (event.issue_id !== undefined && store.isLocalMutation(event.issue_id)) return;
      void store.refetchIssues();
      void store.refetchSprints();
      // Any issue movement can move the tide (ship, re-open, re-estimate,
      // scope change), and the reading is computed server-side from audit
      // rows — so the badge refetches rather than trying to derive it here.
      setTideVersion((v) => v + 1);
    } else if (event.kind.startsWith("comment.")) {
      setCommentsVersion((v) => v + 1);
    } else if (event.kind.startsWith("sprint.tide.")) {
      setTideVersion((v) => v + 1);
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

  const onResize = () => setViewportWidth(window.innerWidth);
  onMount(() => window.addEventListener("resize", onResize));

  onCleanup(() => {
    window.removeEventListener("resize", onResize);
    if (sseFiber !== undefined) appRuntime.runFork(Fiber.interrupt(sseFiber));
  });

  // The badge tracks the most recently started active sprint. NOTE: this is
  // null (not undefined) when the board has no active sprint — compare
  // against null, never undefined.
  const activeSprint = createMemo(() => {
    const started = store
      .sprints()
      .filter((s) => s.status === "active")
      .sort((a, b) => (b.started_at_ms ?? 0) - (a.started_at_ms ?? 0));
    return started[0] ?? null;
  });
  /** Sprint the tide should read, or null for the board's kanban-only tide. */
  const tideSprint = createMemo(() => (sprintFilterOff() ? null : activeSprint()));
  const countdownFor = (sprint: { planned_days?: number | null; started_at_ms: number | null }) =>
    sprintCountdown(sprint, store.board()?.default_sprint_days, Date.now());

  const createIssue = async (input: NewIssueInput, files: ReadonlyArray<File>) => {
    const issue = await store.createIssue(input);
    setShowNewIssue(false);
    const rect = newIssueButton?.getBoundingClientRect();
    if (rect !== undefined) {
      setFlutter({ x: rect.left + rect.width / 2, y: rect.top });
      setTimeout(() => setFlutter(null), BUTTERFLY_FLIGHT_MS);
    }
    // Buffered create-time attachments upload once the issue exists to own
    // them. The issue is already created — failures surface as a notice
    // rather than failing the create.
    if (files.length > 0) {
      const failures: string[] = [];
      for (const file of files) {
        const { rejection } = await store.uploadAttachment(issue.id, file);
        if (rejection !== null) failures.push(`${file.name}: ${rejection.message}`);
      }
      setUploadNotice(failures.length === 0 ? null : failures.join(" · "));
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
              <TopBar
                crumbs={[
                  { label: "Boards", href: "/boards" },
                  ...(orgHandle() !== null
                    ? [
                        { label: `@${orgHandle()}`, href: `/@${orgHandle()}` },
                        { label: board().title },
                      ]
                    : [{ label: board().title }]),
                ]}
              />
              <header class="board-header">
                <h1>{board().title}</h1>
                <Show when={board().issue_prefix}>
                  {(prefix) => <span class="prefix-chip">{prefix()}</span>}
                </Show>
                <div class="spacer" />
                <a class="btn" href={`${base()}/sprints`} title="Sprint history">
                  Sprints
                </a>
                <Show when={orgHandle()}>
                  <a class="btn" href={`${base()}/settings`} title="Board settings">
                    Settings
                  </a>
                </Show>
                <button ref={newIssueButton} class="btn btn-solid" onClick={() => setShowNewIssue(true)}>
                  + New issue
                </button>
              </header>

              <div class="tabs-row">
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
                <Show when={activeSprint()}>
                  {(sprint) => {
                    const countdown = () => countdownFor(sprint());
                    const filterOn = () => !sprintFilterOff();
                    return (
                      <button
                        class="sprint-badge"
                        classList={{
                          on: filterOn(),
                          overdue: countdown()?.overdue === true,
                        }}
                        title={
                          filterOn()
                            ? "Showing only this sprint's cards. Click to show all."
                            : "Showing all active cards. Click to filter to this sprint."
                        }
                        onClick={() => setSprintFilterOff((v) => !v)}
                      >
                        {sprint().name}
                        <Show when={countdown()}>
                          {(c) => <>{" · "}{c().overdue ? "overdue" : `${c().daysLeft}d remaining`}</>}
                        </Show>
                      </button>
                    );
                  }}
                </Show>
                <Show when={activeSprint()}>
                  {(sprint) => (
                    <button
                      class="btn btn-small btn-quiet"
                      title="Complete sprint — unfinished issues carry to the next planning sprint (or drop if none)"
                      onClick={() => {
                        if (window.confirm(`Complete "${sprint().name}"? Unfinished issues carry to the next planning sprint (or return to Backlog if none exists).`)) {
                          void store.completeSprint(sprint().id);
                        }
                      }}
                    >
                      Complete sprint
                    </button>
                  )}
                </Show>
                <div class="spacer" />
                <Show when={view() === "kanban"}>
                  <button
                    class="layout-toggle"
                    title={kanbanLayout() === "vertical" ? "Column view" : "Vertical view"}
                    aria-label={
                      kanbanLayout() === "vertical" ? "Switch to column view" : "Switch to vertical view"
                    }
                    onClick={toggleLayout}
                  >
                    <Show
                      when={kanbanLayout() === "vertical"}
                      fallback={
                        // Rows glyph — the vertical view this click switches to.
                        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                          <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                            <rect x="2" y="2.5" width="12" height="2.6" rx="1" />
                            <rect x="2" y="6.7" width="12" height="2.6" rx="1" />
                            <rect x="2" y="10.9" width="12" height="2.6" rx="1" />
                          </g>
                        </svg>
                      }
                    >
                      {/* Columns glyph — the column view this click switches to. */}
                      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                        <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                          <rect x="2.5" y="2" width="2.6" height="12" rx="1" />
                          <rect x="6.7" y="2" width="2.6" height="12" rx="1" />
                          <rect x="10.9" y="2" width="2.6" height="12" rx="1" />
                        </g>
                      </svg>
                    </Show>
                  </button>
                </Show>
                <TideBadge
                  apiBase={apiBase}
                  sprintId={tideSprint()?.id ?? null}
                  sprintName={tideSprint()?.name ?? null}
                  refreshKey={tideVersion()}
                />
              </div>

              {/* EFB-44 filter chips. Hidden entirely when signed out — the
                  only filter so far is viewer-relative, so there is nothing
                  to offer an anonymous reader. */}
              <Show when={callerPubkey() !== null}>
                <div class="filter-chips">
                  <button
                    class="filter-chip"
                    classList={{ on: filters().mineOnly }}
                    aria-pressed={filters().mineOnly}
                    title={
                      filters().mineOnly
                        ? "Showing only issues assigned to you. Click to show everyone's."
                        : "Showing everyone's issues. Click to show only yours."
                    }
                    onClick={() => setFilters((f) => ({ ...f, mineOnly: !f.mineOnly }))}
                  >
                    Show my tickets
                  </button>
                </div>
              </Show>

              <Show when={store.lastError()}>
                <p class="muted" role="alert">
                  The current pushed back: {store.lastError()}
                </p>
              </Show>
              <Show when={uploadNotice()}>
                <p class="muted" role="alert">
                  Some attachments didn't make it: {uploadNotice()}
                </p>
              </Show>

              <Show when={view() === "kanban"}>
                <KanbanView
                  store={store}
                  dnd={dnd}
                  onOpen={(id) => navigate(openPath(id))}
                  highlightSprintId={highlightSprintId()}
                  filterSprintId={
                    activeSprint() !== undefined && !sprintFilterOff() ? activeSprint()!.id : null
                  }
                  doneWindowMs={
                    ((store.board()?.done_window_days ?? 14) * 86_400_000)
                  }
                  layout={kanbanLayout()}
                  wideRail={wideRail()}
                  matchesFilters={filterPredicate()}
                />
              </Show>
              <Show when={view() === "backlog"}>
                <BacklogView
                  store={store}
                  dnd={dnd}
                  onOpen={(id) => navigate(openPath(id))}
                  matchesFilters={filterPredicate()}
                />
              </Show>
              <Show when={view() === "icebox"}>
                <IceboxView store={store} dnd={dnd} onOpen={(id) => navigate(openPath(id))} />
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
                    onClose={() => navigate(viewPath(base(), view()))}
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
