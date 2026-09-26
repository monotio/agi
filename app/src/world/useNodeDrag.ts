/**
 * Moving world-graph nodes: a pointer drag (a press only becomes a drag once
 * it travels a few pixels, so plain selection never dirties the layout) and
 * arrow-key nudges on a focused node, whose Enter or Space selects it.
 */
import type { RoomMap } from "../useRoomMap.ts";

export function useNodeDrag(deps: {
  map: Pick<RoomMap, "moveNode" | "previewNode">;
  positionOf: (room: number) => { x: number; y: number } | undefined;
  /** The user took the viewport: stop following the live room. */
  takeViewport: () => void;
  select: (room: number) => void;
}) {
  let dragging: {
    room: number;
    dx: number;
    dy: number;
    sx: number;
    sy: number;
    moved: boolean;
  } | null = null;

  function svgPoint(ev: PointerEvent): { x: number; y: number } {
    const svg = (ev.currentTarget as SVGGraphicsElement).ownerSVGElement!;
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const ctm = svg.getScreenCTM();
    const p = ctm ? pt.matrixTransform(ctm.inverse()) : pt;
    return { x: p.x, y: p.y };
  }

  function onNodePointerDown(ev: PointerEvent, room: number): void {
    const pos = deps.positionOf(room);
    if (!pos) return;
    const p = svgPoint(ev);
    dragging = {
      room,
      dx: p.x - pos.x,
      dy: p.y - pos.y,
      sx: ev.clientX,
      sy: ev.clientY,
      moved: false,
    };
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
  }

  function onNodePointerMove(ev: PointerEvent): void {
    if (!dragging) return;
    if ((ev.buttons & 1) === 0) {
      // Released outside the window: the captured pointerup never arrived.
      if (dragging.moved) {
        const p = svgPoint(ev);
        deps.map.moveNode(dragging.room, p.x - dragging.dx, p.y - dragging.dy);
      }
      dragging = null;
      return;
    }
    // A click is not a move: only once the pointer travels a few px does the
    // press become a drag, so plain selection never dirties the layout.
    if (
      !dragging.moved &&
      Math.abs(ev.clientX - dragging.sx) + Math.abs(ev.clientY - dragging.sy) < 4
    )
      return;
    dragging.moved = true;
    deps.takeViewport(); // a real drag owns the viewport from here on
    const p = svgPoint(ev);
    deps.map.previewNode(dragging.room, p.x - dragging.dx, p.y - dragging.dy);
  }

  function onNodePointerUp(ev: PointerEvent, room: number): void {
    if (!dragging || dragging.room !== room) return;
    if (dragging.moved) {
      const p = svgPoint(ev);
      deps.map.moveNode(room, p.x - dragging.dx, p.y - dragging.dy);
    }
    dragging = null;
  }

  /** Keyboard move: arrows nudge a focused node; Enter/Space select it. */
  function onNodeKeydown(ev: KeyboardEvent, room: number): void {
    const pos = deps.positionOf(room);
    if (!pos) return;
    const step = ev.shiftKey ? 40 : 10;
    const delta =
      ev.key === "ArrowLeft"
        ? [-step, 0]
        : ev.key === "ArrowRight"
          ? [step, 0]
          : ev.key === "ArrowUp"
            ? [0, -step]
            : ev.key === "ArrowDown"
              ? [0, step]
              : null;
    if (delta) {
      ev.preventDefault();
      deps.takeViewport();
      deps.map.moveNode(room, pos.x + delta[0]!, pos.y + delta[1]!);
      return;
    }
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      deps.select(room);
    }
  }

  return { onNodePointerDown, onNodePointerMove, onNodePointerUp, onNodeKeydown };
}
