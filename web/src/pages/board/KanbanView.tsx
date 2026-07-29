// KanbanView — active-container issues in status columns. Only ENABLED
// columns render, in `order` order; a hidden (enabled:false) column keeps
// its issues in the store, they just don't show as a column. Dropping a
// card on a column fires /transition with the column's stable id (via
// BoardPage's dnd onDrop handler; columns just declare their zone).

import { For, Show } from "solid-js";
import { IssueCard } from "../../components/IssueCard";
import { transitionZone, type DndHandle } from "../../lib/dnd";
import { enabledColumns, type Column } from "../../lib/columns";
import type { Issue } from "../../lib/types";
import type { BoardStore } from "./store";

export const KanbanView = (props: {
  store: BoardStore;
  dnd: DndHandle;
  onOpen: (id: string) => void;
}) => {
  const active = () => props.store.issues().filter((i) => i.container === "active");
  const columns = () => enabledColumns(props.store.board()?.columns ?? []);
  // column_id is the identity; status-name match covers rows awaiting the
  // 0005 backfill.
  const inColumn = (column: Column) =>
    active()
      .filter((i) => (i.column_id !== null ? i.column_id === column.id : i.status === column.name))
      .sort((a, b) => b.updated_at_ms - a.updated_at_ms);
  const pointsIn = (issues: readonly Issue[]) =>
    issues.reduce((sum, i) => sum + (i.estimate ?? 0), 0);

  return (
    <Show
      when={active().length > 0}
      fallback={<p class="empty-state">Still waters. What flows next?</p>}
    >
      <div class="kanban">
        <For each={columns()}>
          {(column) => {
            const zone = transitionZone(column.id);
            return (
              <div
                class="kanban-column"
                classList={{ "drop-over": props.dnd.overZone() === zone }}
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
                      <IssueCard issue={issue} dnd={props.dnd} onOpen={props.onOpen} />
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
