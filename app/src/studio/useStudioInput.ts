/**
 * How input reaches Room Studio's tools (useStudioTools.ts): the canvas's
 * pointer (the active tool first, then selection and dragging), Space held
 * to pan, the rail's letters, and the keyboard cursor, which makes every
 * drawing tool and the pipette work without a pointer (WCAG 2.5.7).
 *
 * On the focused canvas the cursor sits at one logical pixel: where the
 * pointer last was, else the centre. Arrows move it 1 px (Shift: 8) and
 * Space or Enter clicks there: a line or polygon point (Enter on the last
 * point finishes it), a rect's start and then its end, a fill seed, the
 * brush's pen down and then up (moving while it is down paints), a pipette
 * pick. Esc cancels, as for the pointer. The cursor shows while the keys
 * drive the canvas: from a keyboard focus or an arrow until the pointer
 * next moves or presses on the picture.
 */

import { computed, shallowRef, watch } from "vue";
import type { Point } from "../../../src/studio/shapes.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import type { ViewportPoint } from "../../../src/studio/viewport.ts";
import type { PanePress } from "./StudioCanvas.vue";
import { TOOL_KEYS, type StudioTool } from "./studioTools.ts";
import type { StudioSelection } from "./useStudioSelection.ts";
import type { StudioTools } from "./useStudioTools.ts";

/** What the canvas does with a press when no tool takes it: select and drag. */
export interface PointerFallback {
  press(press: PanePress): void;
  drag(press: PanePress): void;
  release(press: PanePress): void;
  abort(): void;
}

export interface StudioInputOptions {
  readonly tools: StudioTools;
  /**
   * Its `canvasCell` becomes the cell under the pointer or the keyboard
   * cursor; its announcement shares the live region with the cursor.
   */
  readonly selection: Pick<StudioSelection, "canvasCell" | "announcement">;
  /** What a press no tool takes does: select and drag. */
  readonly fallback: PointerFallback;
  /** The focusable canvas stage. */
  readonly stage: () => HTMLElement | null;
  /** G: show or hide the actor probe. */
  readonly probe?: () => void;
}

/** Tools the keyboard cursor drives. */
const CURSOR_TOOLS: readonly StudioTool[] = ["line", "rect", "polygon", "fill", "brush", "pipette"];
const CENTRE: Point = { x: SCREEN_WIDTH / 2, y: SCREEN_HEIGHT / 2 };
const onSurface = ({ x, y }: Point): Point => ({
  x: Math.min(SCREEN_WIDTH - 1, Math.max(0, x)),
  y: Math.min(SCREEN_HEIGHT - 1, Math.max(0, y)),
});
const CANVAS_SELECT =
  "Canvas. Click an item to select it; drag it or its handles to edit. Arrow keys nudge the selection 1 pixel (Shift: 8); Alt+arrows step through items in draw order.";
const CANVAS_DRAW =
  "Canvas. Arrow keys move the drawing cursor 1 pixel (Shift: 8); Space or Enter clicks at it; Escape cancels.";

export function useStudioInput(options: StudioInputOptions) {
  const { tools, selection, fallback } = options;
  /** The keyboard cursor's cell: it follows the pointer, and the arrows move it. */
  const cell = shallowRef<Point>(CENTRE);
  /** The keys drive the canvas, not the pointer. */
  const keyboard = shallowRef(false);
  const active = computed(() => CURSOR_TOOLS.includes(tools.tool.value));
  /** The polite live region: the latest of the selection's words and the cursor's. */
  const spoken = shallowRef(selection.announcement.value);
  watch(selection.announcement, (text) => (spoken.value = text));

  /** The keys take the canvas: the cursor shows where the pointer last was. */
  function take(): void {
    if (keyboard.value) return;
    keyboard.value = true;
    tools.hover(cell.value);
    selection.canvasCell.value = cell.value;
  }

  /** An arrow on the canvas; false when the tool takes no cursor (the arrows nudge). */
  function move(dx: number, dy: number): boolean {
    if (!active.value) return false;
    take();
    const next = onSurface({ x: cell.value.x + dx, y: cell.value.y + dy });
    cell.value = next;
    tools.hover(next);
    tools.dragTo(next, false);
    selection.canvasCell.value = next;
    spoken.value = `x ${next.x} y ${next.y}`;
    return true;
  }

  /** Space or Enter on the canvas: a click at the cursor; false when the tool takes none. */
  function click(enter: boolean): boolean {
    if (!active.value) return false;
    take();
    const at = cell.value;
    const tool = tools.tool.value;
    if (tools.rect.value || tools.stroke.value) {
      tools.settleDrag();
      if (tool === "brush") spoken.value = "Pen up";
      return true;
    }
    const last = tools.path.value?.tool === tool ? tools.path.value.points.at(-1) : undefined;
    if (enter && last?.x === at.x && last.y === at.y) tools.finish();
    else tools.pressAt(at, false);
    if (tools.stroke.value) spoken.value = `Pen down at x ${at.x} y ${at.y}`;
    else if (tools.rect.value) spoken.value = `Rect from x ${at.x} y ${at.y}`;
    return true;
  }

  /** The canvas took focus (by keyboard, the cursor shows) or lost it. */
  function focus(event: FocusEvent): void {
    if ((event.target as Element).matches(":focus-visible")) take();
  }
  function blur(): void {
    if (keyboard.value) selection.canvasCell.value = undefined;
    keyboard.value = false;
  }

  /**
   * Space on the studio pans with any tool while held, except on a control
   * it would press, and on the canvas while the keys drive a cursor tool:
   * there it clicks (studioKeys.ts).
   */
  function spaceKey(event: KeyboardEvent, down: boolean): boolean {
    if (event.key !== " " || event.metaKey || event.ctrlKey || event.altKey) return false;
    const target = event.target as Element | null;
    if (down && target?.closest("button, input, select, textarea, [role=radio], [role=treeitem]"))
      return false;
    if (down && keyboard.value && active.value && target !== null && target === options.stage())
      return false;
    tools.spaceHeld.value = down;
    return true;
  }

  /** A rail letter (lower-cased): pick its tool, or toggle the probe; false for other keys. */
  function shortcut(key: string): boolean {
    const next = TOOL_KEYS[key];
    if (next === "probe") options.probe?.();
    else if (next) tools.setTool(next);
    return next !== undefined;
  }

  /** The canvas's pointer input: the active tool takes it first, then `fallback` (selection and drags). */
  const pointer = {
    press: (pressed: PanePress) => {
      keyboard.value = false;
      if (!tools.press(pressed)) fallback.press(pressed);
    },
    drag: (pressed: PanePress) => {
      tools.drag(pressed);
      fallback.drag(pressed);
    },
    release: (pressed: PanePress) => {
      tools.release(pressed);
      fallback.release(pressed);
    },
    abort: () => {
      tools.abort();
      fallback.abort();
    },
    hover: (at: ViewportPoint | undefined) => {
      // The pointer moving over the picture takes the canvas back from the keys.
      if (at) {
        keyboard.value = false;
        cell.value = onSurface(at);
      }
      selection.canvasCell.value = at;
      tools.hover(at);
    },
  };

  return {
    cell,
    keyboard,
    spoken,
    /** StudioToolOverlay's props: the tools' own, and the crosshair while the keys drive. */
    overlay: computed(() => ({
      ...tools.overlay.value,
      crosshair: keyboard.value && active.value ? cell.value : null,
    })),
    /** The canvas's accessible name, with the keys the active tool takes. */
    label: computed(() => (active.value ? CANVAS_DRAW : CANVAS_SELECT)),
    move,
    click,
    focus,
    blur,
    spaceKey,
    shortcut,
    pointer,
  };
}

export type StudioInput = ReturnType<typeof useStudioInput>;
