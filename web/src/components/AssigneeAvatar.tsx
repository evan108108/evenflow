// A small circular avatar for a pubkey. Falls back to a monogram bubble
// when profile.picture isn't there yet. Replaces the Author text chip on
// cards — Linear treats assignees as an avatar not a label, and mixing
// them with real labels made the label field ambiguous.

import { Show, createMemo, createRenderEffect } from "solid-js";
import { profileFor, requestProfile } from "../lib/profileStore";

const initials = (pubkey: string, name: string | null): string => {
  const src = (name ?? "").trim();
  if (src === "") return pubkey.slice(0, 2).toUpperCase();
  const parts = src.split(/\s+/);
  return (parts.length >= 2
    ? parts[0]![0]! + parts[1]![0]!
    : src.slice(0, 2)).toUpperCase();
};

export const AssigneeAvatar = (props: { pubkey: string; size?: number }) => {
  createRenderEffect(() => requestProfile(props.pubkey));
  const p = createMemo(() => profileFor(props.pubkey));
  const size = () => props.size ?? 20;
  const title = () => {
    const prof = p();
    return prof?.display_name ?? prof?.name ?? props.pubkey;
  };
  return (
    <span
      class="assignee-avatar"
      title={title()}
      style={{
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        width: `${size()}px`,
        height: `${size()}px`,
        "border-radius": "50%",
        border: "1px solid var(--color-ink-faint)",
        background: "var(--color-paper-raised)",
        overflow: "hidden",
        "vertical-align": "middle",
        "font-size": `${Math.max(9, Math.floor(size() * 0.42))}px`,
        "font-weight": "600",
        color: "var(--color-ink-soft)",
        "flex-shrink": "0",
      }}
    >
      <Show
        when={p()?.picture}
        fallback={<span>{initials(props.pubkey, p()?.display_name ?? p()?.name ?? null)}</span>}
      >
        {(url) => (
          <img
            src={url()}
            alt=""
            style={{ width: "100%", height: "100%", "object-fit": "cover", display: "block" }}
          />
        )}
      </Show>
    </span>
  );
};
