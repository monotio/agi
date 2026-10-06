/**
 * Sprite Studio's tool rail at work on one cel. Pencil and eraser strokes,
 * lines, rects and selection moves are each one gesture whose preview is
 * the kernel's own candidate (useSpriteDraft `moveGesture`), so what the
 * canvas shows is what Keep writes; fill, flip and the selection's delete
 * and flip are single edits. The eraser writes transparency; no tool paints
 * the transparent colour.
 *
 * Every tool works from the keyboard as well as the pointer, as in Room
 * Studio (useStudioInput.ts): on the focused canvas the arrows move a cursor
 * one pixel (Shift: 8) and Space or Enter clicks at it — a fill seed, a
 * pipette pick, the pencil's pen down and then up (moving while it is down
 * paints), a line's, rect's or selection's first corner and then its last.
 * With a selection made, the arrows move it instead (Alt: a copy), Delete
 * clears it and H flips it. Esc cancels what is being drawn, then drops the
 * selection, then puts the recolour tool away.
 *
 * The recolour tool (C) swaps one colour for another over the cel, the loop
 * or the view (SpriteRecolor.vue); a click on the canvas picks the colour it
 * changes (`recolorFrom`).
 */

import { computed, shallowRef, watch, type Ref } from "vue";
import type { SpriteCel } from "../../../../src/view/spriteDocument.ts";
import type { SpriteEdit } from "../../../../src/studio/sprite/spriteOperations.ts";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
import type { StudioNotice } from "../useStudioNotice.ts";
import {
  clearSelectionChanges,
  clipRect,
  flipSelectionChanges,
  linePoints,
  moveSelectionChanges,
  paintChanges,
  rectBetween,
  rectOutline,
  type CelPoint,
  type CelRect,
} from "./spriteView.ts";
import type { SpriteDraft, SpriteOutcome } from "./useSpriteDraft.ts";

export type SpriteTool =
  "pencil" | "eraser" | "fill" | "line" | "rect" | "select" | "pipette" | "recolor";

/** The rail's single-letter shortcuts; H flips (the selection, else the cel) and is not a tool. */
export const SPRITE_TOOL_KEYS: Record<string, SpriteTool | "flip"> = {
  b: "pencil",
  e: "eraser",
  g: "fill",
  l: "line",
  r: "rect",
  m: "select",
  i: "pipette",
  c: "recolor",
  h: "flip",
};

/** Shift+arrow moves this far. */

const LABELS: Record<SpriteTool, string> = {
  pencil: "Pencil",
  eraser: "Erase",
  fill: "Fill",
  line: "Line",
  rect: "Rect",
  select: "Move selection",
  pipette: "Pick colour",
  recolor: "Recolour",
};

export interface SpriteToolsOptions {
  readonly draft: SpriteDraft;
  /** The cel being edited. */
  readonly loop: Ref<number>;
  readonly cel: Ref<number>;
  /** Edit the loop's whole linked group ("Edit loop N instead"); off, edits copy on write. */
  readonly propagate: () => boolean;
  /** The loops an edit of the current loop may change. */
  readonly targets: () => readonly number[];
  /** The paint colour, 0..15. */
  readonly color: Ref<number>;
  /** An accepted or refused edit, for the stage's notice. */
  readonly report: (outcome: SpriteOutcome) => void;
  readonly say: (notice: StudioNotice | null) => void;
  /** Editing is blocked: tools do nothing. */
  readonly frozen: () => boolean;
}

interface Stroke {
  readonly tool: "pencil" | "eraser";
  readonly points: CelPoint[];
}

interface Move {
  readonly from: CelPoint;
  readonly copy: boolean;
  readonly offset: CelPoint;
}

export function useSpriteTools(options: SpriteToolsOptions) {
  const { draft, loop, cel, color } = options;
  const tool = shallowRef<SpriteTool>("pencil");
  /** The tool the recolour tool was opened from, to return to when it is put away. */
  let beforeRecolor: SpriteTool = "pencil";
  /** The colour the recolour tool changes; null until one is picked. */
  const recolorFrom = shallowRef<number | null>(null);
  /** The cel cell under the pointer or the keyboard cursor. */
  const cursor = shallowRef<CelPoint | undefined>();
  /** The keys drive the canvas: the cursor shows. */
  const keyboard = shallowRef(false);
  /** A line's, rect's or marquee's first corner while it is being drawn. */
  const anchor = shallowRef<CelPoint | null>(null);
  const stroke = shallowRef<Stroke | null>(null);
  /** The selection on the current cel. */
  const selection = shallowRef<CelRect | null>(null);
  const move = shallowRef<Move | null>(null);

  /** The cel as the document holds it (the gesture's start while one runs). */
  const current = computed<SpriteCel | undefined>(
    () => draft.document.value.loops[loop.value]?.cels[cel.value],
  );
  const busy = computed(
    () => stroke.value !== null || anchor.value !== null || move.value !== null,
  );
  /**
   * The pen is down: a pencil or eraser stroke is open until the pointer's
   * button comes up or the next Space or Enter lifts it (Escape cancels).
   * Its only trace may be one pixel, so the stage shows a cue meanwhile.
   */
  const penDown = computed(() => stroke.value !== null);

  const at = (): { loop: number; cel: number; propagate: boolean } => ({
    loop: loop.value,
    cel: cel.value,
    propagate: options.propagate(),
  });
  const change = (op: SpriteEdit) => ({ op, targets: options.targets() });
  const pixels = (changes: ReturnType<typeof paintChanges>): SpriteEdit => ({
    type: "setPixels",
    ...at(),
    changes,
  });

  function blocked(): boolean {
    if (!options.frozen()) return false;
    options.say({ tone: "warn", text: "This actor is read-only." });
    return true;
  }

  /** The edit the open gesture would make, from the document it started on. */
  function gestureOp(to: CelPoint): SpriteEdit | null {
    const base = current.value;
    if (!base) return null;
    const s = stroke.value;
    if (s) return pixels(paintChanges(base, s.points, s.tool === "eraser" ? null : color.value));
    const m = move.value;
    if (m && selection.value)
      return pixels(moveSelectionChanges(base, selection.value, m.offset.x, m.offset.y, m.copy));
    const a = anchor.value;
    if (a && (tool.value === "line" || tool.value === "rect")) {
      const points = tool.value === "line" ? linePoints(a, to) : rectOutline(rectBetween(a, to));
      return pixels(paintChanges(base, points, color.value));
    }
    return null;
  }

  function preview(to: CelPoint): void {
    const op = gestureOp(to);
    if (op && draft.gesturing.value) options.report(draft.moveGesture(change(op)));
  }

  function finishGesture(to: CelPoint): void {
    const op = gestureOp(to);
    const outcome = draft.endGesture(op && change(op), LABELS[tool.value]);
    if (op) options.report(outcome);
  }

  function inside(rect: CelRect | null, point: CelPoint): boolean {
    return (
      rect !== null &&
      point.x >= rect.x &&
      point.y >= rect.y &&
      point.x < rect.x + rect.width &&
      point.y < rect.y + rect.height
    );
  }

  /** The active tool's press at `point` (`alt`: copy a selection move). */
  function pressAt(point: CelPoint, alt = false): void {
    const base = current.value;
    if (!base) return;
    switch (tool.value) {
      case "recolor": {
        const onCel = point.x >= 0 && point.y >= 0 && point.x < base.width && point.y < base.height;
        if (!onCel) return;
        const value = base.pixels[point.y * base.width + point.x]!;
        // The popover's live count says what was picked.
        if (value !== base.transparent) recolorFrom.value = value;
        else
          options.say({
            tone: "warn",
            text: "That pixel is transparent: pick a coloured pixel to recolour.",
          });
        return;
      }
      case "pipette": {
        const onCel = point.x >= 0 && point.y >= 0 && point.x < base.width && point.y < base.height;
        if (!onCel) return;
        const value = base.pixels[point.y * base.width + point.x]!;
        if (value === base.transparent) {
          setTool("eraser");
          options.say({ tone: "ok", text: "That pixel is transparent: the eraser is on." });
        } else {
          color.value = value;
          options.say({ tone: "ok", text: `Picked colour ${value}, ${EGA_COLOUR_NAMES[value]}.` });
        }
        return;
      }
      case "fill": {
        if (blocked()) return;
        const onCel = point.x >= 0 && point.y >= 0 && point.x < base.width && point.y < base.height;
        if (!onCel) return;
        const op: SpriteEdit = {
          type: "fillCel",
          ...at(),
          x: point.x,
          y: point.y,
          color: color.value,
        };
        options.report(draft.apply(change(op), LABELS.fill));
        return;
      }
      case "pencil":
      case "eraser":
        if (blocked()) return;
        draft.beginGesture(LABELS[tool.value]);
        stroke.value = { tool: tool.value, points: [point] };
        preview(point);
        return;
      case "line":
      case "rect":
        if (blocked()) return;
        if (anchor.value) {
          finishGesture(point);
          anchor.value = null;
          return;
        }
        draft.beginGesture(LABELS[tool.value]);
        anchor.value = point;
        preview(point);
        return;
      case "select":
        if (anchor.value) {
          selection.value = clipRect(rectBetween(anchor.value, point), base);
          anchor.value = null;
          return;
        }
        if (inside(selection.value, point)) {
          if (blocked()) return;
          draft.beginGesture(LABELS.select);
          move.value = { from: point, copy: alt, offset: { x: 0, y: 0 } };
          return;
        }
        selection.value = null;
        anchor.value = point;
        return;
    }
  }

  /** The pointer or the cursor moved to `point` with the button (or pen) down. */
  function dragTo(point: CelPoint): void {
    const s = stroke.value;
    if (s) {
      const last = s.points.at(-1)!;
      if (last.x === point.x && last.y === point.y) return;
      s.points.push(...linePoints(last, point).slice(1));
      preview(point);
      return;
    }
    const m = move.value;
    if (m) {
      move.value = { ...m, offset: { x: point.x - m.from.x, y: point.y - m.from.y } };
      preview(point);
      return;
    }
    if (anchor.value && tool.value !== "select") preview(point);
  }

  /** The pointer's button came up at `point`. */
  function release(point: CelPoint): void {
    if (stroke.value) {
      finishGesture(point);
      stroke.value = null;
      return;
    }
    const m = move.value;
    if (m) {
      const offset = { x: point.x - m.from.x, y: point.y - m.from.y };
      move.value = { ...m, offset };
      finishGesture(point);
      move.value = null;
      if (selection.value && (offset.x !== 0 || offset.y !== 0))
        selection.value = {
          ...selection.value,
          x: selection.value.x + offset.x,
          y: selection.value.y + offset.y,
        };
      return;
    }
    // A drag from the first corner ends the shape where the button comes up;
    // a click without moving leaves the corner for a second click.
    const a = anchor.value;
    if (a && (a.x !== point.x || a.y !== point.y)) pressAt(point);
  }

  /** Esc: abandon what is being drawn, then the selection. Returns whether anything was. */
  function cancel(): boolean {
    if (busy.value) {
      if (draft.gesturing.value) draft.cancelGesture();
      stroke.value = null;
      anchor.value = null;
      move.value = null;
      return true;
    }
    if (selection.value) {
      selection.value = null;
      return true;
    }
    return false;
  }

  function setTool(next: SpriteTool): void {
    if (next === tool.value) return;
    cancel();
    if (next !== "select") selection.value = null;
    if (next === "recolor") beforeRecolor = tool.value;
    tool.value = next;
  }

  /** Put the recolour tool away, back to the tool it was opened from; false when it was not out. */
  function closeRecolor(): boolean {
    if (tool.value !== "recolor") return false;
    setTool(beforeRecolor);
    return true;
  }

  /** H: flip the selection left to right, else the whole cel. */
  function flip(): void {
    const base = current.value;
    if (!base || blocked()) return;
    const area = selection.value;
    const op: SpriteEdit = area
      ? pixels(flipSelectionChanges(base, area))
      : { type: "flipCel", ...at(), axis: "h" };
    options.report(draft.apply(change(op), "Flip"));
  }

  /** Delete: clear the selection to transparent; false without one. */
  function clearSelection(): boolean {
    const base = current.value;
    const area = selection.value;
    if (!base || !area) return false;
    if (blocked()) return true;
    options.report(draft.apply(change(pixels(clearSelectionChanges(base, area))), "Delete"));
    return true;
  }

  /** Arrows with a selection: move it (Alt: a copy) one step. False without a selection. */
  function nudgeSelection(dx: number, dy: number, copy: boolean): boolean {
    const base = current.value;
    const area = selection.value;
    if (tool.value !== "select" || !base || !area || anchor.value || move.value) return false;
    if (blocked()) return true;
    const outcome = draft.apply(
      change(pixels(moveSelectionChanges(base, area, dx, dy, copy))),
      copy ? "Copy selection" : LABELS.select,
    );
    options.report(outcome);
    if (outcome.ok) selection.value = { ...area, x: area.x + dx, y: area.y + dy };
    return true;
  }

  const onCel = (point: CelPoint): CelPoint => {
    const base = current.value;
    return base
      ? {
          x: Math.min(base.width - 1, Math.max(0, point.x)),
          y: Math.min(base.height - 1, Math.max(0, point.y)),
        }
      : point;
  };

  /** An arrow on the canvas: the selection moves, else the cursor (and a stroke or shape with it). */
  function arrow(dx: number, dy: number, alt: boolean): void {
    if (nudgeSelection(dx, dy, alt)) return;
    const base = current.value;
    if (!base) return;
    keyboard.value = true;
    const from = cursor.value ?? {
      x: Math.floor(base.width / 2),
      y: Math.floor(base.height / 2),
    };
    const next = onCel({ x: from.x + dx, y: from.y + dy });
    cursor.value = next;
    dragTo(next);
  }

  /** Space or Enter on the canvas: a click at the cursor; a pen down lifts. */
  function click(): void {
    const base = current.value;
    if (!base) return;
    keyboard.value = true;
    const point = cursor.value ?? {
      x: Math.floor(base.width / 2),
      y: Math.floor(base.height / 2),
    };
    cursor.value = point;
    if (stroke.value || move.value) {
      release(point);
      return;
    }
    pressAt(point);
  }

  /** The pointer's cell over the canvas (undefined when it left). */
  function hover(point: CelPoint | undefined): void {
    if (point) keyboard.value = false;
    cursor.value = point && onCel(point);
    // A line or rect waiting for its second click follows the pointer.
    if (point && anchor.value && tool.value !== "select") preview(onCel(point));
  }

  // A new cel, loop or document under the tools ends what was being drawn on the old one.
  watch([loop, cel], () => {
    cancel();
    selection.value = null;
  });
  watch(options.frozen, () => cancel());

  /** SpriteCanvas's overlay: the marquee being dragged, the selection and the cursor. */
  const overlay = computed(() => {
    const a = anchor.value;
    const point = cursor.value;
    const marquee = tool.value === "select" && a && point ? rectBetween(a, point) : null;
    const m = move.value;
    const area = selection.value;
    const moved = area && m ? { ...area, x: area.x + m.offset.x, y: area.y + m.offset.y } : area;
    return { marquee, selection: moved, cursor: keyboard.value ? (point ?? null) : null };
  });

  return {
    tool,
    setTool,
    closeRecolor,
    recolorFrom,
    cursor,
    keyboard,
    anchor,
    stroke,
    selection,
    move,
    busy,
    penDown,
    overlay,
    pressAt,
    dragTo,
    release,
    cancel,
    flip,
    clearSelection,
    nudgeSelection,
    arrow,
    click,
    hover,
  };
}
