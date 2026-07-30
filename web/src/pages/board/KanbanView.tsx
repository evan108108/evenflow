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
  /** Phase 21c: when non-null, Kanban shows ONLY issues with sprint_id
   *  matching this value. Non-sprint cards hide entirely (Linear-style
   *  cycle filter). When null, every container=active issue shows. */
  filterSprintId?: string | null | undefined;
  /** Phase 21c: when set AND no sprint filter is on, the Done column
   *  hides items completed longer ago than this many ms. Prevents the
   *  Done column from growing indefinitely for kanban-only teams. */
  doneWindowMs?: number | null | undefined;
  layout?: "columns" | "vertical" | undefined;
}) => {
  const active = () => {
    let rows = props.store.issues().filter((i) => i.container === "active");
    if (props.filterSprintId != null) {
      const sid = props.filterSprintId;
      rows = rows.filter((i) => i.sprint_id === sid);
    }
    return rows;
  };
  // Vertical stack reads top-to-bottom, so we flip the column order — Done
  // on top, walk backwards to Todo at the bottom. Reads like "here's what's
  // freshest first" instead of columns' left-to-right progression.
  const columns = () => {
    const enabled = enabledColumns(props.store.board()?.columns ?? []);
    return props.layout === "vertical" ? [...enabled].reverse() : enabled;
  };
  const inColumn = (column: Column): Issue[] => {
    const rows = issuesInColumn(active(), column);
    // Done-window filter: only on the done column, only when there is no
    // sprint filter active (a sprint filter already narrows the deck),
    // and only when the board configured a window. Uses issue.completed_at_ms
    // which the server maintains on transition into/out of done.
    if (
      column.category === "done" &&
      props.filterSprintId == null &&
      props.doneWindowMs != null &&
      props.doneWindowMs > 0
    ) {
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
            {(issue) => <IssueCard issue={issue} dnd={props.dnd} onOpen={props.onOpen} compact />}
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
}) => {
  const backlog = () =>
    props.store
      .issues()
      .filter((i) => i.container === "backlog")
      .sort(byBoardOrder);
  const iced = () =>
    props.store
      .issues()
      .filter((i) => i.container === "icebox")
      .sort((a, b) => b.updated_at_ms - a.updated_at_ms);

  return (
    <aside class="kanban-rail">
      <RailSection
        title="Backlog"
        issues={backlog()}
        zone={moveZone("promote_to_backlog")}
        dnd={props.dnd}
        onOpen={props.onOpen}
        emptyLine="Nothing on your mind."
      />
      <RailSection
        title="Icebox"
        issues={iced()}
        zone={moveZone("send_to_icebox")}
        dnd={props.dnd}
        onOpen={props.onOpen}
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
  /** Phase 21c: sprint id to FILTER by. Only cards with sprint_id === this
   *  render on the board. Null = show all container=active. */
  filterSprintId?: string | null;
  /** Phase 21c: Done-column window in ms; only applied when there's no
   *  sprint filter. Null/undefined = show every done card. */
  doneWindowMs?: number | null;
  /** Horizontal columns (default) or the Linear-style vertical stack. The
   *  status-stack DOM is identical either way — zones, indicators, and
   *  drops are layout-agnostic; only the CSS class changes. */
  layout?: "columns" | "vertical";
  /** Vertical layout only: the viewport is wide enough to put the rail
   *  beside the stack instead of below it (lib/layout isWideVertical). */
  wideRail?: boolean;
}) => (
  <Show
    when={props.layout === "vertical"}
    fallback={
      <StatusStack
        store={props.store}
        dnd={props.dnd}
        onOpen={props.onOpen}
        highlightSprintId={props.highlightSprintId}
        filterSprintId={props.filterSprintId}
        doneWindowMs={props.doneWindowMs}
        layout={props.layout}
      />
    }
  >
    <div class="vertical-split" classList={{ "with-rail": props.wideRail === true }}>
      <StatusStack
        store={props.store}
        dnd={props.dnd}
        onOpen={props.onOpen}
        highlightSprintId={props.highlightSprintId}
        filterSprintId={props.filterSprintId}
        doneWindowMs={props.doneWindowMs}
        layout="vertical"
      />
      <KanbanRail store={props.store} dnd={props.dnd} onOpen={props.onOpen} />
    </div>
  </Show>
);
