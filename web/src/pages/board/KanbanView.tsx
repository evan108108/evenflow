// KanbanView — active-container issues in status columns. Dropping a card
// on another column fires the /transition endpoint (via BoardPage's dnd
// onDrop handler; columns just declare their zone).

import { For, Show } from "solid-js";
import { IssueCard } from "../../components/IssueCard";
import { transitionZone, type DndHandle } from "../../lib/dnd";
import type { Issue } from "../../lib/types";
import type { BoardStore } from "./store";

export const KanbanView = (props: {
  store: BoardStore;
  dnd: DndHandle;
  onOpen: (id: string) => void;
}) => {
  const active = () => props.store.issues().filter((i) => i.container === "active");
  const byStatus = (column: string) =>
    active()
      .filter((i) => i.status === column)
      .sort((a, b) => b.updated_at_ms - a.updated_at_ms);

  return (
    <Show
      when={active().length > 0}
      fallback={<p class="empty-state">Still waters. What flows next?</p>}
    >
      <div class="kanban">
        <For each={props.store.board()?.columns ?? []}>
          {(column) => {
            const zone = transitionZone(column);
            return (
              <div
                class="kanban-column"
                classList={{ "drop-over": props.dnd.overZone() === zone }}
                data-dropzone={zone}
              >
                <h3>
                  {column} <span class="count figure">{byStatus(column).length}</span>
                </h3>
                <For each={byStatus(column)}>
                  {(issue: Issue) => (
                    <IssueCard issue={issue} dnd={props.dnd} onOpen={props.onOpen} />
                  )}
                </For>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
};
