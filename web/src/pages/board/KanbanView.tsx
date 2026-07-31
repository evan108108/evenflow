// KanbanView — active-container issues in status columns. Only ENABLED
// columns render, in `order` order; a hidden (enabled:false) column keeps
// its issues in the store, they just don't show as a column. Dropping a
// card on a column fires /transition with the column's stable id (via
// BoardPage's dnd onDrop handler; columns just declare their zone).
//
// The vertical layout also renders a Backlog + Icebox rail (phase 21). At
// >= WIDE_VERTICAL_MIN_PX the rail sits beside the stack and scrolls
// independently (`with-rail`); narrower, the same markup reflows to the
// bottom of the single stack. The Kanban / Backlog / Icebox tabs remain —
// this is the ambient combined view, they're the full-width escape hatch.

import { For, Show, createSignal } from "solid-js";
import { IssueCard } from "../../components/IssueCard";
import { StreamSentinel } from "../../components/StreamSentinel";
import { cardZone, moveZone, parseZone, transitionZone, type DndHandle } from "../../lib/dnd";
import { enabledColumns, type Column } from "../../lib/columns";
import { byBoardOrder, issuesInColumn } from "../../lib/order";
import { refFor, shortIdIndex } from "../../lib/duplicates";
import type { Issue } from "../../lib/types";
import type { BoardStore } from "./store";

const pointsIn = (issues: readonly Issue[]) =>
  issues.reduce((sum, i) => sum + (i.estimate ?? 0), 0);

/** Header treatment shared by status columns and rail sections: name,
 *  count, and points when any card carries an estimate. */
const SectionCounts = (props: { issues: readonly Issue[] }) => (
  <>
    <span class="count figure">{props.issues.length}</span>
    <Show when={pointsIn(props.issues) > 0}>
      <span class="count-sep"> · </span>
      <span class="count figure">{pointsIn(props.issues)}pts</span>
    </Show>
  </>
);

/** The status stack itself — columns left-to-right, or reversed and
 *  stacked in the vertical layout. */
const StatusStack = (props: {
  store: BoardStore;
  dnd: DndHandle;
  onOpen: (id: string) => void;
  highlightSprintId?: string | null | undefined;
  /** When set, the Done column hides items completed longer ago than this
   *  many ms — keeps Done from growing indefinitely for kanban-only teams.
   *  Null/undefined = show every done card. BoardPage has already folded the
   *  sprint-filter and viewer-lift cases into this value (lib/doneWindow). */
  doneWindowMs?: number | null | undefined;
  layout?: "columns" | "vertical" | undefined;
  /** EFB-45: the `active`-scope predicate — every filter dimension including
   *  sprint. Absent = no filtering. */
  matchesFilters?: ((issue: Issue) => boolean) | undefined;
}) => {
  const active = () => {
    const rows = props.store.issues().filter((i) => i.container === "active");
    const pred = props.matchesFilters;
    return pred === undefined ? rows : rows.filter(pred);
  };
  // Over EVERY loaded issue, not just the active container: a duplicate in a
  // status column usually points at something sitting in the backlog.
  const duplicateRefs = () => shortIdIndex(props.store.issues());
  // Vertical stack reads top-to-bottom, so we flip the column order — Done
  // on top, walk backwards to Todo at the bottom. Reads like "here's what's
  // freshest first" instead of columns' left-to-right progression.
  const columns = () => {
    const enabled = enabledColumns(props.store.board()?.columns ?? []);
    return props.layout === "vertical" ? [...enabled].reverse() : enabled;
  };
  const inColumn = (column: Column): Issue[] => {
    const rows = issuesInColumn(active(), column);
    // Done-window filter: only on the done column, and only when a window
    // reaches us at all. BoardPage already resolved the "a sprint filter
    // narrows the deck, so don't window on top" case to null (lib/doneWindow),
    // so there is nothing to re-decide here. Uses issue.completed_at_ms, which
    // the server maintains on transition into/out of done.
    if (column.category === "done" && props.doneWindowMs != null && props.doneWindowMs > 0) {
      const cutoff = Date.now() - props.doneWindowMs;
      return rows.filter((i) => (i.completed_at_ms ?? 0) >= cutoff);
    }
    return rows;
  };

  // The card zone under the pointer, when there is one.
  const overCard = () => {
    const zone = props.dnd.overZone();
    if (zone === null) return null;
    const parsed = parseZone(zone);
    return parsed?.type === "card" ? parsed : null;
  };
  // Insertion indicator on this card — only for a drag within its own
  // column (a cross-column drop is a transition, not a reorder).
  const indicatorFor = (column: Column, issue: Issue): "before" | "after" | null => {
    const over = overCard();
    if (over === null || over.issue !== issue.id || over.column !== column.id) return null;
    const dragging = props.dnd.draggingId();
    if (dragging === null || dragging === issue.id) return null;
    const draggedIssue = props.store.issues().find((i) => i.id === dragging);
    if (draggedIssue === undefined || !inColumn(column).some((i) => i.id === dragging)) return null;
    return over.half;
  };

  return (
    <Show
      when={active().length > 0}
      fallback={<p class="empty-state">Still waters. What flows next?</p>}
    >
      <div class="kanban" classList={{ "layout-vertical": props.layout === "vertical" }}>
        <For each={columns()}>
          {(column) => {
            const zone = transitionZone(column.id);
            // The column highlights for a direct hover, or when the pointer
            // is over one of its cards during a CROSS-column drag (that
            // drop transitions here; same-column card hovers show the
            // insertion indicator instead).
            const dropOver = () => {
              if (props.dnd.overZone() === zone) return true;
              const over = overCard();
              const dragging = props.dnd.draggingId();
              return (
                over !== null &&
                over.column === column.id &&
                dragging !== null &&
                !inColumn(column).some((i) => i.id === dragging)
              );
            };
            return (
              <div
                class="kanban-column"
                classList={{ "drop-over": dropOver() }}
                data-dropzone={zone}
              >
                <div class="kanban-column-content">
                  <h3>
                    {column.name} <SectionCounts issues={inColumn(column)} />
                  </h3>
                  <For each={inColumn(column)}>
                    {(issue: Issue) => (
                      <IssueCard
                        issue={issue}
                        dnd={props.dnd}
                        onOpen={props.onOpen}
                        zone={cardZone(column.id, issue.id)}
                        indicator={indicatorFor(column, issue)}
                        duplicateOfRef={refFor(duplicateRefs(), issue)}
                        highlight={
                          props.highlightSprintId != null &&
                          issue.sprint_id === props.highlightSprintId
                        }
                        compact={props.layout === "vertical"}
                      />
                    )}
                  </For>
                  {/* Phase 22: each column is its own paged stream. */}
                  <StreamSentinel stream={props.store.streamFor("active", column.id)} />
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
};

/** One rail section — the BacklogView list-section shape (whole section is
 *  the container-move drop target) with the status-column header. A
 *  collapsed section keeps its header live as a drop target, so you can
 *  ice a card without expanding the Icebox first. */
const RailSection = (props: {
  title: string;
  issues: readonly Issue[];
  /** id → short id over the loaded issues, for the duplicate-of badge
   *  (EFB-30). Passed down rather than derived here: this section has no
   *  store, and it renders a slice, not the board. */
  duplicateRefs: Map<string, string>;
  /** Container-move zone this section accepts drops for. */
  zone: string;
  dnd: DndHandle;
  onOpen: (id: string) => void;
  emptyLine: string;
  /** Starts closed and toggles on a header click. Plain sections omit it. */
  collapsible?: boolean;
}) => {
  const [expanded, setExpanded] = createSignal(props.collapsible !== true);

  return (
    <section
      class="list-section rail-section"
      classList={{ "drop-over": props.dnd.overZone() === props.zone, collapsed: !expanded() }}
      data-dropzone={props.zone}
    >
      <h3>
        <Show
          when={props.collapsible === true}
          fallback={<span>{props.title}</span>}
        >
          <button
            class="rail-collapse"
            aria-expanded={expanded()}
            onClick={() => setExpanded((v) => !v)}
          >
            {props.title}
            <span class="rail-caret" aria-hidden="true">
              {expanded() ? "▾" : "▸"}
            </span>
          </button>
        </Show>{" "}
        <SectionCounts issues={props.issues} />
      </h3>
      <Show when={expanded()}>
        <Show
          when={props.issues.length > 0}
          fallback={<p class="empty-state">{props.emptyLine}</p>}
        >
          <For each={props.issues}>
            {(issue) => (
              <IssueCard
                issue={issue}
                dnd={props.dnd}
                onOpen={props.onOpen}
                duplicateOfRef={refFor(props.duplicateRefs, issue)}
                compact
              />
            )}
          </For>
        </Show>
      </Show>
    </section>
  );
};

/** Backlog + Icebox beside (or below) the status stack. Sprint membership
 *  isn't modelled here — the rail has no sprint sections, so a backlog
 *  issue that belongs to a sprint still lists, rather than vanishing from
 *  the ambient view. The Backlog tab remains the sprint-shaping surface. */
const KanbanRail = (props: {
  store: BoardStore;
  dnd: DndHandle;
  onOpen: (id: string) => void;
  /** EFB-44 board filters. Absent = no filtering. */
  matchesFilters?: ((issue: Issue) => boolean) | undefined;
}) => {
  const keep = (rows: Issue[]) => {
    const pred = props.matchesFilters;
    return pred === undefined ? rows : rows.filter(pred);
  };
  const backlog = () =>
    keep(props.store.issues().filter((i) => i.container === "backlog")).sort(byBoardOrder);
  const iced = () =>
    keep(props.store.issues().filter((i) => i.container === "icebox")).sort(
      (a, b) => b.updated_at_ms - a.updated_at_ms,
    );
  // Indexed over EVERY loaded issue, not the filtered slice: a duplicate's
  // target is frequently something the current filter excludes, and the badge
  // should still name it.
  const duplicateRefs = () => shortIdIndex(props.store.issues());

  return (
    <aside class="kanban-rail">
      <RailSection
        title="Backlog"
        issues={backlog()}
        zone={moveZone("promote_to_backlog")}
        dnd={props.dnd}
        onOpen={props.onOpen}
        duplicateRefs={duplicateRefs()}
        emptyLine="Nothing on your mind."
      />
      <RailSection
        title="Icebox"
        issues={iced()}
        zone={moveZone("send_to_icebox")}
        dnd={props.dnd}
        onOpen={props.onOpen}
        duplicateRefs={duplicateRefs()}
        emptyLine="Cold storage. Thoughts on ice."
        collapsible
      />
    </aside>
  );
};

export const KanbanView = (props: {
  store: BoardStore;
  dnd: DndHandle;
  onOpen: (id: string) => void;
  /** Sprint id to spotlight (phase 20's badge toggle); null = no spotlight. */
  highlightSprintId?: string | null;
  /** Done-column window in ms, already resolved by BoardPage — null/undefined
   *  means show every done card. */
  doneWindowMs?: number | null;
  /** Horizontal columns (default) or the Linear-style vertical stack. The
   *  status-stack DOM is identical either way — zones, indicators, and
   *  drops are layout-agnostic; only the CSS class changes. */
  layout?: "columns" | "vertical";
  /** Vertical layout only: the viewport is wide enough to put the rail
   *  beside the stack instead of below it (lib/layout isWideVertical). */
  wideRail?: boolean;
  /** EFB-45 `active`-scope predicate — includes the sprint dimension. Goes to
   *  the status stack only. Absent = no filtering. */
  matchesActive?: ((issue: Issue) => boolean) | undefined;
  /** EFB-45 `ambient`-scope predicate — every dimension EXCEPT sprint. Goes to
   *  the rail, which has no sprint sections and stays deliberately ambient. */
  matchesAmbient?: ((issue: Issue) => boolean) | undefined;
}) => (
  <Show
    when={props.layout === "vertical"}
    fallback={
      <StatusStack
        store={props.store}
        dnd={props.dnd}
        onOpen={props.onOpen}
        highlightSprintId={props.highlightSprintId}
        doneWindowMs={props.doneWindowMs}
        layout={props.layout}
        matchesFilters={props.matchesActive}
      />
    }
  >
    <div class="vertical-split" classList={{ "with-rail": props.wideRail === true }}>
      <StatusStack
        store={props.store}
        dnd={props.dnd}
        onOpen={props.onOpen}
        highlightSprintId={props.highlightSprintId}
        doneWindowMs={props.doneWindowMs}
        layout="vertical"
        matchesFilters={props.matchesActive}
      />
      <KanbanRail
        store={props.store}
        dnd={props.dnd}
        onOpen={props.onOpen}
        matchesFilters={props.matchesAmbient}
      />
    </div>
  </Show>
);
