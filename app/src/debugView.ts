/**
 * Inspector helpers: coordinate mapping between the three spaces the debug
 * surface exposes (client pixels on the displayed canvas, the composed
 * 320x200 frame, and the 160x168 logical picture), per-pixel pick results,
 * and the overlay geometry the object layer draws. Pure where possible so
 * app tests can pin the math.
 */
import type { Frame } from "./gameTypes.ts";
import type { ScreenObjectState } from "../../src/runtime/engine.ts";
import type { StagePick } from "./explodedPick.ts";
import { EGA_PALETTE } from "./palette.ts";
import { FRAME_HEIGHT, FRAME_WIDTH } from "./composite.ts";

export const PIC_W = 160;
export const PIC_H = 168;

/**
 * Screen-tab view modes. "visual" is the game; "priority" is Sierra's
 * show.pri.screen as a live layer; "blend"/"split" are compositor modes;
 * "explode" is the GPU exploded-layers view (canvas2d falls back to visual).
 */
export type DebugViewMode = "visual" | "priority" | "blend" | "split" | "explode";

/** A pointer position expressed in all three coordinate spaces. */
export interface PickPoint {
  /** Logical picture pixel; null outside the picture band. */
  logical: { x: number; y: number } | null;
  /** Composed-frame pixel (0..319, 0..199). */
  displayed: { x: number; y: number };
  /**
   * Which exploded layer rendered the picked pixel, when the pick came from
   * the GPU stage. Undefined for flat 2D picks.
   */
  layerKind?: StagePick["kind"];
  /** Priority band of a picture/sprite layer pick. */
  layerBand?: number;
}

/**
 * Map a client pointer position over the canvas into frame space. The canvas
 * displays the whole 320x200 frame scaled to its box; the picture band starts
 * at frame row picRow*8.
 */
export function pickFromClient(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  picRow: number,
): PickPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const dx = Math.floor(((clientX - rect.left) / rect.width) * FRAME_WIDTH);
  const dy = Math.floor(((clientY - rect.top) / rect.height) * FRAME_HEIGHT);
  if (dx < 0 || dx >= FRAME_WIDTH || dy < 0 || dy >= FRAME_HEIGHT) return null;
  const lx = Math.floor(dx / 2);
  const ly = dy - picRow * 8;
  return {
    logical: lx >= 0 && lx < PIC_W && ly >= 0 && ly < PIC_H ? { x: lx, y: ly } : null,
    displayed: { x: dx, y: dy },
  };
}

/** What the picked logical pixel is made of. */
export interface PixelInspection {
  color: number;
  priority: number;
  /** Owning screen object number, or null for picture background. */
  owner: number | null;
}

export function inspectPixel(frame: Frame, x: number, y: number): PixelInspection | null {
  if (x < 0 || x >= PIC_W || y < 0 || y >= PIC_H) return null;
  const i = y * PIC_W + x;
  const owned = frame.ownership?.[i] ?? 0;
  return {
    color: frame.visual[i]! & 0x0f,
    priority: frame.priority[i]! & 0x0f,
    owner: owned > 0 ? owned - 1 : null,
  };
}

/**
 * A pick latched against the frame that was on screen when clicked. The
 * object snapshot and frame identity are frozen at click time so a live
 * object moving, changing, or disappearing — or a stale frame arriving out
 * of order — can never rewrite what the card describes.
 */
export interface LatchedPick {
  point: PickPoint;
  inspection: PixelInspection;
  /** Immutable screen-object snapshot for the owner, or null when the pick
   * names a non-sprite layer or a pixel with no owner. */
  object: Readonly<ScreenObjectState> | null;
  /** Frame identity at capture: interpreter cycle + container revision. */
  cycle: number | null;
  patchGeneration: number | null;
}

/**
 * Resolve a click into a self-contained observation. `point.layerKind`
 * suppresses the object identity for non-sprite layer picks (the ownership
 * mask still describes the composed frame honestly via `inspection.owner`).
 */
export function latchPickAt(frame: Frame, point: PickPoint): LatchedPick | null {
  if (!point.logical) return null;
  const inspection = inspectPixel(frame, point.logical.x, point.logical.y);
  if (!inspection) return null;
  const spritePick = point.layerKind === undefined || point.layerKind === "sprite";
  const source =
    spritePick && inspection.owner !== null
      ? (frame.objects?.find((o) => o.num === inspection.owner) ?? null)
      : null;
  // Scalars plus two optional nested targets; deep-freeze covers them.
  const object = source ? Object.freeze(structuredClone(source)) : null;
  return {
    point: Object.freeze({ ...point, logical: Object.freeze({ ...point.logical }) }),
    inspection,
    object,
    cycle: frame.cycle ?? null,
    patchGeneration: frame.patchGeneration ?? null,
  };
}

/** Cycle regression means a new game, restore, or seek — any latch is stale. */
export function latchIsStale(latch: LatchedPick, frame: Frame | null): boolean {
  return (
    frame !== null && frame.cycle !== undefined && latch.cycle !== null && frame.cycle < latch.cycle
  );
}

/**
 * Crop the frame around a logical point into RGBA at logical resolution.
 * `radius` is in logical pixels; the result is square, clamped at the edges.
 */
export function cropFrameRgba(
  frame: Frame,
  cx: number,
  cy: number,
  radius: number,
): { width: number; height: number; data: Uint8Array } {
  const size = radius * 2 + 1;
  const x0 = Math.max(0, Math.min(cx - radius, PIC_W - size));
  const y0 = Math.max(0, Math.min(cy - radius, PIC_H - size));
  const w = Math.min(size, PIC_W - x0);
  const h = Math.min(size, PIC_H - y0);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y0 + y) * PIC_W + (x0 + x);
      const [r, g, b] = EGA_PALETTE[frame.visual[i]! & 0x0f]!;
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const MOTION_NAMES = ["normal", "move.obj", "follow.ego", "wander"] as const;

/** One-line object identity for the pick card and the objects table. */
export function describeObject(o: ScreenObjectState): string {
  const motion =
    o.motionMode === 1 && o.moveTarget
      ? `move.obj→(${o.moveTarget.x},${o.moveTarget.y})`
      : (MOTION_NAMES[o.motionMode] ?? `motion ${o.motionMode}`);
  return `o${o.num} · view ${o.view} loop ${o.loop} cel ${o.cel} · pri ${o.priority}${o.fixedPriority ? "*" : ""} · ${motion}`;
}

/** One axis-aligned box plus baseline for the object overlay. */
export interface OverlayBox {
  x: number;
  y: number;
  w: number;
  h: number;
  baseline: number;
  label: string;
  priority: number;
  direction: number;
  stepSize: number;
  moveTarget: { x: number; y: number } | null;
  follow: boolean;
  wander: boolean;
}

/**
 * Overlay geometry in logical pixels. Objects render at half-width cells: the
 * engine's x/y are already logical; width is doubled columns.
 */
export function overlayBoxes(objects: readonly ScreenObjectState[]): OverlayBox[] {
  return objects.map((o) => ({
    x: o.x,
    y: o.y - o.height + 1,
    w: o.width,
    h: o.height,
    baseline: o.y,
    label: `o${o.num}`,
    priority: o.priority,
    direction: o.direction,
    stepSize: o.stepSize,
    moveTarget: o.moveTarget ?? null,
    follow: o.motionMode === 2,
    wander: o.motionMode === 3,
  }));
}

/** A var/flag write the worker attributed to a completed cycle. */
export interface DebugEvent {
  seq: number;
  cycle: number;
  kind: "var" | "flag";
  index: number;
  from: number;
  to: number;
}

const VAR_NAMES: Record<number, string> = {
  0: "room",
  1: "prev room",
  2: "ego edge",
  3: "score",
  4: "obj touch",
  5: "obj edge",
  6: "ego dir",
  7: "max score",
  8: "mem left",
  9: "anim lag",
  10: "cycle time",
  11: "seconds",
  12: "minutes",
  13: "hours",
  14: "days",
  15: "dbl-click",
  16: "ego view",
  17: "error",
  18: "error param",
  19: "last key",
  20: "machine",
  21: "print timeout",
  22: "sound channels",
  23: "volume",
  24: "input max",
  25: "sel item",
  26: "mon. type",
};

const FLAG_NAMES: Record<number, string> = {
  0: "ego on water",
  1: "ego hidden",
  2: "input pending",
  3: "ego touched f2",
  4: "said ready",
  5: "new room",
  6: "restart",
  7: "no script",
  8: "dbl click",
  9: "sound on",
  10: "trace",
  11: "noise chan",
  12: "restore sel",
  13: "item select",
  14: "menu used",
  15: "no windows",
  16: "no auto-pri",
  255: "restart done",
};

/** "v3 score 4 → 6" / "f4 said ready set" for the timeline lane. */
export function describeDebugEvent(ev: DebugEvent): string {
  if (ev.kind === "flag") {
    const name = FLAG_NAMES[ev.index];
    return `f${ev.index}${name ? ` ${name}` : ""} ${ev.to !== 0 ? "set" : "reset"}`;
  }
  const name = VAR_NAMES[ev.index];
  return `v${ev.index}${name ? ` ${name}` : ""} ${ev.from} → ${ev.to}`;
}

/** "L3 pc41 assignn(4,2)" / "L0 pc7 equaln(3,1) → false" for the trace pane. */
export function formatTraceRecord(r: {
  logic: number;
  pc: number;
  op: number;
  args: number[];
  result?: boolean;
  name?: string;
}): string {
  const head = `L${r.logic} pc${r.pc} `;
  const op = r.name ?? `0x${r.op.toString(16).padStart(2, "0")}`;
  const tail = r.result === undefined ? "" : ` → ${r.result}`;
  return `${head}${op}(${r.args.join(",")})${tail}`;
}
