// EFB-44 multi-select filter chip.
//
// One component rather than separate AssigneePicker/LabelPicker files: both
// pickers are "a chip that opens a checkbox list of {value,label}", and the
// only differences are the option source and the copy. The open/outside-click
// shape mirrors UserNav's menu.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export const FilterPicker = (props: {
  /** Chip text when nothing is selected. */
  label: string;
  options: ReadonlyArray<FilterOption>;
  selected: ReadonlyArray<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
  /** Shown in place of the list when there is nothing to pick from. */
  emptyLine: string;
}) => {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  const onDocClick = (e: MouseEvent) => {
    if (open() && root && !root.contains(e.target as Node)) setOpen(false);
  };
  onMount(() => document.addEventListener("mousedown", onDocClick));
  onCleanup(() => document.removeEventListener("mousedown", onDocClick));

  const count = () => props.selected.length;
  // The count carries the state, so the chip reads the same whether one or
  // twelve are picked — no truncated name soup in the header.
  const chipText = () => (count() === 0 ? props.label : `${props.label} · ${count()}`);

  return (
    <div class="filter-picker" ref={root}>
      <button
        type="button"
        class="filter-chip"
        classList={{ on: count() > 0 }}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        {chipText()}
      </button>
      <Show when={open()}>
        <div class="filter-menu" role="menu">
          <Show
            when={props.options.length > 0}
            fallback={<div class="filter-menu-empty">{props.emptyLine}</div>}
          >
            <For each={props.options}>
              {(opt) => (
                <label class="filter-menu-item">
                  <input
                    type="checkbox"
                    checked={props.selected.includes(opt.value)}
                    onChange={() => props.onToggle(opt.value)}
                  />
                  <span>{opt.label}</span>
                </label>
              )}
            </For>
          </Show>
          <Show when={count() > 0}>
            <button type="button" class="filter-menu-clear" onClick={() => props.onClear()}>
              Clear
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
};
