// BacklogView — Active section on top (grouped by status column), Backlog
// below (flat, newest-updated first), plus an icebox drop strip. Dragging
// between sections fires the container-move endpoints.

import { For, Show } from "solid-js";
import { IssueCard } from "../../components/IssueCard";
import { moveZone, type DndHandle } from "../../lib/dnd";
import { enabledColumns, type Column } from "../../lib/columns";
import { byBoardOrder, issuesInColumn } from "../../lib/order";
import type { BoardStore } from "./store";

export const BacklogView = (props: {
  store: BoardStore;
  dnd: DndHandle;
  onOpen: (id: string) => void;
}) => {
  const active = () => props.store.issues().filter((i) => i.container === "active");
  const backlog = () =>
    props.store
      .issues()
      .filter((i) => i.container === "backlog")
      .sort(byBoardOrder);
  const activeInColumn = (column: Column) => issuesInColumn(active(), column);

  const activeZone = moveZone("promote_to_active");
  const backlogZone = moveZone("promote_to_backlog");
  const iceboxZone = moveZone("send_to_icebox");

  return (
    <div>
      <section
        class="list-section"
        classList={{ "drop-over": props.dnd.overZone() === activeZone }}
        data-dropzone={activeZone}
      >
        <h2>
          Active <span class="count figure muted">{active().length}</span>
        </h2>
        <Show when={active().length > 0} fallback={<p class="empty-state">Still waters.</p>}>
          <For each={enabledColumns(props.store.board()?.columns ?? [])}>
            {(column) => (
              <Show when={activeInColumn(column).length > 0}>
                <div class="status-group">
                  <h4>{column.name}</h4>
                  <For each={activeInColumn(column)}>
                    {(issue) => <IssueCard issue={issue} dnd={props.dnd} onOpen={props.onOpen} compact />}
                  </For>
                </div>
              </Show>
            )}
          </For>
        </Show>
      </section>

      <section
        class="list-section"
        classList={{ "drop-over": props.dnd.overZone() === backlogZone }}
        data-dropzone={backlogZone}
      >
        <h2>
          Backlog <span class="count figure muted">{backlog().length}</span>
        </h2>
        <Show
          when={backlog().length > 0}
          fallback={<p class="empty-state">Nothing on your mind. What are you thinking about?</p>}
        >
          <For each={backlog()}>
            {(issue) => <IssueCard issue={issue} dnd={props.dnd} onOpen={props.onOpen} compact />}
          </For>
        </Show>
      </section>

      <div
        class="drop-strip"
        classList={{ "drop-over": props.dnd.overZone() === iceboxZone }}
        data-dropzone={iceboxZone}
      >
        Drag here to put a thought on ice ❄
      </div>
    </div>
  );
};
