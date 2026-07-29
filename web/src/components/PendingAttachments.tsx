// PendingAttachments — a buffered file strip for composers whose target
// row doesn't exist yet (NewIssueModal, the comment composer). Files are
// held client-side as File objects; the owner uploads them on submit, once
// there's an issue/comment to associate with. Image files preview as small
// thumbnails via object URLs (revoked on removal/cleanup).

import { For, Show, createSignal, onCleanup } from "solid-js";
import { MAX_ATTACHMENTS_PER_ISSUE, formatBytes, isImageContentType } from "../lib/attachments";

export const PendingAttachments = (props: {
  files: ReadonlyArray<File>;
  onAdd: (file: File) => void;
  onRemove: (index: number) => void;
  disabled?: boolean;
}) => {
  let fileInput: HTMLInputElement | undefined;
  const [previews, setPreviews] = createSignal<Map<File, string>>(new Map());

  const previewFor = (file: File): string | null => {
    if (!isImageContentType(file.type)) return null;
    const existing = previews().get(file);
    if (existing !== undefined) return existing;
    const url = URL.createObjectURL(file);
    setPreviews((m) => new Map(m).set(file, url));
    return url;
  };

  onCleanup(() => {
    for (const url of previews().values()) URL.revokeObjectURL(url);
  });

  const pick = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    for (const file of Array.from(input.files ?? [])) props.onAdd(file);
    input.value = "";
  };

  return (
    <div class="pending-attachments">
      <Show when={props.files.length > 0}>
        <ul class="pending-list">
          <For each={[...props.files]}>
            {(file, index) => (
              <li class="pending-row">
                <Show
                  when={previewFor(file)}
                  fallback={<span class="file-card" aria-hidden="true">▤</span>}
                >
                  {(url) => <img class="attachment-thumb" src={url()} alt="" />}
                </Show>
                <span class="attachment-name" title={file.name}>
                  {file.name}
                </span>
                <span class="muted attachment-size">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  class="attachment-action delete"
                  title="Remove"
                  disabled={props.disabled}
                  onClick={() => props.onRemove(index())}
                >
                  ×
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <input ref={fileInput} type="file" multiple style={{ display: "none" }} onChange={pick} />
      <button
        type="button"
        class="btn"
        disabled={props.disabled || props.files.length >= MAX_ATTACHMENTS_PER_ISSUE}
        onClick={() => fileInput?.click()}
      >
        + Attach file
      </button>
    </div>
  );
};
