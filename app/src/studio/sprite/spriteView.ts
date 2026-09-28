/**
 * Sprite Studio's pure helpers: how loops are named and grouped, the loop
 * preview's pace, where a cel's feet stand, the pixel runs the line, rect
 * and selection tools write, and a cel's colours for a canvas. No Vue and no
 * DOM; the components and composables beside it draw and drive them.
 */

import { TIMER_INCREMENT_MS } from "../../../../src/runtime/cycleClock.ts";
import type { PixelChange } from "../../../../src/studio/sprite/spriteCels.ts";
import type { SpriteCel, SpriteDocument } from "../../../../src/view/spriteDocument.ts";
import { usageText, type ViewUsage } from "../../../../src/agent/viewUsage.ts";
import { EGA_PALETTE } from "../../render/palette.ts";
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

/** What the loop preview needs of a live screen object (ScreenObjectState's fields). */
export interface PreviewCycler {
  readonly num: number;
  readonly view: number;
  readonly loop: number;
  readonly cycling: boolean;
  readonly cycleTime: number;
}

/** How the loop preview is paced: the cel interval and whose cycle time it borrows. */
export interface PreviewPacing {
  readonly intervalMs: number;
  readonly cycleTime: number;
  /** The object whose cycle time paces it; null when no object shows the view now. */
  readonly object: number | null;
}

/**
 * The loop preview's pace, as the player sees `view` animate: the game's
 * cycle delay (v10) times the cycle time of an object showing the view now
 * (cycle.time: a cel every that many cycles). Of several, the one on
 * `loop` wins, else ego (object 0), else the first. An object standing
 * still keeps its cycle time for when it moves again; one whose cycle time
 * is 0 (animation off) is passed over. With none the preview advances one
 * cel a cycle, and says so.
 */
export function previewPacing(
  speed: number,
  cyclers: readonly PreviewCycler[],
  view: number,
  loop: number,
): PreviewPacing {
  const showing = cyclers.filter((o) => o.view === view && o.cycleTime > 0);
  const chosen =
    showing.find((o) => o.loop === loop) ?? showing.find((o) => o.num === 0) ?? showing[0];
  const cycleTime = chosen?.cycleTime ?? 1;
  return { intervalMs: celIntervalMs(speed, cycleTime), cycleTime, object: chosen?.num ?? null };
}

/**
 * The preview's pace in plain words: one short line (the milliseconds of
 * the game's own pace are in the title), and the whole sentence for its title. Game ticks are the interpreter's logic cycles; a pose is a
 * cel. At half speed each pose shows twice as long.
 */
export function paceWords(
  pacing: PreviewPacing,
  pace: "game" | "half",
): { readonly text: string; readonly title: string } {
  const { intervalMs, cycleTime, object } = pacing;
  const ms = Math.round(intervalMs);
  const every = cycleTime === 1 ? "every game tick" : `every ${cycleTime} game ticks`;
  const who = object === null ? null : object === 0 ? "the hero" : `object ${object}`;
  const title =
    who === null
      ? `At game speed each pose shows for ${ms} ms: nothing on screen uses this view right now, so the preview changes pose every game tick.`
      : `At game speed each pose shows for ${ms} ms: ${who} changes pose ${every}, at the game's speed setting.`;
  if (pace === "half") return { text: `Half speed: a new pose every ${ms * 2} ms`, title };
  if (who === null) return { text: `Not on screen now: a new pose every ${ms} ms`, title };
  const lead = who.charAt(0).toUpperCase() + who.slice(1);
  return { text: `${lead} changes pose ${every}`, title };
}

/**
 * What shows behind a cel's transparent pixels while drawing. View only:
 * the view's transparent colour is data and stays as it is; a backdrop is
 * never part of the view and never reaches the draft.
 */
export type SpriteBackdrop =
  | { readonly kind: "checker"; readonly tone: "dark" | "light" }
  | { readonly kind: "colour"; readonly colour: number }
  | { readonly kind: "room" };

export const DEFAULT_BACKDROP: SpriteBackdrop = { kind: "checker", tone: "dark" };

/** The backdrop as a stored preference: `checker-dark`, `checker-light`, `colour-N` or `room`. */
export function backdropKey(backdrop: SpriteBackdrop): string {
  if (backdrop.kind === "checker") return `checker-${backdrop.tone}`;
  return backdrop.kind === "colour" ? `colour-${backdrop.colour}` : "room";
}

/** A stored preference back to a backdrop; anything else is the default. */
export function parseBackdrop(value: string | null): SpriteBackdrop {
  if (value === "checker-dark" || value === "checker-light")
    return { kind: "checker", tone: value === "checker-dark" ? "dark" : "light" };
  if (value === "room") return { kind: "room" };
  const colour = /^colour-(\d{1,2})$/.exec(value ?? "")?.[1];
  if (colour !== undefined && Number(colour) < 16)
    return { kind: "colour", colour: Number(colour) };
  return DEFAULT_BACKDROP;
}

/** A room picture's window behind the cel: its visual plane and where the cel stands on it. */
export interface RoomBackdrop {
  /** 160×168 visual colours. */
  readonly visual: Uint8Array;
  readonly x: number;
  readonly baselineY: number;
}

/**
 * The backdrop at each of a `width`×`height` cel's pixels, row-major: an
 * EGA colour 0..15, or −1 and −2 for the checker's two squares. A room
 * backdrop reads the picture where the cel would stand (its bottom row on
 * `baselineY`); cells off the picture fall back to the checker.
 */
export function backdropCells(
  backdrop: SpriteBackdrop,
  width: number,
  height: number,
  room: RoomBackdrop | null = null,
): Int8Array {
  const out = new Int8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const checker = (x + y) % 2 === 0 ? -1 : -2;
      let value = checker;
      if (backdrop.kind === "colour") value = backdrop.colour & 0x0f;
      else if (backdrop.kind === "room" && room) {
        const px = room.x + x;
        const py = room.baselineY - (height - 1) + y;
        if (px >= 0 && px < 160 && py >= 0 && py < 168) value = room.visual[py * 160 + px]! & 0x0f;
      }
      out[y * width + x] = value;
    }
  return out;
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

/**
 * The top bar's usage chip: one room or logic by number, several by count
 * ("Used by 7 rooms"); the side panel lists them (SpriteMirrorNote).
 */
export function usageChip(usage: ViewUsage): string {
  const { rooms, logics } = usage;
  if (rooms.length > 1) return `Used by ${rooms.length} rooms`;
  if (rooms.length === 0 && logics.length > 1) return `Used by ${logics.length} logics`;
  return usageText(usage);
}
