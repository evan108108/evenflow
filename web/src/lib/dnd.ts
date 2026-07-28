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

export interface DndHandle {
  /** Issue id currently being dragged, null when idle. */
  readonly draggingId: () => string | null;
  /** Zone under the pointer right now (data-dropzone value). */
  readonly overZone: () => string | null;
  /** Pointer position, for the floating ghost. */
  readonly pos: () => { x: number; y: number };
  readonly startDrag: (e: PointerEvent, id: string, onClick: () => void) => void;
}

export const createDnd = (onDrop: (id: string, zone: string) => void): DndHandle => {
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [overZone, setOverZone] = createSignal<string | null>(null);
  const [pos, setPos] = createSignal({ x: 0, y: 0 });

  const startDrag = (e: PointerEvent, id: string, onClick: () => void) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;

    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_THRESHOLD_PX) {
        active = true;
        setDraggingId(id);
      }
      if (!active) return;
      ev.preventDefault();
      setPos({ x: ev.clientX, y: ev.clientY });
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const zoneEl = under?.closest("[data-dropzone]") ?? null;
      setOverZone(zoneEl?.getAttribute("data-dropzone") ?? null);
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
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

export const parseZone = (
  zone: string,
): { type: "transition"; column: string } | { type: "move"; action: string } | null => {
  if (zone.startsWith("transition:")) return { type: "transition", column: zone.slice(11) };
  if (zone.startsWith("move:")) return { type: "move", action: zone.slice(5) };
  return null;
};
