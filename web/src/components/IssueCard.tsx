// One kanban/backlog/icebox card. The pointerdown gesture is shared: a
// short press is a click (open the sheet), a >6px move is a drag (dnd).

import { For, Show } from "solid-js";
import type { Issue } from "../lib/types";
import type { DndHandle } from "../lib/dnd";
import { Author } from "./Author";
import { IssueRef } from "./IssueRef";

export const IssueCard = (props: {
  issue: Issue;
  dnd: DndHandle;
  onOpen: (ref: string) => void;
}) => (
  <div
    class="issue-card"
    data-issue-id={props.issue.id}
    onPointerDown={(e) =>
      props.dnd.startDrag(e, props.issue.id, () =>
        props.onOpen(props.issue.short_id ?? props.issue.id),
      )
    }
  >
    <Show when={props.issue.short_id}>
      {(shortId) => <IssueRef shortId={shortId()} class="card-ref" />}
    </Show>
    <div class="title">{props.issue.title}</div>
    <div class="chips">
      <Show when={props.issue.estimate !== null}>
        <span class="chip estimate figure">{props.issue.estimate}</span>
      </Show>
      <Show when={props.issue.priority !== null}>
        <span class="chip priority">P{props.issue.priority}</span>
      </Show>
      <Show when={props.issue.assignee_pubkey !== null}>
        <span class="chip">
          <Author pubkey={props.issue.assignee_pubkey as string} class="" />
        </span>
      </Show>
      <For each={props.issue.labels}>{(label) => <span class="chip">{label}</span>}</For>
    </div>
  </div>
);
