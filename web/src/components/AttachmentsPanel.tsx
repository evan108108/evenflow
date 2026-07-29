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

export const AttachmentsPanel = (props: {
  attachments: ReadonlyArray<Attachment>;
  readOnly: boolean;
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
