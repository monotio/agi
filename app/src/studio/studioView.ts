import { VOCABULARY } from "../../../src/vocabulary.ts";
/**
 * Pure view helpers for the Room Studio: lens painting, mask geometry for
 * the SVG overlay, priority band guides, the
 * draw-order tick layout and Scene list labels. No Vue and no DOM, so tests drive them directly.
 */

import { EGA_PALETTE } from "../render/palette.ts";
import { priorityForY } from "../../../src/runtime/priority.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import type { PictureSourceSpan } from "../../../src/picture/source.ts";
import { linePoints } from "../../../src/studio/editPoints.ts";
import type { PictureItemKind } from "../../../src/studio/pictureDocument.ts";
import type { TimelineEntry } from "../../../src/studio/pictureQuery.ts";
import { EGA_COLOUR_NAMES } from "../../../src/studio/sceneGroups.ts";

import type { StudioLens } from "../../../src/studio/lensRules.ts";

export type { StudioLens };
export type StudioViewMode = "blend" | "split" | "priority";

/**
 * The lenses' names, as Sierra named the planes: Visual is what the player
 * sees; Priority holds the distance bands and the control lines (walls,
 * gates, triggers, water) the player never sees.
 */
export const LENS_NAMES: Record<StudioLens, { label: string; help: string }> = {
  art: { label: "Visual", help: "What players see." },
  depth: {
    label: "Priority",
    help: "Depth, walls, water, triggers and gates.",
  },
};

/** What the Priority view shows: all of it, the distance bands, the control lines, or one value. */
export type PriorityFilter = "all" | "bands" | "controls" | number;

/** The priority plane as `filter` leaves it: kept cells stay, the rest read as background. */
export function filterPriority(priority: Uint8Array, filter: PriorityFilter): Uint8Array {
  if (filter === "all") return priority;
  const out = new Uint8Array(priority.length);
  for (let i = 0; i < priority.length; i++) {
    const value = priority[i]! & 0x0f;
    const keep =
      filter === "bands" ? value >= 4 : filter === "controls" ? value < 4 : value === filter;
    out[i] = keep ? value : 4;
  }
  return out;
}
/** What one canvas pane shows. */
export type PaneLayer = "art" | "depth" | "depth-only";

export interface ControlValue {
  readonly value: 0 | 1 | 2 | 3;
  readonly name: string;
  readonly help: string;
  readonly technical: string;
  /** EGA colour the Priority lens paints it with. */
  readonly colour: number;
  /** Which cells of a run are painted at full strength, so the value reads without colour. */
  readonly pattern: "solid" | "dashed" | "dotted" | "long-dash";
}

/** Priority values 0-3 are control lines, not depth (spec "Priority and control"). */
export const CONTROL_VALUES: readonly ControlValue[] = [
  {
    value: 0,
    name: VOCABULARY.wall.label,
    help: VOCABULARY.wall.help,
    technical: VOCABULARY.wall.technical,
    colour: 12,
    pattern: "solid",
  },
  {
    value: 1,
    name: VOCABULARY.gate.label,
    help: VOCABULARY.gate.help,
    technical: VOCABULARY.gate.technical,
    colour: 14,
    pattern: "dashed",
  },
  {
    value: 2,
    name: VOCABULARY.trigger.label,
    help: VOCABULARY.trigger.help,
    technical: VOCABULARY.trigger.technical,
    colour: 10,
    pattern: "dotted",
  },
  {
    value: 3,
    name: VOCABULARY.water.label,
    help: VOCABULARY.water.help,
    technical: VOCABULARY.water.technical,
    colour: 11,
    pattern: "long-dash",
  },
];

/** The meaning of a priority value, for labels. */
export function priorityMeaning(value: number): string {
  const control = CONTROL_VALUES[value];
  return control ? control.name : value === 4 ? "background" : `depth band ${value}`;
}

/** Whether cell x,y of a control run is painted at full strength for `pattern`. */
export function patternOn(pattern: ControlValue["pattern"], x: number, y: number): boolean {
  if (pattern === "solid") return true;
  if (pattern === "dashed") return (x + y) % 2 === 0;
  if (pattern === "dotted") return (x + y) % 3 === 0;
  return Math.floor((x + y) / 2) % 2 === 0;
}

/** Each pane's accessible name. */
export const PANE_LABELS: Record<PaneLayer, string> = {
  art: "Picture",
  depth: "Picture with its priority blended over it",
  "depth-only": "Priority",
};

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
/** Share of the priority colour in the Priority blend. */
const DEPTH_BLEND = 0.5;

/**
 * Paint one pane into RGBA `out` (160x168x4). Art is the visual plane in EGA
 * colours. Priority blends each distance band's EGA colour over the art (or
 * shows the priority plane alone, background 4 as black) and draws control
 * lines 0-3 in their own colour and pattern.
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
    const only = layer === "depth-only";
    const control = pri < 4 ? CONTROL_VALUES[pri]! : undefined;
    if (control) {
      const x = i % SCREEN_WIDTH;
      const y = (i - x) / SCREEN_WIDTH;
      const on = patternOn(control.pattern, x, y);
      put(out, i, on ? EGA_PALETTE[control.colour]! : only ? BLACK : art);
      continue;
    }
    if (pri >= 5)
      put(
        out,
        i,
        only ? EGA_PALETTE[pri]! : art,
        only ? undefined : EGA_PALETTE[pri]!,
        DEPTH_BLEND,
      );
    else put(out, i, only ? BLACK : art);
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

export interface Tick {
  /** State lines are short, drawing commands medium, fills tall. */
  kind: "state" | "draw" | "fill";
  /**
   * EGA colour the command draws with: its visual colour, else its priority
   * (a control value in its own colour); null for a state line.
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

/** A picture's size in plain words, for the meta bar. */
export interface PictureSize {
  /** "1,148 bytes" */
  readonly bytes: string;
  /** "219 steps" */
  readonly commands: string;
  /** "1,148 bytes · 219 steps" */
  readonly full: string;
}

export function pictureSize(bytes: number, commands: number): PictureSize {
  const n = (value: number): string => value.toLocaleString("en-US");
  const size = `${n(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
  const drawing = `${n(commands)} ${commands === 1 ? "step" : "steps"}`;
  return { bytes: size, commands: drawing, full: `${size} · ${drawing}` };
}

/** A Scene list label split for a middle ellipsis: `head` gives way first, `tail` stays whole. */
export interface LabelParts {
  readonly full: string;
  readonly head: string;
  /** From the first word holding a digit ("5 part 2"), with its leading space; empty when none. */
  readonly tail: string;
}

/** Longer tails keep only their last words, so the head still shows something. */
const LABEL_TAIL_MAX = 12;

/**
 * Split an item label where the numbers that tell rows apart begin:
 * "Element 5 part 2" ellipsizes as "Elem… 5 part 2", never "Element 5 pa…".
 */
export function labelParts(full: string): LabelParts {
  const words = full.split(" ");
  let start = words.findIndex((word) => /\d/.test(word));
  if (start <= 0) return { full, head: full, tail: "" };
  while (start < words.length - 1 && words.slice(start).join(" ").length > LABEL_TAIL_MAX) start++;
  return {
    full,
    head: words.slice(0, start).join(" "),
    tail: ` ${words.slice(start).join(" ")}`,
  };
}

/**
 * Labels the Studio itself generates: "Element 5", "Element 5 part 2",
 * "Line 3", "Depth polygon 1", "Wall line 1", each with a " copy" tail.
 */
const GENERATED_LABEL =
  /^(?:Element (\d+)(?: part (\d+))?|(?:Line|Rect|Polygon|Fill|Brush) \d+|(?:Depth|Wall|Gate|Trigger|Water) (?:line|rect|polygon|fill|brush) \d+)( copy(?: \d+)?)?$/;

/** The noun a drawing command's plain name takes. */
const NOUNS: Record<string, string> = {
  line: "line",
  polyline: "line",
  rel: "line",
  xcorner: "line",
  ycorner: "line",
  rect: "rectangle",
  polygon: "polygon",
  fill: "fill",
  plot: "brush",
};

/**
 * A generated label as the calm UI says it: "Red line · 6 points", "Blue
 * fill", "Depth band 9 polygon", "Wall line". The value is the one colour or
 * priority the item draws with; an item drawing several keeps its generated
 * label, as does one with no drawing commands. Null keeps the label.
 */
export function plainItemName(input: {
  label: string;
  kind: PictureItemKind | "loose";
  /** The item's drawing timeline entries (state steps included; they are skipped). */
  entries: readonly TimelineEntry[];
  /** The document's source lines, for point counts. */
  lines: readonly string[];
}): string | null {
  const generated = GENERATED_LABEL.exec(input.label);
  if (!generated) return null;
  const drawing = input.entries.filter((entry) => tickFor(entry).kind !== "state");
  if (drawing.length === 0) return null;
  const nouns = new Set(drawing.map((entry) => NOUNS[entry.op] ?? "shape"));
  const noun = nouns.size === 1 ? [...nouns][0]! : "shape";
  const points =
    noun === "line" || noun === "rectangle" || noun === "polygon"
      ? drawing.reduce(
          (sum, entry) => sum + linePoints(input.lines[entry.line - 1] ?? "").length,
          0,
        )
      : 0;
  const single = (values: readonly (number | null)[]): number | null | undefined => {
    const set = new Set(values.filter((value): value is number => value !== null));
    return set.size === 0 ? null : set.size === 1 ? [...set][0] : undefined;
  };
  const visual = single(drawing.map((entry) => entry.visual));
  const priority = single(drawing.map((entry) => entry.priority));
  let name: string | null = null;
  if (input.kind !== "depth" && input.kind !== "walk" && visual !== undefined && visual !== null)
    name = `${EGA_COLOUR_NAMES[visual]!} ${noun}`;
  if (name === null && priority !== undefined && priority !== null)
    name =
      priority < 4 ? `${CONTROL_VALUES[priority]!.name} ${noun}` : `depth band ${priority} ${noun}`;
  if (name === null) return null;
  const parts = [name];
  if (points > 0) parts.push(`${points} ${points === 1 ? "point" : "points"}`);
  if (generated[2] !== undefined) parts.push(`part ${generated[2]}`);
  if (generated[3] !== undefined) parts.push("copy");
  const joined = parts.join(" · ");
  return `${joined[0]!.toUpperCase()}${joined.slice(1)}`;
}
