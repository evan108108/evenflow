// Minimal pointer-event drag-and-drop, written in-house.
//
// @thisbeyond/solid-dnd was evaluated and passed over: last published
// 2023-11, and our need is only "drag a card onto a zone" — no sortable
// reordering. ~100 lines of pointer handling beats a two-year-stale
// dependency.
//
// Protocol: cards call startDrag() from their pointerdown; drop targets are
// any element carrying data-dropzone="<zone>". A press that never travels
// more than DRAG_THRESHOLD_PX is a click (the card's onClick fires instead),
// so dragging and opening the issue sheet share one gesture surface.

import { createSignal } from "solid-js";

const DRAG_THRESHOLD_PX = 6;
// Edge-scroll: while dragging, if the pointer sits within EDGE_PX of the top
// or bottom of the viewport, scroll the page by up to MAX_SPEED_PX per frame
// (scaled by how close to the edge the pointer is). Same for the nearest
// scrollable ancestor of the element under the pointer, so vertical Kanban
// rails and modals with their own scroll surface also auto-scroll.
const EDGE_PX = 60;
const MAX_SPEED_PX = 22;

export interface DndHandle {
  /** Issue id currently being dragged, null when idle. */
  readonly draggingId: () => string | null;
  /** Zone under the pointer right now (data-dropzone value). */
  readonly overZone: () => string | null;
  /** Pointer position, for the floating ghost. */
  readonly pos: () => { x: number; y: number };
  readonly startDrag: (e: PointerEvent, id: string, onClick: () => void) => void;
}

const scrollableAncestor = (el: Element | null): Element | null => {
  let node: Element | null = el;
  while (node !== null && node !== document.body) {
    const style = window.getComputedStyle(node);
    const canScrollY =
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight;
    if (canScrollY) return node;
    node = node.parentElement;
  }
  return null;
};

export const createDnd = (onDrop: (id: string, zone: string) => void): DndHandle => {
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [overZone, setOverZone] = createSignal<string | null>(null);
  const [pos, setPos] = createSignal({ x: 0, y: 0 });

  const startDrag = (e: PointerEvent, id: string, onClick: () => void) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    let lastY = e.clientY;
    let lastX = e.clientX;
    let scrollRaf: number | null = null;

    const stopScroll = () => {
      if (scrollRaf !== null) {
        cancelAnimationFrame(scrollRaf);
        scrollRaf = null;
      }
    };

    const tickScroll = () => {
      scrollRaf = null;
      if (!active) return;
      const vh = window.innerHeight;
      // Window scroll based on distance from top/bottom edges.
      let winDy = 0;
      if (lastY < EDGE_PX) winDy = -Math.ceil(((EDGE_PX - lastY) / EDGE_PX) * MAX_SPEED_PX);
      else if (lastY > vh - EDGE_PX) winDy = Math.ceil(((lastY - (vh - EDGE_PX)) / EDGE_PX) * MAX_SPEED_PX);
      if (winDy !== 0) window.scrollBy(0, winDy);
      // Also scroll the nearest scrollable ancestor of the element under the
      // pointer (vertical Kanban rail, modal body). Element-local edge check.
      const under = document.elementFromPoint(lastX, lastY);
      const scroller = scrollableAncestor(under);
      if (scroller !== null) {
        const r = scroller.getBoundingClientRect();
        let ancDy = 0;
        if (lastY - r.top < EDGE_PX) {
          ancDy = -Math.ceil(((EDGE_PX - (lastY - r.top)) / EDGE_PX) * MAX_SPEED_PX);
        } else if (r.bottom - lastY < EDGE_PX) {
          ancDy = Math.ceil(((EDGE_PX - (r.bottom - lastY)) / EDGE_PX) * MAX_SPEED_PX);
        }
        if (ancDy !== 0) scroller.scrollTop += ancDy;
      }
      if (winDy !== 0 || (scroller !== null)) scrollRaf = requestAnimationFrame(tickScroll);
    };

    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_THRESHOLD_PX) {
        active = true;
        setDraggingId(id);
      }
      if (!active) return;
      ev.preventDefault();
      lastX = ev.clientX;
      lastY = ev.clientY;
      setPos({ x: ev.clientX, y: ev.clientY });
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const zoneEl = under?.closest("[data-dropzone]") ?? null;
      let zone = zoneEl?.getAttribute("data-dropzone") ?? null;
      // Card zones resolve to an insertion slot: top half = before that
      // card, bottom half = after it. The half rides in the zone string so
      // both the drop handler and the indicator styling read one value.
      if (zone !== null && zone.startsWith("card:") && zoneEl !== null) {
        const rect = zoneEl.getBoundingClientRect();
        zone = `${zone}:${ev.clientY < rect.top + rect.height / 2 ? "before" : "after"}`;
      }
      setOverZone(zone);
      // Kick off an edge-scroll animation if we're in the danger zone. The
      // tick reschedules itself while it's still scrolling something.
      if (scrollRaf === null) scrollRaf = requestAnimationFrame(tickScroll);
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      stopScroll();
      const zone = overZone();
      const wasDrag = active;
      setDraggingId(null);
      setOverZone(null);
      if (!wasDrag) onClick();
      else if (zone !== null) onDrop(id, zone);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return { draggingId, overZone, pos, startDrag };
};

/** Zone string builders — keep the encoding in one place. */
export const transitionZone = (column: string) => `transition:${column}`;
export const moveZone = (action: string) => `move:${action}`;
/** A card's own zone; the dnd move handler appends `:before` / `:after`. */
export const cardZone = (column: string, issue: string) => `card:${column}:${issue}`;
/** A sprint section in the Backlog view — dropping adds the issue to it. */
export const sprintZone = (sprint: string) => `sprint:${sprint}`;

export const parseZone = (
  zone: string,
):
  | { type: "transition"; column: string }
  | { type: "move"; action: string }
  | { type: "card"; column: string; issue: string; half: "before" | "after" }
  | { type: "sprint"; sprint: string }
  | null => {
  if (zone.startsWith("transition:")) return { type: "transition", column: zone.slice(11) };
  if (zone.startsWith("move:")) return { type: "move", action: zone.slice(5) };
  if (zone.startsWith("sprint:")) return { type: "sprint", sprint: zone.slice(7) };
  if (zone.startsWith("card:")) {
    const [, column, issue, half] = zone.split(":");
    if (column === undefined || issue === undefined || (half !== "before" && half !== "after")) {
      return null;
    }
    return { type: "card", column, issue, half };
  }
  return null;
};
