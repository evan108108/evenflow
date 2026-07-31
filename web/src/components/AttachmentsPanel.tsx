// AttachmentsPanel — the issue sheet's Files section. Image attachments
// render as thumbnails, everything else as generic file cards; each row
// carries Set-as-cover (star) + Delete for contributors. readOnly mode
// (anonymous viewers on public boards) lists without any mutation UI.
//
// Upload errors surface the server's actionable copy verbatim — the
// size-cap message links at the org's storage settings page (18b).

import { For, Show, createSignal } from "solid-js";
import {
  MAX_ATTACHMENTS_PER_ISSUE,
  formatBytes,
  isImageContentType,
  type Attachment,
} from "../lib/attachments";

export interface AttachmentActionError {
  readonly message: string;
  readonly link: string | null;
}

/**
 * EFB-57. TODO: copy pending Evan's voice review — variant B is the standing
 * proposal, not the decision. Swap this string only; nothing else depends on
 * its wording.
 */
const PRIVACY_NOTE =
  "This board is private — its attachments aren't. Anyone with a file's link can open it, member or not.";

/**
 * Does this board need the attachment-privacy notice?
 *
 * Gated on `!== "public"` rather than `=== "private"` deliberately.
 * `visibility` is optional on the wire type so pre-phase-16 payloads still
 * parse, and an absent value would silently SUPPRESS the notice under an
 * equality check — the one failure this notice exists to prevent.
 *
 * This is `publishesPlaintext`'s polarity inverted, and the inversion is the
 * point. That gate asks `=== "public"` because a false negative merely declines
 * to publish; here a false positive merely shows a notice to someone whose file
 * was never at risk. Both choose the harmless direction, which lands on
 * opposite operators.
 */
const needsPrivacyNote = (visibility: "private" | "public" | undefined): boolean =>
  visibility !== "public";

export const AttachmentsPanel = (props: {
  attachments: ReadonlyArray<Attachment>;
  readOnly: boolean;
  /**
   * The board's visibility, straight off the board row. Explicitly admits
   * `undefined` rather than relying on optionality: under
   * `exactOptionalPropertyTypes` those are different types, and the absent case
   * is the one the gate below most needs to receive.
   */
  boardVisibility?: "private" | "public" | undefined;
  onUpload: (file: File) => Promise<AttachmentActionError | null>;
  onSetCover: (attachment: Attachment, is_cover: boolean) => void;
  onDelete: (attachment: Attachment) => void;
}) => {
  const [error, setError] = createSignal<AttachmentActionError | null>(null);
  const [busy, setBusy] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;

  const pick = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file === undefined) return;
    setBusy(true);
    setError(null);
    setError(await props.onUpload(file));
    setBusy(false);
  };

  return (
    <section class="sheet-section attachments-panel">
      <h3>Files</h3>
      <Show when={props.attachments.length > 0} fallback={<p class="muted">Nothing attached.</p>}>
        <ul class="attachment-list">
          <For each={props.attachments}>
            {(attachment) => (
              <li class="attachment-row" classList={{ cover: attachment.is_cover }}>
                <Show
                  when={isImageContentType(attachment.content_type)}
                  fallback={<span class="file-card" aria-hidden="true">▤</span>}
                >
                  <img class="attachment-thumb" src={attachment.blob_url} alt={attachment.filename} />
                </Show>
                <span class="attachment-name" title={attachment.filename}>
                  {attachment.filename}
                </span>
                <span class="muted attachment-size">{formatBytes(attachment.size_bytes)}</span>
                <Show when={attachment.is_cover}>
                  <span class="chip cover-chip">cover</span>
                </Show>
                <Show when={!props.readOnly}>
                  <Show when={isImageContentType(attachment.content_type)}>
                    <button
                      type="button"
                      class="attachment-action star"
                      classList={{ on: attachment.is_cover }}
                      title={attachment.is_cover ? "Remove cover" : "Set as cover"}
                      onClick={() => props.onSetCover(attachment, !attachment.is_cover)}
                    >
                      {attachment.is_cover ? "★" : "☆"}
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="attachment-action delete"
                    title="Delete attachment"
                    onClick={() => props.onDelete(attachment)}
                  >
                    ×
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={error()}>
        {(err) => (
          <p class="attachment-error" role="alert">
            {err().message}{" "}
            <Show when={err().link}>
              {(link) => <a href={link()}>Storage settings →</a>}
            </Show>
          </p>
        )}
      </Show>

      <Show when={!props.readOnly}>
        {/*
          Sits ABOVE the button, not inside a confirmation step, because the
          file picker is the OS's and there is no dialog of ours to interrupt.
          A notice a user meets after committing to the upload is a notice that
          arrived too late to inform the choice.
        */}
        <Show when={needsPrivacyNote(props.boardVisibility)}>
          <p class="attachment-privacy-note">
            {PRIVACY_NOTE} <a href="/docs#attachment-privacy">How storage works →</a>
          </p>
        </Show>
        <div class="attachment-upload">
          <input ref={fileInput} type="file" style={{ display: "none" }} onChange={(e) => void pick(e)} />
          <button
            type="button"
            class="btn"
            disabled={busy() || props.attachments.length >= MAX_ATTACHMENTS_PER_ISSUE}
            onClick={() => fileInput?.click()}
          >
            <Show when={!busy()} fallback={"Catching the current…"}>
              + Attach file
            </Show>
          </button>
        </div>
      </Show>
    </section>
  );
};
