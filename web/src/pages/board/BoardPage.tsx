// BoardPage — shell for the three board views. Owns: the store, the dnd
// handle (drop → transition/container-move), the SSE subscription (any
// issue.* event refetches the board; comment.* bumps the sheet's comment
// version), the TideBadge, the view tabs, the + New Issue modal, and the
// butterfly.

import { useLocation, useNavigate, useParams } from "@solidjs/router";
import { url } from "@routes-manifest";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import "../../lib/board.css";
import { AuthManager, SseStream, appRuntime, type BoardEvent } from "../../effects";
import { createDnd, parseZone } from "../../lib/dnd";
import { shouldRedirectAnonymous } from "../../lib/boardAccess";
import { decryptBoardPayload, isEncryptedPayload } from "../../lib/boardKeys";
import { pubkeyOfJwt } from "../../lib/jwt";
import {
  LAYOUT_STORAGE_KEY,
  effectiveKanbanLayout,
  isWideVertical,
  layoutViewportWidth,
  resolveKanbanLayout,
  type KanbanLayout,
} from "../../lib/layout";
import { boardViewOf, issuePath, viewPath } from "../../lib/boardView";
import {
  EMPTY_FILTERS,
  UNASSIGNED,
  predicateFor,
  type BoardFilters,
} from "../../lib/boardFilters";
import { effectiveDoneWindowMs } from "../../lib/doneWindow";
import { readFilters, writeFilters } from "../../lib/filterPersistence";
import { readDoneWindowLifted, writeDoneWindowLifted } from "../../lib/doneWindowPersistence";
import { authorLabel, profileFor, requestProfile } from "../../lib/profileStore";
import { FilterPicker, type FilterOption } from "../../components/FilterPicker";
import { issuesInColumn } from "../../lib/order";
import { activeSprintFilterId, sprintCountdown } from "../../lib/sprints";
import { CONTAINER_OF_MOVE, type ContainerMove, type Issue } from "../../lib/types";
import { Butterfly, NewIssueModal } from "../../components/NewIssueModal";
import { TopBar } from "../../components/TopBar";
import { BoardSearch } from "../../components/BoardSearch";
import { TideBadge } from "../../components/TideBadge";
import { IssueSheet } from "../../components/IssueSheet";
import { startBoardPoll } from "../../lib/boardPoll";
import { createBoardStore, type NewIssueInput } from "./store";
import { MobileBoardHeader } from "./MobileBoardHeader";
import { KanbanView } from "./KanbanView";
import { BacklogView } from "./BacklogView";
import { IceboxView } from "./IceboxView";

const LOADING_LINES = ["Finding the rhythm…", "Catching the current…", "Following the thread…"];
const BUTTERFLY_FLIGHT_MS = 1_700;
const DAY_MS = 86_400_000;
/** Mirrors the `done_window_days` column default (migration 0018) for boards
 *  cached before it landed, and matches the server-side tide fallback. */
const FALLBACK_DONE_WINDOW_DAYS = 14;

export const BoardPage = () => {
  // Two addressing modes: canonical /@{handle}/{board_slug} (org-scoped API)
  // and legacy /boards/{slug} (compat alias; LegacyBoardRedirect usually
  // bounces before this renders).
  const params = useParams<{ slug?: string; handle?: string; board_slug?: string; issueRef?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const orgHandle = () => params.handle?.replace(/^@/, "") ?? null;
  const boardSlug = params.board_slug ?? params.slug ?? "";
  // EFB-98: the store builds its own URLs from the manifest now; it needs the
  // org handle, not a prefix. url() percent-encodes its parameters, so the
  // hand-rolled encodeURIComponent that used to wrap these is gone — keeping it
  // would double-encode.
  const orgParam = params.handle === undefined ? undefined : params.handle.replace(/^@/, "");
  const store = createBoardStore(boardSlug, undefined, orgParam);
  const apiBase = store.apiBase;
  const base = () =>
    orgHandle() !== null ? `/@${orgHandle()}/${boardSlug}` : `/boards/${boardSlug}`;

  const [callerPubkey, setCallerPubkey] = createSignal<string | null>(null);
  /**
   * Read-only posture for the whole board (EFB-47). A signed-out visitor may
   * reach a PUBLIC board and must be able to read all of it while reaching
   * none of the mutations. Every mutation affordance below gates on this one
   * derived value rather than re-deriving `callerPubkey() === null` at each
   * site, so "what does a viewer see" is answerable by grepping one name.
   * Mirrors IssueSheet's existing `readOnly = () => props.callerPubkey === null`,
   * which already gates that surface in seven places.
   */
  const boardReadOnly = () => callerPubkey() === null;
  const [showNewIssue, setShowNewIssue] = createSignal(false);
  const [highlightSprintId, setHighlightSprintId] = createSignal<string | null>(null);
  // Phase 21c — sprint chip is now a filter, not a spotlight. Default ON
  // when an active sprint exists (Linear posture: "here's the current
  // sprint's board"). Users toggle off with the chip to see everything.
  const [sprintFilterOff, setSprintFilterOff] = createSignal(false);
  // EFB-44 — board filters, applied as a predicate the views run over
  // already-loaded issues. EFB-45 folded the phase-21c sprint filter in here
  // too, so there is one filter shape rather than a shape plus a scalar prop.
  // Holds the PERSISTED dimensions only. The sprint dimension is merged in
  // downstream by `effectiveFilters` rather than stored here, which is what
  // keeps it out of localStorage structurally instead of by remembering to
  // strip it on every write.
  const [filters, setFilters] = createSignal<BoardFilters>(EMPTY_FILTERS);
  // Persist on mutation rather than in an effect over `filters`: an effect
  // would also fire when the STORAGE KEY changes (sign-in/out), writing the
  // outgoing viewer's filters into the incoming viewer's slot before the
  // restore below could run.
  const applyFilters = (next: (f: BoardFilters) => BoardFilters) =>
    setFilters((f) => {
      const updated = next(f);
      const boardId = store.board()?.id;
      if (boardId !== undefined) writeFilters(boardId, callerPubkey(), updated);
      return updated;
    });
  // Restore whenever the board or the viewer resolves or changes. Identity
  // is part of the key, so signing in or out swaps to that scope's filters
  // rather than carrying the previous viewer's over.
  createEffect(() => {
    const boardId = store.board()?.id;
    const viewer = callerPubkey();
    setFilters(boardId === undefined ? EMPTY_FILTERS : readFilters(boardId, viewer));
  });
  // EFB-31 — the Done column is windowed to the board's `done_window_days` in
  // kanban-mode (KanbanView.inColumn), which is what keeps it from growing
  // unbounded. This lifts that window for the current viewer. Its own storage
  // key rather than a BoardFilters member: it widens where filters narrow, and
  // filterPersistence would delete a lift-only state as "empty". See
  // lib/doneWindowPersistence.ts.
  const [doneWindowLifted, setDoneWindowLifted] = createSignal(false);
  // Persist on mutation, not via an effect over the signal — same reasoning as
  // applyFilters: an effect would also fire when the key changes on sign-in/out
  // and write the outgoing viewer's state into the incoming viewer's slot.
  const toggleDoneWindow = () =>
    setDoneWindowLifted((lifted) => {
      const next = !lifted;
      const boardId = store.board()?.id;
      if (boardId !== undefined) writeDoneWindowLifted(boardId, callerPubkey(), next);
      return next;
    });
  createEffect(() => {
    const boardId = store.board()?.id;
    const viewer = callerPubkey();
    setDoneWindowLifted(boardId === undefined ? false : readDoneWindowLifted(boardId, viewer));
  });
  const toggleIn = (key: "assignees" | "labels") => (value: string) =>
    applyFilters((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value],
    }));
  const clearIn = (key: "assignees" | "labels") => () =>
    applyFilters((f) => ({ ...f, [key]: [] }));
  // Assignee options come from the members list, unioned with anyone actually
  // holding a card. Two reasons for the union: /members needs contributor
  // scope, so a plain viewer's list comes back empty, and a former member can
  // still own an issue — the same fallback IssueSheet does for a single
  // assignee, widened to the whole picker.
  const assigneeOptions = createMemo<FilterOption[]>(() => {
    const seen = new Set<string>();
    for (const m of store.members()) seen.add(m.pubkey);
    for (const i of store.issues()) if (i.assignee_pubkey !== null) seen.add(i.assignee_pubkey);
    for (const pubkey of seen) requestProfile(pubkey);
    const named = [...seen]
      .map((pubkey) => ({ value: pubkey, label: authorLabel(profileFor(pubkey), pubkey, null) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    // Unassigned is a real option, not the empty state — it sits first so it
    // doesn't get lost at the bottom of a long roster.
    return [{ value: UNASSIGNED, label: "Unassigned" }, ...named];
  });
  // Labels come from the loaded issues, NOT board.labels: that field is typed
  // ReadonlyArray<unknown> and has no other reader in the app. Deriving from
  // issues keeps every option typed and guarantees it matches at least one
  // card, so the picker can't offer a choice that filters to nothing.
  const labelOptions = createMemo<FilterOption[]>(() =>
    [...new Set(store.issues().flatMap((i) => i.labels))]
      .sort((a, b) => a.localeCompare(b))
      .map((label) => ({ value: label, label })),
  );
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
    resolveKanbanLayout(storedLayout(), layoutViewportWidth()),
  );
  const [viewportWidth, setViewportWidth] = createSignal(layoutViewportWidth());
  const kanbanLayout = () => effectiveKanbanLayout(layoutPref(), viewportWidth());
  // EFB-67 v2: the header no longer reads this signal. `window.innerWidth` is
  // not the layout viewport once the document overflows horizontally — it was
  // 792 on a 393px phone — so the header is chosen by a CSS media query
  // instead.
  //
  // EFB-77 is the follow-up ticket v2 called for: the three kanban-layout
  // reads here now go through layoutViewportWidth() rather than
  // window.innerWidth. v2 left them because their live behaviour was correct;
  // that was true and is not a reason to keep them. They decide whether the
  // board renders columns — i.e. whether the page overflows — off a number
  // that only lies once it does, so the first layout change that widens the
  // kanban makes them pick the wrong branch. Fixed while it is a no-op.
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
    // Drag is the one mutation with no button to hide, so it is stopped here
    // at the single drop handler every view shares — gating the three views
    // individually would leave a bypass the next view to be added inherits
    // (EFB-47). Cards still lift and follow the pointer for a signed-out
    // visitor; only the write is refused.
    if (boardReadOnly()) return;
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
      .then(async (jwt) => {
        setCallerPubkey(jwt === null ? null : pubkeyOfJwt(jwt));

        // Load BEFORE deciding whether to bounce: visibility is not knowable
        // until the board resolves. This ordering is load-bearing — the
        // previous shape returned early on a null JWT and so never called
        // store.load() at all, which is why a signed-out visitor could not
        // have rendered a public board even with the redirect removed.
        await store.load();

        // Rule and rationale live in shouldRedirectAnonymous, which is unit
        // tested — this branch is otherwise unreachable without a router,
        // the Effect runtime and an AuthManager, which is how it went
        // unverified long enough to ship the bug EFB-47 fixes.
        if (shouldRedirectAnonymous(jwt, store.board())) {
          navigate("/", { replace: true });
          return;
        }

        // Anonymous subscribers are allowed on a public board (the stream
        // route resolves at "viewer" scope), so read-only visitors get live
        // updates like everyone else rather than a silently frozen board.
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

  const onResize = () => setViewportWidth(layoutViewportWidth());
  onMount(() => window.addEventListener("resize", onResize));

  // EFB-104 — poll-and-diff self-heal.
  //
  // SSE only reports state changes whose route emits a BoardEvent. An
  // API-driven transition through a route that emits none leaves the stream
  // silent and this tab rendering whatever it had at page load; EFB-102 sat
  // visibly in the wrong column that way. The schedule (and the two cases
  // where it deliberately does nothing) lives in lib/boardPoll so it can be
  // tested without mounting this page.
  //
  // Lifecycle here, fetching in the store — the same split as the SSE fiber.
  let stopPoll: (() => void) | undefined;
  onMount(() => {
    stopPoll = startBoardPoll({ poll: () => void store.pollRefresh() });
  });

  onCleanup(() => {
    window.removeEventListener("resize", onResize);
    stopPoll?.();
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
  /** Sprint the views narrow to, or null. Still the single source of what
   *  "kanban mode" means — the Done-window chip and the filter predicates both
   *  read it, so they cannot disagree. */
  const sprintFilterId = createMemo(() => activeSprintFilterId(activeSprint(), sprintFilterOff()));
  /** The persisted filters plus the live sprint dimension. Merged here rather
   *  than stored in `filters` so the sprint can never reach localStorage, and
   *  so a filters restore (which fires on sign-in/out) cannot race the sprint
   *  back to null. */
  const effectiveFilters = createMemo<BoardFilters>(() => ({
    ...filters(),
    sprintId: sprintFilterId(),
  }));
  // Sprint narrows one funnel; every other dimension narrows all five. Passing
  // the right predicate to the right surface is what replaced the scalar prop.
  const activePredicate = createMemo(() =>
    predicateFor("active", effectiveFilters(), callerPubkey()),
  );
  const ambientPredicate = createMemo(() =>
    predicateFor("ambient", effectiveFilters(), callerPubkey()),
  );
  const doneWindowDays = () => store.board()?.done_window_days ?? FALLBACK_DONE_WINDOW_DAYS;
  /** The window the status stack applies, or null for "show every done card".
   *  The sprint-filter case used to be decided inside StatusStack off the
   *  scalar prop; it is decided here now, next to the state it reads. */
  const doneWindowMs = createMemo(() =>
    effectiveDoneWindowMs(doneWindowLifted(), sprintFilterId() !== null, doneWindowDays()),
  );
  /** The chip only appears where the window actually bites: the kanban view,
   *  in kanban-mode (no sprint narrowing), with a window configured. Anywhere
   *  else it would advertise a control that changes nothing. */
  const showDoneWindowChip = createMemo(
    () => view() === "kanban" && sprintFilterId() === null && doneWindowDays() > 0,
  );
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
    // EFB-67 v2: no `mobile` class. Which header shows is decided by a CSS
    // media query off the layout viewport, not by a JS reading of
    // window.innerWidth — see MobileBoardHeader.tsx for the measurement showing
    // why the JS reading is unsafe on this page specifically.
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
              <div class="board-header-glass">
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
              {/* EFB-67 v2 — BOTH headers render; CSS `display: none` hides the
                  one that does not match the viewport. No runtime decision, no
                  flicker, no resize listener in the path, and nothing that a
                  future overflow bug can corrupt. The duplication of the
                  signed-out / read-only conditions into MobileBoardHeader is
                  the deliberate cost of that; signedOutBoard.test.tsx asserts
                  both together so they cannot drift apart silently. */}
              <header class="board-header board-header-desktop">
                <h1>{board().title}</h1>
                <Show when={board().issue_prefix}>
                  {(prefix) => <span class="prefix-chip">{prefix()}</span>}
                </Show>
                <div class="spacer" />
                {/* Search is a read, so it stays for a signed-out viewer on a
                    public board — same reasoning as Sprints below. The server
                    scopes results to this board and authorizes before it
                    touches the index (EFB-14). */}
                <BoardSearch apiBase={apiBase} base={base()} view={view()} />
                {/* Sprint history stays: it is a read-only view, and a
                    signed-out visitor on a public board may read it. */}
                <a class="btn" href={`${base()}/sprints`} title="Sprint history">
                  Sprints
                </a>
                {/* Settings and New issue are mutation entry points, so they
                    are hidden rather than disabled for a signed-out viewer —
                    a disabled control still advertises an action they have no
                    way to take (EFB-47). */}
                <Show when={orgHandle() && !boardReadOnly()}>
                  <a class="btn" href={`${base()}/settings`} title="Board settings">
                    Settings
                  </a>
                </Show>
                <Show when={!boardReadOnly()}>
                  <button ref={newIssueButton} class="btn btn-solid" onClick={() => setShowNewIssue(true)}>
                    + New issue
                  </button>
                </Show>
              </header>

              <MobileBoardHeader
                title={board().title}
                issuePrefix={board().issue_prefix ?? null}
                base={base()}
                orgHandle={orgHandle()}
                readOnly={boardReadOnly()}
                onNewIssue={() => setShowNewIssue(true)}
              />

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
                {/* The sprint chip above stays interactive — it only filters,
                    which needs no auth. This one completes the sprint. */}
                {/* Guard FIRST so the `&&` result is the sprint, not a
                    boolean — Show hands the callback its `when` value. */}
                <Show when={!boardReadOnly() && activeSprint()}>
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

              {/* The chip row carries two families now: EFB-44's viewer-relative
                  filters, which stay hidden when signed out, and EFB-31's
                  Done-window chip, which does not — the window it lifts applies
                  to anonymous readers too, so the row itself has to survive a
                  signed-out viewer even when the EFB-44 half is empty. */}
              <Show when={callerPubkey() !== null || showDoneWindowChip()}>
                <div class="filter-chips">
                  <Show when={callerPubkey() !== null}>
                    <button
                      class="filter-chip"
                      classList={{ on: filters().mineOnly }}
                      aria-pressed={filters().mineOnly}
                      title={
                        filters().mineOnly
                          ? "Showing only issues assigned to you. Click to show everyone's."
                          : "Showing everyone's issues. Click to show only yours."
                      }
                      onClick={() => applyFilters((f) => ({ ...f, mineOnly: !f.mineOnly }))}
                    >
                      Show my tickets
                    </button>
                    <FilterPicker
                      label="Assignee"
                      options={assigneeOptions()}
                      selected={filters().assignees}
                      onToggle={toggleIn("assignees")}
                      onClear={clearIn("assignees")}
                      emptyLine="Nobody to filter by yet."
                    />
                    <FilterPicker
                      label="Label"
                      options={labelOptions()}
                      selected={filters().labels}
                      onToggle={toggleIn("labels")}
                      onClear={clearIn("labels")}
                      emptyLine="No labels on this board yet."
                    />
                  </Show>
                  {/* EFB-31 — Done-window chip. `on` follows the row's existing
                      vocabulary (a constraint is in force), and `lifted` reads
                      brighter to say the view is deliberately wider than
                      default. Both states are marked: an unmarked chip would
                      leave "why is Done short?" unanswered, which is the
                      confusion the ticket is really about. */}
                  <Show when={showDoneWindowChip()}>
                    <button
                      class="filter-chip"
                      classList={{ on: !doneWindowLifted(), lifted: doneWindowLifted() }}
                      aria-pressed={doneWindowLifted()}
                      title={
                        doneWindowLifted()
                          ? "Showing every done card. Click to show only the recent ones."
                          : `Showing done cards from the last ${doneWindowDays()} days. Click to show all.`
                      }
                      onClick={toggleDoneWindow}
                    >
                      Done · {doneWindowLifted() ? "all" : `${doneWindowDays()}d`}
                    </button>
                  </Show>
                </div>
              </Show>
              </div>

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
                  doneWindowMs={doneWindowMs()}
                  layout={kanbanLayout()}
                  wideRail={wideRail()}
                  matchesActive={activePredicate()}
                  matchesAmbient={ambientPredicate()}
                />
              </Show>
              <Show when={view() === "backlog"}>
                <BacklogView
                  store={store}
                  dnd={dnd}
                  onOpen={(id) => navigate(openPath(id))}
                  matchesFilters={ambientPredicate()}
                  readOnly={boardReadOnly()}
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
                    base={base()}
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
