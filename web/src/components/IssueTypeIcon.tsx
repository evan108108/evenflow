// IssueTypeIcon — six inline SVG line marks, one per issue type. Strokes
// inherit currentColor so the icons follow the surrounding text color in
// both theme moods; no fills, 1.5px line weight, 14px default.

import { Switch, Match } from "solid-js";
import type { IssueType } from "../lib/columns";

export const IssueTypeIcon = (props: { type: IssueType; size?: number }) => (
  <svg
    class="issue-type-icon"
    data-type={props.type}
    width={props.size ?? 14}
    height={props.size ?? 14}
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <Switch>
      {/* hollow square with a check inside */}
      <Match when={props.type === "task"}>
        <rect x="1.75" y="1.75" width="10.5" height="10.5" rx="1.5" />
        <path d="M4.5 7.2 L6.3 9 L9.5 5.2" />
      </Match>
      {/* thin diamond outline */}
      <Match when={props.type === "feature"}>
        <path d="M7 1.5 L12.5 7 L7 12.5 L1.5 7 Z" />
      </Match>
      {/* small circle with 4 short antennae/legs */}
      <Match when={props.type === "bug"}>
        <circle cx="7" cy="7.5" r="3.25" />
        <path d="M4.6 5.2 L3 3.6" />
        <path d="M9.4 5.2 L11 3.6" />
        <path d="M4.1 9.4 L2.4 10.6" />
        <path d="M9.9 9.4 L11.6 10.6" />
      </Match>
      {/* thin book/tome outline */}
      <Match when={props.type === "story"}>
        <path d="M7 3 C5.8 1.9, 3.6 1.9, 2 2.6 L2 11.4 C3.6 10.7, 5.8 10.7, 7 11.8 C8.2 10.7, 10.4 10.7, 12 11.4 L12 2.6 C10.4 1.9, 8.2 1.9, 7 3 Z" />
        <path d="M7 3 L7 11.8" />
      </Match>
      {/* upward chevron above a baseline */}
      <Match when={props.type === "improvement"}>
        <path d="M3 8.2 L7 4.2 L11 8.2" />
        <path d="M3 11.5 L11 11.5" />
      </Match>
      {/* three horizontal lines (stacked list) */}
      <Match when={props.type === "chore"}>
        <path d="M2.5 3.75 L11.5 3.75" />
        <path d="M2.5 7 L11.5 7" />
        <path d="M2.5 10.25 L11.5 10.25" />
      </Match>
    </Switch>
  </svg>
);
