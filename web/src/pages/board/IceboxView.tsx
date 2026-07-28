// IceboxView — cold storage, flat list. Drop strips promote a thawed idea
// back into the backlog or straight into the active flow.

import { For, Show } from "solid-js";
import { IssueCard } from "../../components/IssueCard";
import { moveZone, type DndHandle } from "../../lib/dnd";
import type { BoardStore } from "./store";

export const IceboxView = (props: {
  store: BoardStore;
  dnd: DndHandle;
  onOpen: (id: string) => void;
}) => {
  const iced = () =>
    props.store
      .issues()
      .filter((i) => i.container === "icebox")
      .sort((a, b) => b.updated_at_ms - a.updated_at_ms);

  const backlogZone = moveZone("promote_to_backlog");
  const activeZone = moveZone("promote_to_active");

  return (
    <div>
      <div style={{ display: "flex", gap: "0.8rem" }}>
        <div
          class="drop-strip"
          style={{ flex: "1" }}
          classList={{ "drop-over": props.dnd.overZone() === backlogZone }}
          data-dropzone={backlogZone}
        >
          Into the queue → Backlog
        </div>
        <div
          class="drop-strip"
          style={{ flex: "1" }}
          classList={{ "drop-over": props.dnd.overZone() === activeZone }}
          data-dropzone={activeZone}
        >
          Into the flow → Active
        </div>
      </div>

      <section class="list-section">
        <h2>
          Icebox <span class="count figure muted">{iced().length}</span>
        </h2>
        <Show
          when={iced().length > 0}
          fallback={<p class="empty-state">Cold storage. Thoughts on ice.</p>}
        >
          <For each={iced()}>
            {(issue) => <IssueCard issue={issue} dnd={props.dnd} onOpen={props.onOpen} />}
          </For>
        </Show>
      </section>
    </div>
  );
};
