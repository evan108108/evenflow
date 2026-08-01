// EFB-67 v2 — the mobile board header, as a separate component.
//
// ── WHY A SEPARATE COMPONENT AND A MEDIA QUERY ───────────────────────────
//
// v1 kept one JSX tree and chose its shape in JS:
//
//     const [viewportWidth] = createSignal(window.innerWidth);
//     const mobileHeader = () => isMobileHeader(viewportWidth());
//
// That is correct-looking and does not work, for a reason that has nothing to
// do with the header. Measured on prod at a 393px iPhone viewport:
//
//     document.documentElement.clientWidth : 393    <- the layout viewport
//     window.visualViewport.width          : 393
//     matchMedia("(max-width: 768px)")     : true
//     window.innerWidth                    : 792    <- lies
//     document.body.scrollWidth            : 791
//
// `.tabs-row` overflowed the page, and Chromium reports `window.innerWidth` as
// the SCROLLABLE width once a document overflows horizontally. So on a real
// phone `isMobileHeader(792)` returned false and the DESKTOP header rendered —
// which is what Evan saw. The predicate was right; the number it was fed was
// corrupted by a CSS bug three files away.
//
// A CSS media query cannot be fooled that way: it keys off the layout viewport
// by construction. That is why this is the right primitive even now that
// `.tabs-row` is fixed — a layout that only works while nothing else overflows
// is the same trap wearing a different hat.
//
// ── THE DUPLICATION IS DELIBERATE ────────────────────────────────────────
//
// The signed-out / read-only conditions below are restated from BoardHeader
// rather than shared, which is the cost Evan chose knowingly. Keep them in
// sync with the desktop header in BoardPage.tsx: `orgHandle() && !readOnly` for
// Settings, `!readOnly` for New issue, and Sprint history unconditional because
// it is a read-only view a signed-out visitor on a public board may open
// (EFB-47). `signedOutBoard.test.tsx` asserts both headers together.

import { Show } from "solid-js";

export interface MobileBoardHeaderProps {
  readonly title: string;
  readonly issuePrefix: string | null;
  /** Board base path, e.g. `/@handle/board`. */
  readonly base: string;
  /** Null when the board resolves to no org — Settings is unreachable then. */
  readonly orgHandle: string | null;
  readonly readOnly: boolean;
  readonly onNewIssue: () => void;
}

export const MobileBoardHeader = (props: MobileBoardHeaderProps) => (
  <header class="board-header-mobile">
    {/* Row: title. One line, truncated — the full name is also in the top bar
        and the URL, so clipping here costs nothing a user cannot recover. */}
    <div class="mbh-title-row">
      <h1 class="mbh-title">{props.title}</h1>
      <Show when={props.issuePrefix}>
        {(prefix) => <span class="prefix-chip">{prefix()}</span>}
      </Show>
    </div>

    {/* Row: actions. Sized to content — v1's `+ New issue` took `flex: 1 1 auto`
        inside a wrapped row and rendered as a full-height slab. */}
    <div class="mbh-actions">
      <Show when={!props.readOnly}>
        <button class="btn btn-solid mbh-new" onClick={props.onNewIssue}>
          + New issue
        </button>
      </Show>
      {/* Icon-only controls keep an accessible name. `title` alone is not one
          on a touch device, where there is no hover to reveal it. */}
      <a class="btn mbh-icon-btn" href={`${props.base}/sprints`} title="Sprint history">
        <span class="btn-icon" aria-hidden="true">
          ▦
        </span>
        <span class="sr-only">Sprint controls</span>
      </a>
      <Show when={props.orgHandle && !props.readOnly}>
        <a class="btn mbh-icon-btn" href={`${props.base}/settings`} title="Board settings">
          <span class="btn-icon" aria-hidden="true">
            ⚙
          </span>
          <span class="sr-only">Board settings</span>
        </a>
      </Show>
    </div>
  </header>
);
