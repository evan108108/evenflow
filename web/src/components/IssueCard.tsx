// One kanban/backlog/icebox card. The pointerdown gesture is shared: a
// short press is a click (open the sheet), a >6px move is a drag (dnd).
//
// Cards with an image cover (issue.cover_url, from the list endpoint's
// enrichment) render the cover portrait-cropped at the top, with the
// title/ref/type/chips overlaid on the bottom third above a legibility
// gradient — and a subtle scroll parallax on the image (skipped under
// prefers-reduced-motion). Cards without covers stay exactly as compact
// as before.

import { For, Show, onCleanup, onMount } from "solid-js";
import type { Issue } from "../lib/types";
import type { DndHandle } from "../lib/dnd";
import { typeLabel } from "../lib/columns";
import { attachParallax } from "../lib/parallax";
import { Author } from "./Author";
import { IssueRef } from "./IssueRef";
import { IssueTypeIcon } from "./IssueTypeIcon";

const CardMeta = (props: { issue: Issue }) => (
  <>
    <div class="card-ref-row">
      <span class="type-badge" title={`Type: ${typeLabel(props.issue.type)}`}>
        <IssueTypeIcon type={props.issue.type} />
      </span>
      <Show when={props.issue.short_id}>
        {(shortId) => <IssueRef shortId={shortId()} class="card-ref" />}
      </Show>
    </div>
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
  </>
);

export const IssueCard = (props: {
  issue: Issue;
  dnd: DndHandle;
  onOpen: (ref: string) => void;
  /** When true, skips the tall cover-image treatment. Used by list views
   *  (Backlog / Icebox) where a full-width 3:4 cover would eat the page. */
  compact?: boolean;
}) => {
  const cover = () => (props.compact === true ? null : props.issue.cover_url ?? null);

  let cardEl: HTMLDivElement | undefined;
  let coverImg: HTMLImageElement | undefined;
  let detachParallax: (() => void) | undefined;

  onMount(() => {
    // Only covered cards pay for the effect; cleanup rides card unmount.
    if (cardEl !== undefined && coverImg !== undefined) {
      detachParallax = attachParallax(cardEl, coverImg);
    }
  });
  onCleanup(() => detachParallax?.());

  return (
    <div
      ref={cardEl}
      class="issue-card"
      classList={{ "has-cover": cover() !== null }}
      data-issue-id={props.issue.id}
      onPointerDown={(e) =>
        props.dnd.startDrag(e, props.issue.id, () =>
          props.onOpen(props.issue.short_id ?? props.issue.id),
        )
      }
    >
      <Show when={cover()} fallback={<CardMeta issue={props.issue} />}>
        {(url) => (
          <div class="issue-cover">
            <img ref={coverImg} src={url()} alt="" draggable={false} />
            <div class="cover-overlay">
              <CardMeta issue={props.issue} />
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};
