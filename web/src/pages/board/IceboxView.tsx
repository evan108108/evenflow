// IceboxView — cold storage, flat list. Drop strips promote a thawed idea
// back into the backlog or straight into the active flow.

import { For, Show } from "solid-js";
import { IssueCard } from "../../components/IssueCard";
import { StreamSentinel } from "../../components/StreamSentinel";
import { listIndicator, moveZone, posZone, type DndHandle } from "../../lib/dnd";
import { refFor, shortIdIndex } from "../../lib/duplicates";
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
  // Over EVERY loaded issue, not just the icebox — an iced duplicate almost
  // always points at something that isn't iced.
  const duplicateRefs = () => shortIdIndex(props.store.issues());

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
            {(issue) => {
              const peerHas = (id: string) => iced().some((i) => i.id === id);
              const cardIndicator = listIndicator(props.dnd, "icebox", issue.id, peerHas);
              return (
                <IssueCard
                  issue={issue}
                  dnd={props.dnd}
                  onOpen={props.onOpen}
                  zone={posZone("icebox", issue.id)}
                  indicator={cardIndicator()}
                  duplicateOfRef={refFor(duplicateRefs(), issue)}
                  compact
                />
              );
            }}
          </For>
      <StreamSentinel stream={props.store.streamFor("icebox")} />
        </Show>
      </section>
    </div>
  );
};
