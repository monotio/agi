/**
 * Room Studio's drawing tools as pure state: which tools exist and their
 * keys, the values new content draws with, the click and drag sequences of
 * the line, polygon, rect and brush tools, the pipette's pick, the names new
 * items get, and where in draw order an insert lands. No Vue and no DOM;
 * useStudioTools.ts drives these from the canvas.
 */

import { priorityForY } from "../../../src/runtime/priority.ts";
import type { PictureSourceSpan } from "../../../src/picture/source.ts";
import {
  PICTURE_ITEM_ID,
  type PictureDocument,
  type PictureItemKind,
} from "../../../src/studio/pictureDocument.ts";
import type { Point } from "../../../src/studio/shapes.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import { depthValuesLocked, lockedPlanes, type LensUnlocks } from "./studioLocks.ts";
import { CONTROL_VALUES, type StudioLens } from "./studioView.ts";

export type StudioTool =
  "select" | "point" | "line" | "rect" | "polygon" | "fill" | "brush" | "pipette" | "hand";

/** The rail's single-letter shortcuts; G toggles the actor probe, which is not a tool. */
export const TOOL_KEYS: Record<string, StudioTool | "probe"> = {
  v: "select",
  a: "point",
  l: "line",
  r: "rect",
  p: "polygon",
  f: "fill",
  b: "brush",
  i: "pipette",
  g: "probe",
  h: "hand",
};

/** Tools that insert a new item. */
export const DRAWING_TOOLS: readonly StudioTool[] = ["line", "rect", "polygon", "fill", "brush"];

export const isDrawingTool = (tool: StudioTool): boolean => DRAWING_TOOLS.includes(tool);

/**
 * What new content draws with: a colour 0–15 or off on each plane, and on
 * the priority plane also "band", the baseline band under the cursor.
 */
export interface CurrentValues {
  readonly visual: number | null;
  readonly priority: number | null | "band";
}

/** Each lens starts on its own plane: Art draws colour, Depth the band under the cursor, Walk barriers. */
export function defaultValues(lens: StudioLens): CurrentValues {
  if (lens === "art") return { visual: 0, priority: null };
  if (lens === "depth") return { visual: null, priority: "band" };
  return { visual: null, priority: 0 };
}

/** The band priority when no cursor row is known. */
export const DEFAULT_BAND = 10;

/** The priority an insert draws with: "band" is the band of row `y`, 10 without one. */
export function resolvePriority(values: CurrentValues, y: number | undefined): number | null {
  if (values.priority !== "band") return values.priority;
  return y === undefined ? DEFAULT_BAND : priorityForY(y);
}

/**
 * The pipette: the colour and priority under the cursor become the current
 * values, except on a plane the lens keeps locked (it stays as it was), and
 * in the Walk lens a depth value 4–15 while depth values are locked there.
 */
export function pipetteValues(
  current: CurrentValues,
  picked: { readonly visual: number; readonly priority: number },
  lens: StudioLens,
  unlocks: LensUnlocks,
): CurrentValues {
  const locked = lockedPlanes(lens, unlocks);
  const visual = locked.includes("visual") ? current.visual : picked.visual;
  const depthLocked = depthValuesLocked(lens, unlocks) && picked.priority >= 4;
  const priority = locked.includes("priority") || depthLocked ? current.priority : picked.priority;
  return { visual, priority };
}

const samePoint = (a: Point | undefined, b: Point): boolean =>
  a !== undefined && a.x === b.x && a.y === b.y;

/** A line or polygon being clicked out, point by point. */
export interface PathDraft {
  readonly tool: "line" | "polygon";
  readonly points: readonly Point[];
}

export interface PathClick {
  readonly draft: PathDraft;
  /** The click closed a polygon on its first point: finish it. */
  readonly closed: boolean;
}

/**
 * One click of the line or polygon tool. A click on the last point adds
 * nothing (a double-click's second press); on the first point of a polygon
 * of three or more points it closes the polygon.
 */
export function clickPath(draft: PathDraft, point: Point): PathClick {
  const { points } = draft;
  if (draft.tool === "polygon" && points.length >= 3 && samePoint(points[0], point))
    return { draft, closed: true };
  if (samePoint(points.at(-1), point)) return { draft, closed: false };
  return { draft: { ...draft, points: [...points, point] }, closed: false };
}

/** The points a finished path draws, or null while it is too short (line 2, polygon 3). */
export function finishPath(draft: PathDraft): readonly Point[] | null {
  return draft.points.length >= (draft.tool === "line" ? 2 : 3) ? draft.points : null;
}

/** Backspace: the path without its last point. */
export function dropLastPoint(draft: PathDraft): PathDraft {
  return { ...draft, points: draft.points.slice(0, -1) };
}

export interface RectCorners {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

const clampX = (x: number): number => Math.min(SCREEN_WIDTH - 1, Math.max(0, x));
const clampY = (y: number): number => Math.min(SCREEN_HEIGHT - 1, Math.max(0, y));

/**
 * The rect a drag from `start` to `end` spans, corners ordered and on the
 * surface. With `square` it is square on screen: AGI pixels are twice as
 * wide as tall, so it spans half as many columns as rows.
 */
export function rectFrom(start: Point, end: Point, square: boolean): RectCorners {
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  if (square) {
    const side = Math.max(Math.abs(dx) * 2, Math.abs(dy));
    dx = Math.sign(dx || 1) * Math.round(side / 2);
    dy = Math.sign(dy || 1) * side;
  }
  const xs = [clampX(start.x), clampX(start.x + dx)];
  const ys = [clampY(start.y), clampY(start.y + dy)];
  return {
    x1: Math.min(xs[0]!, xs[1]!),
    y1: Math.min(ys[0]!, ys[1]!),
    x2: Math.max(xs[0]!, xs[1]!),
    y2: Math.max(ys[0]!, ys[1]!),
  };
}

/** A brush stroke: its plot points in order, one per logical pixel, and where the pointer is. */
export interface BrushStroke {
  readonly points: Point[];
  readonly seen: Set<number>;
  last: Point;
}

export function startStroke(point: Point): BrushStroke {
  return { points: [point], seen: new Set([point.y * SCREEN_WIDTH + point.x]), last: point };
}

/**
 * Extend a stroke to `to` through every cell of the straight run from its
 * last point, so a fast drag leaves no gaps, skipping cells it already
 * holds and cells off the surface. Returns whether any point was added.
 */
export function extendStroke(stroke: BrushStroke, to: Point): boolean {
  const from = stroke.last;
  stroke.last = to;
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  let added = false;
  for (let k = 1; k <= steps; k++) {
    const x = Math.round(from.x + ((to.x - from.x) * k) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * k) / steps);
    if (x < 0 || y < 0 || x >= SCREEN_WIDTH || y >= SCREEN_HEIGHT) continue;
    const key = y * SCREEN_WIDTH + x;
    if (stroke.seen.has(key)) continue;
    stroke.seen.add(key);
    stroke.points.push({ x, y });
    added = true;
  }
  return added;
}

/** The kind of an item drawing on these planes, as the kernel derives it for fills and plots. */
export function kindFor(visual: number | null, priority: number | null): PictureItemKind {
  if (priority === null) return "art";
  if (visual !== null) return "mixed";
  return priority < 4 ? "walk" : "depth";
}

/** What each drawing tool makes, for new items' labels. */
export const TOOL_NOUNS: Record<"line" | "rect" | "polygon" | "fill" | "brush", string> = {
  line: "Line",
  rect: "Rect",
  polygon: "Polygon",
  fill: "Fill",
  brush: "Brush",
};

/**
 * A new item's id, label and kind: "Rect 3", "Barrier line 2", "Depth
 * polygon 1", numbered with the first number whose label and id are free.
 */
export function newItemNames(
  document: Pick<PictureDocument, "items">,
  noun: string,
  visual: number | null,
  priority: number | null,
): { id: string; label: string; kind: PictureItemKind } {
  const kind = kindFor(visual, priority);
  const prefix =
    kind === "walk"
      ? `${capitalise(CONTROL_VALUES[priority!]!.name)} ${noun.toLowerCase()}`
      : kind === "depth"
        ? `Depth ${noun.toLowerCase()}`
        : noun;
  const labels = new Set(document.items.map((item) => item.label));
  const ids = new Set(document.items.map((item) => item.id));
  const slug = prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  for (let n = 1; ; n++) {
    const label = `${prefix} ${n}`;
    const id = `${slug}-${n}`.slice(0, 32);
    if (!labels.has(label) && !ids.has(id) && PICTURE_ITEM_ID.test(id)) return { id, label, kind };
  }
}

const capitalise = (text: string): string => `${text[0]!.toUpperCase()}${text.slice(1)}`;

/** Where an insert goes: the source line it goes before and the command index it draws at. */
export interface InsertionPoint {
  /** 1-based line to insert before (the line count plus one appends). */
  readonly atLine: number;
  /** The draw-order index its first command takes: the commands drawn before it. */
  readonly index: number;
}

/**
 * Where content drawn with the playhead at `playhead` (commands drawn) is
 * inserted: before the next command, so it draws at that point in time.
 * Inside an item that would split it, so the insert goes before the item
 * when the playhead stands at its start and right after it otherwise. At
 * the end it goes before the closing `end`, or after the last line.
 */
export function insertionPoint(
  document: Pick<PictureDocument, "items" | "lines">,
  spans: readonly Pick<PictureSourceSpan, "line">[],
  commands: number,
  playhead: number,
): InsertionPoint {
  const lineOf = (index: number): number =>
    spans[index]?.line ?? document.lines.length + (document.lines.at(-1) === "" ? 0 : 1);
  const index = Math.min(Math.max(0, playhead), commands);
  const line = lineOf(index);
  const host = document.items.find((item) => item.openLine < line && line < item.closeLine);
  if (!host) return { atLine: line, index };
  const first = spans.findIndex((span) => span.line > host.openLine);
  if (first === index) return { atLine: host.openLine, index };
  const after = spans.findIndex((span) => span.line > host.closeLine);
  return { atLine: host.closeLine + 1, index: after < 0 ? commands : Math.min(after, commands) };
}
