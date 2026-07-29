// TopBar — persistent app anchor. Small "Evenflow" wordmark on the left
// (links to /boards), an optional breadcrumb in the middle, and the
// UserNav avatar+org+account dropdown on the right. Rendered by every
// signed-in surface so the anchor and account controls never move.

import { For, Show } from "solid-js";
import { UserNav } from "./UserNav";

export interface Crumb {
  readonly label: string;
  /** When present, the segment is a link. */
  readonly href?: string;
}

export const TopBar = (props: { crumbs?: readonly Crumb[] }) => (
  <div class="topbar">
    <a class="topbar-brand serif" href="/boards">
      Evenflow
    </a>
    <Show when={(props.crumbs?.length ?? 0) > 0}>
      <nav class="topbar-crumbs muted" aria-label="Breadcrumb">
        <For each={props.crumbs}>
          {(c, i) => (
            <>
              <Show when={i() > 0}>
                <span class="topbar-crumb-sep" aria-hidden="true">
                  /
                </span>
              </Show>
              <Show when={c.href} fallback={<span>{c.label}</span>}>
                <a href={c.href}>{c.label}</a>
              </Show>
            </>
          )}
        </For>
      </nav>
    </Show>
    <div class="topbar-spacer" />
    <UserNav />
  </div>
);
