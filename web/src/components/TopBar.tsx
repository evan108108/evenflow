// TopBar — persistent app anchor. Butterfly mark + small "Evenflow"
// wordmark on the left (links to /boards), an optional breadcrumb in the
// middle, and the UserNav avatar+org+account dropdown on the right.
// Rendered by every signed-in surface so the anchor and account controls
// never move.

import { For, Show } from "solid-js";
import butterflyMark from "../assets/butterfly-logo.svg?raw";
import { UserNav } from "./UserNav";

/** The one-line butterfly, inlined so its stroke inherits currentColor. */
export const ButterflyMark = (props: { class?: string }) => (
  <span class={props.class ?? "topbar-mark"} aria-hidden="true" innerHTML={butterflyMark} />
);

export interface Crumb {
  readonly label: string;
  /** When present, the segment is a link. */
  readonly href?: string;
}

/**
 * `home` exists because the brand cannot always point at /boards.
 *
 * /boards is behind auth. On the app's own pages that is right — you are
 * signed in, and the boards list is home. On the PUBLIC docs it is a dead
 * end: a signed-out reader clicks the logo and lands on a login wall, which
 * is the one thing documentation must never do to someone who came to read
 * it. Docs pass "/" — the landing page, which is public.
 *
 * Defaulted rather than required so every existing caller keeps its
 * behaviour unchanged.
 */
export const TopBar = (props: { crumbs?: readonly Crumb[]; home?: string }) => (
  <div class="topbar">
    <a class="topbar-brand serif" href={props.home ?? "/boards"}>
      <ButterflyMark />
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
