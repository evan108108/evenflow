// KanbanView — active-container issues in status columns. Only ENABLED
// columns render, in `order` order; a hidden (enabled:false) column keeps
// its issues in the store, they just don't show as a column. Dropping a
// card on a column fires /transition with the column's stable id (via
// BoardPage's dnd onDrop handler; columns just declare their zone).

import { For, Show } from "solid-js";
import { IssueCard } from "../../components/IssueCard";
import { cardZone, parseZone, transitionZone, type DndHandle } from "../../lib/dnd";
import { enabledColumns, type Column } from "../../lib/columns";
import { issuesInColumn } from "../../lib/order";
import type { Issue } from "../../lib/types";
import type { BoardStore } from "./store";

export const KanbanView = (props: {
  store: BoardStore;
  dnd: DndHandle;
  onOpen: (id: string) => void;
  /** Sprint id to spotlight (phase 20's badge toggle); null = no spotlight. */
  highlightSprintId?: string | null;
  /** Horizontal columns (default) or the Linear-style vertical stack. The
   *  DOM is identical either way — zones, indicators, and drops are
   *  layout-agnostic; only the CSS class changes. */
  layout?: "columns" | "vertical";
}) => {
  const active = () => props.store.issues().filter((i) => i.container === "active");
  const columns = () => enabledColumns(props.store.board()?.columns ?? []);
  const inColumn = (column: Column) => issuesInColumn(active(), column);
  const pointsIn = (issues: readonly Issue[]) =>
    issues.reduce((sum, i) => sum + (i.estimate ?? 0), 0);

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
                    {column.name}{" "}
                    <span class="count figure">{inColumn(column).length}</span>
                    <Show when={pointsIn(inColumn(column)) > 0}>
                      <span class="count-sep"> · </span>
                      <span class="count figure">{pointsIn(inColumn(column))}pts</span>
                    </Show>
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
                      />
                    )}
                  </For>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
};
