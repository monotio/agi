/**
 * Sprite Studio's pure helpers: how loops are named and grouped, the loop
 * preview's pace, where a cel's feet stand, the pixel runs the line, rect
 * and selection tools write, and a cel's colours for a canvas. No Vue and no
 * DOM; the components and composables beside it draw and drive them.
 */

import { TIMER_INCREMENT_MS } from "../../../../src/runtime/cycleClock.ts";
import type { PixelChange } from "../../../../src/studio/sprite/spriteCels.ts";
import type { SpriteCel, SpriteDocument } from "../../../../src/studio/sprite/spriteDocument.ts";
import type { ViewUsage } from "../../../../src/studio/sprite/spriteUsage.ts";
import { EGA_PALETTE } from "../../palette.ts";
import { HOST_POLL_MS } from "../../worker/cycle.ts";

export interface CelPoint {
  readonly x: number;
  readonly y: number;
}

/** A rectangle of cel pixels, corners inclusive and ordered. */
export interface CelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const FACINGS = ["Right-facing", "Left-facing", "Front-facing", "Back-facing"];

/**
 * The facing the interpreter's motion picks a loop for: loops 0 and 1 face
 * right and left in a view of two or three loops, and 2 and 3 face the
 * viewer and away in a view of four (Engine.selectLoop; whether views of more
 * than four loops use that table depends on the interpreter, so they are not
 * named). The names say which way a loop faces, not that it walks: a waving
 * robot or a standing clerk uses the same table.
 */
export function loopFacing(loop: number, loops: number): string | undefined {
  if (loops === 4 || ((loops === 2 || loops === 3) && loop < 2)) return FACINGS[loop];
  return undefined;
}

/** The loops sharing `loop`'s data block, itself included, in index order. */
export function aliasGroup(document: SpriteDocument, loop: number): number[] {
  const owner = document.loops[loop]?.alias ?? loop;
  return document.loops.flatMap((entry, index) =>
    (entry.alias ?? index) === owner ? [index] : [],
  );
}

/**
 * The loop to play beside `loop`: its linked partner, else the opposite
 * facing (loops 0 and 1, 2 and 3), else the view's first linked loop.
 */
export function previewPartner(document: SpriteDocument, loop: number): number | undefined {
  const group = aliasGroup(document, loop);
  if (group.length > 1) return group.find((member) => member !== loop);
  const opposite = loop < 4 ? loop ^ 1 : -1;
  if (opposite >= 0 && opposite < document.loops.length) return opposite;
  const linked = document.loops.findIndex((entry) => entry.alias !== null);
  return linked >= 0 && linked !== loop ? linked : undefined;
}

/**
 * How long each cel of a looping animation shows, in milliseconds: the
 * engine's logic cycle (v10 timer increments of TIMER_INCREMENT_MS; v10 = 0
 * runs at the host's poll rate) times the object's cycle time, which
 * animate.obj and new.room set to 1 — a cycling object advances one cel per
 * logic cycle.
 */
export function celIntervalMs(speed: number, cycleTime = 1): number {
  const cycle = speed > 0 ? speed * TIMER_INCREMENT_MS : HOST_POLL_MS;
  return cycle * Math.max(1, cycleTime);
}

/** Where a cel's feet stand: its lowest opaque row and that row's leftmost opaque column. */
export interface Feet {
  /** Rows between the lowest opaque row and the cel's bottom row (the baseline). */
  readonly lift: number;
  /** Columns between the cel's left edge (the object's x) and the feet. */
  readonly left: number;
}

/** The feet of `cel`, or null when every pixel is transparent. */
export function feetOf(cel: SpriteCel): Feet | null {
  for (let y = cel.height - 1; y >= 0; y--)
    for (let x = 0; x < cel.width; x++)
      if (cel.pixels[y * cel.width + x] !== cel.transparent)
        return { lift: cel.height - 1 - y, left: x };
  return null;
}

/**
 * The warning for an edit that moved the feet relative to where the game
 * stands the actor (its bottom-left corner), or null when they stayed.
 */
export function feetWarning(before: SpriteCel, after: SpriteCel): string | null {
  const a = feetOf(before);
  const b = feetOf(after);
  if (!a || !b) return null;
  const parts: string[] = [];
  const up = b.lift - a.lift;
  const right = b.left - a.left;
  if (up !== 0) parts.push(`${Math.abs(up)} px ${up > 0 ? "up" : "down"}`);
  if (right !== 0) parts.push(`${Math.abs(right)} px ${right > 0 ? "right" : "left"}`);
  if (parts.length === 0) return null;
  const floats = b.lift > 0 ? " The actor now floats above its baseline." : "";
  return `The feet moved ${parts.join(" and ")} of where the game stands the actor.${floats}`;
}

/** The top bar's usage chip: which rooms name the view. */
export function usageText(usage: ViewUsage): string {
  const rooms = usage.rooms;
  if (rooms.length > 0) return `Used by room${rooms.length === 1 ? "" : "s"} ${rooms.join(", ")}`;
  if (usage.logics.length > 0)
    return `Used by logic${usage.logics.length === 1 ? "" : "s"} ${usage.logics.join(", ")}`;
  return usage.dynamic ? "Chosen at runtime" : "Not used by any logic";
}

/** The pixels of a straight line from `a` to `b`, one per step along its longer axis. */
export function linePoints(a: CelPoint, b: CelPoint): CelPoint[] {
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  if (steps === 0) return [a];
  const out: CelPoint[] = [];
  for (let k = 0; k <= steps; k++)
    out.push({
      x: Math.round(a.x + ((b.x - a.x) * k) / steps),
      y: Math.round(a.y + ((b.y - a.y) * k) / steps),
    });
  return out;
}

/** The rectangle two corners span. */
export function rectBetween(a: CelPoint, b: CelPoint): CelRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(b.x - a.x) + 1, height: Math.abs(b.y - a.y) + 1 };
}

/** The outline pixels of a rectangle. */
export function rectOutline(rect: CelRect): CelPoint[] {
  const out: CelPoint[] = [];
  const right = rect.x + rect.width - 1;
  const bottom = rect.y + rect.height - 1;
  for (let x = rect.x; x <= right; x++) {
    out.push({ x, y: rect.y });
    if (bottom !== rect.y) out.push({ x, y: bottom });
  }
  for (let y = rect.y + 1; y < bottom; y++) {
    out.push({ x: rect.x, y });
    if (right !== rect.x) out.push({ x: right, y });
  }
  return out;
}

/** The rectangle clipped to the cel, or null when none of it lies on the cel. */
export function clipRect(rect: CelRect, cel: Pick<SpriteCel, "width" | "height">): CelRect | null {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(cel.width, rect.x + rect.width);
  const bottom = Math.min(cel.height, rect.y + rect.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Paint `color` (null erases) at the points that lie on the cel. */
export function paintChanges(
  cel: Pick<SpriteCel, "width" | "height">,
  points: readonly CelPoint[],
  color: number | null,
): PixelChange[] {
  const seen = new Set<number>();
  const out: PixelChange[] = [];
  for (const { x, y } of points) {
    if (x < 0 || y < 0 || x >= cel.width || y >= cel.height || seen.has(y * cel.width + x))
      continue;
    seen.add(y * cel.width + x);
    out.push({ x, y, color });
  }
  return out;
}

const valueAt = (cel: SpriteCel, x: number, y: number): number | null => {
  const value = cel.pixels[y * cel.width + x]!;
  return value === cel.transparent ? null : value;
};

/**
 * Move the selection's opaque pixels by (dx, dy): the selection is cleared
 * first unless `copy`, then its opaque pixels land where they fall on the
 * cel (transparent ones leave what is under them).
 */
export function moveSelectionChanges(
  cel: SpriteCel,
  selection: CelRect,
  dx: number,
  dy: number,
  copy: boolean,
): PixelChange[] {
  const area = clipRect(selection, cel);
  if (!area) return [];
  const out: PixelChange[] = [];
  const opaque: { x: number; y: number; color: number }[] = [];
  for (let y = area.y; y < area.y + area.height; y++)
    for (let x = area.x; x < area.x + area.width; x++) {
      const color = valueAt(cel, x, y);
      if (!copy) out.push({ x, y, color: null });
      if (color !== null) opaque.push({ x, y, color });
    }
  for (const { x, y, color } of opaque) {
    const tx = x + dx;
    const ty = y + dy;
    if (tx >= 0 && ty >= 0 && tx < cel.width && ty < cel.height) out.push({ x: tx, y: ty, color });
  }
  return out;
}

/** The selection's pixels flipped left to right in place. */
export function flipSelectionChanges(cel: SpriteCel, selection: CelRect): PixelChange[] {
  const area = clipRect(selection, cel);
  if (!area) return [];
  const out: PixelChange[] = [];
  for (let y = area.y; y < area.y + area.height; y++)
    for (let x = area.x; x < area.x + area.width; x++)
      out.push({ x, y, color: valueAt(cel, area.x + area.x + area.width - 1 - x, y) });
  return out;
}

/** Every pixel of the selection made transparent. */
export function clearSelectionChanges(cel: SpriteCel, selection: CelRect): PixelChange[] {
  const area = clipRect(selection, cel);
  if (!area) return [];
  const out: PixelChange[] = [];
  for (let y = area.y; y < area.y + area.height; y++)
    for (let x = area.x; x < area.x + area.width; x++) out.push({ x, y, color: null });
  return out;
}

/**
 * The cel's colours into RGBA, transparent pixels left fully transparent;
 * `tint` blends every opaque pixel toward that colour (onion skins).
 */
export function celRgba(
  cel: SpriteCel,
  out: Uint8ClampedArray,
  tint?: { readonly rgb: readonly [number, number, number]; readonly alpha: number },
): void {
  for (let i = 0; i < cel.pixels.length; i++) {
    const value = cel.pixels[i]!;
    const o = i * 4;
    if (value === cel.transparent) {
      out[o + 3] = 0;
      continue;
    }
    const [r, g, b] = EGA_PALETTE[value & 0x0f]!;
    if (tint) {
      out[o] = (r + tint.rgb[0]) / 2;
      out[o + 1] = (g + tint.rgb[1]) / 2;
      out[o + 2] = (b + tint.rgb[2]) / 2;
      out[o + 3] = Math.round(tint.alpha * 255);
    } else {
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
}

/** Total cels across the view's loops. */
export function celCount(document: SpriteDocument): number {
  return document.loops.reduce((sum, loop) => sum + loop.cels.length, 0);
}

/** WCAG relative luminance of an sRGB colour, 0..1. */
function luminance([r, g, b]: readonly [number, number, number]): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * The label colour for a swatch of AGI colour `colour`: the palette's black
 * (0) or white (15), whichever contrasts more with it (at least 4.5:1 on
 * each of the 16).
 */
export function swatchInk(colour: number): "var(--agi-0)" | "var(--agi-15)" {
  const l = luminance(EGA_PALETTE[colour] ?? [0, 0, 0]);
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "var(--agi-0)" : "var(--agi-15)";
}
