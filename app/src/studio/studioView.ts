/**
 * Pure view helpers for the Room Studio: lens painting, mask geometry for
 * the SVG overlay, priority band guides, control-line labels and the
 * draw-order tick layout. No Vue and no DOM, so tests drive them directly.
 */

import { EGA_PALETTE } from "../palette.ts";
import { priorityForY } from "../../../src/runtime/priority.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import type { PictureSourceSpan } from "../../../src/picture/source.ts";
import type { TimelineEntry } from "../../../src/studio/pictureQuery.ts";

export type StudioLens = "art" | "depth" | "walk";
export type StudioViewMode = "blend" | "split" | "priority";
/** What one canvas pane shows. */
export type PaneLayer = "art" | "depth" | "depth-only" | "walk" | "walk-only";

export interface ControlValue {
  readonly value: 0 | 1 | 2 | 3;
  readonly name: string;
  /** EGA colour the Walk lens paints it with. */
  readonly colour: number;
  /** Which cells of a run are painted at full strength, so the value reads without colour. */
  readonly pattern: "solid" | "dashed" | "dotted" | "long-dash";
}

/** Priority values 0-3 are control lines, not depth (spec "Priority and control"). */
export const CONTROL_VALUES: readonly ControlValue[] = [
  { value: 0, name: "barrier", colour: 12, pattern: "solid" },
  { value: 1, name: "conditional", colour: 14, pattern: "dashed" },
  { value: 2, name: "signal", colour: 10, pattern: "dotted" },
  { value: 3, name: "water", colour: 11, pattern: "long-dash" },
];

/** The meaning of a priority value, for labels. */
export function priorityMeaning(value: number): string {
  const control = CONTROL_VALUES[value];
  return control ? control.name : value === 4 ? "background" : `band ${value}`;
}

/** Whether cell x,y of a control run is painted at full strength for `pattern`. */
export function patternOn(pattern: ControlValue["pattern"], x: number, y: number): boolean {
  if (pattern === "solid") return true;
  if (pattern === "dashed") return (x + y) % 2 === 0;
  if (pattern === "dotted") return (x + y) % 3 === 0;
  return Math.floor((x + y) / 2) % 2 === 0;
}

/** The panes a lens and view mode put on screen, left to right. */
export function panesFor(lens: StudioLens, mode: StudioViewMode): PaneLayer[] {
  if (lens === "art") return ["art"];
  if (mode === "split") return ["art", `${lens}-only`];
  return [mode === "priority" ? `${lens}-only` : lens];
}

const mix = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);

function put(
  out: Uint8ClampedArray,
  i: number,
  rgb: readonly number[],
  toward?: readonly number[],
  t = 0,
): void {
  const o = i * 4;
  out[o] = toward ? mix(rgb[0]!, toward[0]!, t) : rgb[0]!;
  out[o + 1] = toward ? mix(rgb[1]!, toward[1]!, t) : rgb[1]!;
  out[o + 2] = toward ? mix(rgb[2]!, toward[2]!, t) : rgb[2]!;
  out[o + 3] = 255;
}

const BLACK = EGA_PALETTE[0]!;
/** Share of the priority colour in the Depth blend. */
export const DEPTH_BLEND = 0.5;
/** How far the art fades toward black under the Walk lens. */
export const WALK_DIM = 0.7;
/** How far an off-pattern control cell fades toward black. */
export const PATTERN_FADE = 0.55;

/**
 * Paint one pane into RGBA `out` (160x168x4). Art is the visual plane in EGA
 * colours. Depth blends each priority 5-15 cell's EGA colour over the art (or
 * shows the priority plane alone, background 4 as black). Walk dims the art
 * and paints control values 0-3 strongly in their own colour and pattern.
 */
export function paintLayer(
  layer: PaneLayer,
  visual: Uint8Array,
  priority: Uint8Array,
  out: Uint8ClampedArray,
): void {
  for (let i = 0; i < visual.length; i++) {
    const art = EGA_PALETTE[visual[i]! & 0x0f]!;
    const pri = priority[i]! & 0x0f;
    if (layer === "art") {
      put(out, i, art);
      continue;
    }
    const control = pri < 4 ? CONTROL_VALUES[pri]! : undefined;
    if (layer === "depth" || layer === "depth-only") {
      const only = layer === "depth-only";
      if (pri >= 5)
        put(
          out,
          i,
          only ? EGA_PALETTE[pri]! : art,
          only ? undefined : EGA_PALETTE[pri]!,
          DEPTH_BLEND,
        );
      else if (control && only) put(out, i, EGA_PALETTE[control.colour]!, BLACK, PATTERN_FADE);
      else put(out, i, only ? BLACK : art);
      continue;
    }
    if (control) {
      const x = i % SCREEN_WIDTH;
      const y = (i - x) / SCREEN_WIDTH;
      const on = patternOn(control.pattern, x, y);
      put(out, i, EGA_PALETTE[control.colour]!, BLACK, on ? 0 : PATTERN_FADE);
    } else if (layer === "walk") {
      put(out, i, art, BLACK, WALK_DIM);
    } else {
      put(out, i, pri >= 5 ? EGA_PALETTE[pri]! : BLACK, BLACK, 0.8);
    }
  }
}

export interface MaskBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of the set cells, or null for an empty mask. */
export function maskBox(mask: Uint8Array): MaskBox | null {
  let minX = SCREEN_WIDTH;
  let minY = SCREEN_HEIGHT;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue;
    const x = i % SCREEN_WIDTH;
    const y = (i - x) / SCREEN_WIDTH;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

const cell = (mask: Uint8Array, x: number, y: number): boolean =>
  x >= 0 && x < SCREEN_WIDTH && y >= 0 && y < SCREEN_HEIGHT && mask[y * SCREEN_WIDTH + x] === 1;

/** An SVG path (logical units) covering the set cells as one rectangle per row run. */
export function maskFillPath(mask: Uint8Array): string {
  const parts: string[] = [];
  for (let y = 0; y < SCREEN_HEIGHT; y++) {
    let x = 0;
    while (x < SCREEN_WIDTH) {
      if (!cell(mask, x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (cell(mask, x, y)) x++;
      parts.push(`M${start} ${y}h${x - start}v1h${start - x}z`);
    }
  }
  return parts.join("");
}

/** An SVG path (logical units) tracing every edge between a set and an unset cell. */
export function maskOutlinePath(mask: Uint8Array): string {
  const parts: string[] = [];
  for (let y = 0; y <= SCREEN_HEIGHT; y++) {
    let x = 0;
    while (x < SCREEN_WIDTH) {
      if (cell(mask, x, y - 1) === cell(mask, x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < SCREEN_WIDTH && cell(mask, x, y - 1) !== cell(mask, x, y)) x++;
      parts.push(`M${start} ${y}h${x - start}`);
    }
  }
  for (let x = 0; x <= SCREEN_WIDTH; x++) {
    let y = 0;
    while (y < SCREEN_HEIGHT) {
      if (cell(mask, x - 1, y) === cell(mask, x, y)) {
        y++;
        continue;
      }
      const start = y;
      while (y < SCREEN_HEIGHT && cell(mask, x - 1, y) !== cell(mask, x, y)) y++;
      parts.push(`M${x} ${start}v${y - start}`);
    }
  }
  return parts.join("");
}

export interface BandGuide {
  /** First row of the band. */
  y: number;
  band: number;
}

/** The rows where the baseline priority band changes, with the band that starts there. */
export function bandGuides(base = 48): BandGuide[] {
  const guides: BandGuide[] = [];
  for (let y = 1; y < SCREEN_HEIGHT; y++) {
    const band = priorityForY(y, base);
    if (band !== priorityForY(y - 1, base)) guides.push({ y, band });
  }
  return guides;
}

export interface ControlLabel {
  value: number;
  /** Label anchor: a cell of the run, the one nearest its centroid. */
  x: number;
  y: number;
  cells: number;
}

/**
 * One label per 8-connected run of a control value with at least `minCells`
 * cells, largest first, at most `limit`.
 */
export function controlLabels(priority: Uint8Array, minCells = 4, limit = 24): ControlLabel[] {
  const seen = new Uint8Array(priority.length);
  const labels: ControlLabel[] = [];
  const stack: number[] = [];
  for (let start = 0; start < priority.length; start++) {
    const value = priority[start]!;
    if (value > 3 || seen[start]) continue;
    const run: number[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      run.push(i);
      const x = i % SCREEN_WIDTH;
      const y = (i - x) / SCREEN_WIDTH;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= SCREEN_WIDTH || ny < 0 || ny >= SCREEN_HEIGHT) continue;
          const j = ny * SCREEN_WIDTH + nx;
          if (!seen[j] && priority[j] === value) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    if (run.length < minCells) continue;
    let sx = 0;
    let sy = 0;
    for (const i of run) {
      sx += i % SCREEN_WIDTH;
      sy += Math.floor(i / SCREEN_WIDTH);
    }
    const cx = sx / run.length;
    const cy = sy / run.length;
    let best = run[0]!;
    let bestDistance = Infinity;
    for (const i of run) {
      const d = ((i % SCREEN_WIDTH) - cx) ** 2 + (Math.floor(i / SCREEN_WIDTH) - cy) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    labels.push({
      value,
      x: best % SCREEN_WIDTH,
      y: Math.floor(best / SCREEN_WIDTH),
      cells: run.length,
    });
  }
  return labels.sort((a, b) => b.cells - a.cells || a.y - b.y || a.x - b.x).slice(0, limit);
}

export interface Tick {
  /** State lines are short, drawing commands medium, fills tall. */
  kind: "state" | "draw" | "fill";
  /**
   * EGA colour the command draws with: its visual colour, else its priority
   * (a control value in its Walk lens colour); null for a state line.
   */
  colour: number | null;
}

const STATE_OPS: readonly string[] = ["vis", "visual", "pri", "priority", "pen", "end"];

/** The scrubber tick for a timeline entry. */
export function tickFor(entry: TimelineEntry): Tick {
  if (STATE_OPS.includes(entry.op)) return { kind: "state", colour: null };
  const priority =
    entry.priority === null ? null : (CONTROL_VALUES[entry.priority]?.colour ?? entry.priority);
  return { kind: entry.op === "fill" ? "fill" : "draw", colour: entry.visual ?? priority };
}

/** Index of the span holding byte `offset` (spans are in byte order), or -1. */
export function spanIndexAt(spans: readonly PictureSourceSpan[], offset: number): number {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid]!;
    if (offset < span.start) hi = mid - 1;
    else if (offset >= span.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** When the byte meter starts warning: this share of write_scene's limit. */
export const BYTES_APPROACH = 0.8;

export interface ByteMeter {
  tone: "ok" | "warn" | "danger";
  /** Share of the resource limit used, 0..1. */
  fraction: number;
  note: string;
}

/**
 * The top bar's size meter for a compiled picture: against the container's
 * record limit (a PIC is at most `recordLimit` bytes) and, before it, the
 * agent's write_scene limit, past which the agent cannot rewrite the picture.
 */
export function byteMeter(bytes: number, sceneLimit: number, recordLimit: number): ByteMeter {
  const fraction = Math.min(1, bytes / recordLimit);
  const n = (value: number): string => value.toLocaleString("en-US");
  if (bytes > recordLimit)
    return {
      tone: "danger",
      fraction,
      note: `Over the ${n(recordLimit)}-byte resource limit: this picture cannot be kept.`,
    };
  if (bytes > sceneLimit)
    return {
      tone: "warn",
      fraction,
      note: `Over the agent's ${n(sceneLimit)}-byte write_scene limit; the resource limit is ${n(recordLimit)} bytes.`,
    };
  if (bytes >= sceneLimit * BYTES_APPROACH)
    return {
      tone: "warn",
      fraction,
      note: `Approaching the agent's ${n(sceneLimit)}-byte write_scene limit (resource limit ${n(recordLimit)}).`,
    };
  return {
    tone: "ok",
    fraction,
    note: `${n(bytes)} of the ${n(recordLimit)} bytes a picture can hold.`,
  };
}
