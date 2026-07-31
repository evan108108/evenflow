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
import { externalStateLabel, externalStateTone, primaryPrLink, prUrl } from "../lib/externalState";
import { attachParallax } from "../lib/parallax";
import { AssigneeAvatar } from "./AssigneeAvatar";
import { IssueRef } from "./IssueRef";
import { IssueTypeIcon } from "./IssueTypeIcon";

const CardMeta = (props: { issue: Issue; duplicateOfRef?: string | null | undefined }) => (
  <>
    <div class="card-ref-row">
      <span class="type-badge" title={`Type: ${typeLabel(props.issue.type)}`}>
        <IssueTypeIcon type={props.issue.type} />
      </span>
      <Show when={props.issue.short_id}>
        {(shortId) => <IssueRef shortId={shortId()} class="card-ref" />}
      </Show>
      {/* EFB-30. Sits in the ref row, next to this card's own id, because it
          is a fact about the card's IDENTITY — "this ticket is that ticket" —
          not an attribute like estimate or label. Rendering it here means the
          duplication is legible without opening the sheet, which is the whole
          reason the row is kept instead of deleted. The arrow degrades to a
          bare "duplicate" when the target isn't among the loaded pages: the
          pointer is still true, only its short id is unknown. */}
      <Show when={props.issue.duplicate_of_issue_id}>
        <span
          class="card-duplicate-of"
          title={
            props.duplicateOfRef == null
              ? "Duplicate of another issue"
              : `Duplicate of ${props.duplicateOfRef}`
          }
        >
          {props.duplicateOfRef == null ? "duplicate" : `→ ${props.duplicateOfRef}`}
        </span>
      </Show>
    </div>
    <div class="title">{props.issue.title}</div>
    {/* The external_state pill sits ABOVE the chip row and is deliberately
        not one of them: it reports a fact about the world outside the
        board, not a board-local attribute like estimate or label. */}
    <Show when={props.issue.external_state}>
      {(state) => {
        const link = () => primaryPrLink(props.issue.github_links);
        return (
          <div class="card-external-state">
            <a
              class={`external-state-pill tone-${externalStateTone(state())}`}
              classList={{ "is-link": link() !== null }}
              href={link() === null ? undefined : prUrl(link()!)}
              target={link() === null ? undefined : "_blank"}
              rel="noopener noreferrer"
              title={
                link() === null
                  ? externalStateLabel(state())
                  : `${externalStateLabel(state())} — ${link()!.repo}#${link()!.pr}`
              }
              // The card's pointerdown starts a drag; a pill click must
              // open the PR instead of dragging the card behind it.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {externalStateLabel(state())}
            </a>
          </div>
        );
      }}
    </Show>
    {/* Estimate and assignee always occupy their slot, filled or not (EFB-37),
        so cards in a column keep one shape and the eye can scan height. The
        placeholders are aria-hidden: "no estimate" is already conveyed by the
        absence of a value, and reading out an em dash adds noise, not
        information. Priority and labels are NOT padded this way — they are
        genuinely optional attributes rather than fields every issue has. */}
    <div class="chips">
      <Show
        when={props.issue.estimate !== null}
        fallback={<span class="chip estimate figure is-placeholder" aria-hidden="true">—</span>}
      >
        <span class="chip estimate figure">{props.issue.estimate}</span>
      </Show>
      <Show when={props.issue.priority !== null}>
        <span class="chip priority">P{props.issue.priority}</span>
      </Show>
      <Show
        when={props.issue.assignee_pubkey !== null}
        fallback={<span class="assignee-avatar is-placeholder" aria-hidden="true" />}
      >
        <AssigneeAvatar pubkey={props.issue.assignee_pubkey as string} />
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
  /** data-dropzone value making this card an insertion target (kanban
   *  intra-column reorder). Views that don't reorder just omit it. */
  zone?: string;
  /** Insertion-slot indicator while a drag hovers this card. */
  indicator?: "before" | "after" | null;
  /** Sprint spotlight (phase 20) — subtle ink border while the badge is on. */
  highlight?: boolean;
  /** Short id of the issue this one duplicates (EFB-30), when the view could
   *  resolve it. Null/absent with a duplicate_of pointer set just means the
   *  target wasn't in the loaded pages — the badge still shows, unlabelled. */
  duplicateOfRef?: string | null | undefined;
}) => {
  // Compact mode skips the tall portrait cover. If the issue still HAS a cover,
  // we render it as a small square thumbnail on the left instead (list-view
  // affordance so you can still tell at a glance which issue this is).
  const cover = () => (props.compact === true ? null : props.issue.cover_url ?? null);
  const thumb = () =>
    props.compact === true ? props.issue.cover_url ?? null : null;

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
      classList={{
        "has-cover": cover() !== null,
        "has-thumb": thumb() !== null,
        "reorder-before": props.indicator === "before",
        "reorder-after": props.indicator === "after",
        "sprint-spotlight": props.highlight === true,
      }}
      data-issue-id={props.issue.id}
      data-dropzone={props.zone}
      onPointerDown={(e) =>
        props.dnd.startDrag(e, props.issue.id, () =>
          props.onOpen(props.issue.short_id ?? props.issue.id),
        )
      }
    >
      <Show
        when={cover()}
        fallback={
          <Show
            when={thumb()}
            fallback={<CardMeta issue={props.issue} duplicateOfRef={props.duplicateOfRef} />}
          >
            {(url) => (
              <>
                <img class="issue-thumb" src={url()} alt="" draggable={false} />
                <div class="issue-thumb-meta">
                  <CardMeta issue={props.issue} duplicateOfRef={props.duplicateOfRef} />
                </div>
              </>
            )}
          </Show>
        }
      >
        {(url) => (
          <div class="issue-cover">
            <img ref={coverImg} src={url()} alt="" draggable={false} />
            <div class="cover-overlay">
              <CardMeta issue={props.issue} duplicateOfRef={props.duplicateOfRef} />
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};
