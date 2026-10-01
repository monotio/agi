/**
 * Frame geometry helpers for the VIEW preparation editor: collision-free
 * ids, regular grid and manual region builders, splitting and reordering.
 * Pure — every function returns detached records and never mutates the job.
 */
import type { Rect } from "../../../../src/creative/catalog.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../../src/types.ts";
import type { SourceIdentity, ViewRecipeFrame } from "../../../../src/view/preparation.ts";

/**
 * The smallest `f<n>` id not in use. Length-based ids collide after removing
 * a middle frame; suffix ids (`f0b`) collide on a repeated split. Scanning
 * stays collision-free for any history of adds, splits and renames.
 */
export function nextFrameId(frames: readonly { readonly id: string }[]): string {
  const used = new Set(frames.map((frame) => frame.id));
  let n = 0;
  while (used.has(`f${n}`)) n++;
  return `f${n}`;
}

/** The smallest `l<n>` loop id not in use. */
export function nextLoopId(loops: readonly { readonly id: string }[]): string {
  const used = new Set(loops.map((loop) => loop.id));
  let n = 0;
  while (used.has(`l${n}`)) n++;
  return `l${n}`;
}

/** Clamp a source-space rect to the source; null when nothing remains. */
export function clampRegion(rect: Rect, width: number, height: number): Rect | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The grid's cells in row-major order; edge cells absorb the remainder. */
export function gridRegions(width: number, height: number, columns: number, rows: number): Rect[] {
  if (!Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1)
    throw new Error("A grid needs whole columns and rows of at least 1.");
  const cellWidth = Math.floor(width / columns);
  const cellHeight = Math.floor(height / rows);
  if (cellWidth < 1 || cellHeight < 1) return [];
  const regions: Rect[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      regions.push({
        x: column * cellWidth,
        y: row * cellHeight,
        width: column === columns - 1 ? width - column * cellWidth : cellWidth,
        height: row === rows - 1 ? height - row * cellHeight : cellHeight,
      });
    }
  }
  return regions;
}

/**
 * A frame over a source region: the output canvas is the region uniformly
 * downscaled to the logical screen (1:1 stays exact), the horizontal anchor
 * centred, the baseline edge on the region's bottom row.
 */
export function frameFromRegion(id: string, source: SourceIdentity, region: Rect): ViewRecipeFrame {
  const scale = Math.min(1, SCREEN_WIDTH / region.width, SCREEN_HEIGHT / region.height);
  const outputWidth = Math.max(1, Math.floor(region.width * scale));
  const outputHeight = Math.max(1, Math.floor(region.height * scale));
  return {
    id,
    source: { ...source },
    region: { ...region },
    outputWidth,
    outputHeight,
    sourceAnchor: {
      x: region.x + Math.floor(region.width / 2),
      baselineEdgeY: region.y + region.height,
    },
    outputAnchorX: Math.floor(outputWidth / 2),
    sample: "nearest-centre-v1",
    allowCropBelowBaseline: false,
    allowCropOutsideCanvas: false,
  };
}

/**
 * Split a frame into two frames along an axis. The left/top half keeps the
 * id; the other half gets `newId` (use `nextFrameId` — a suffix collides on
 * a repeated split). Regions and outputs are recomputed for each half.
 */
export function splitFrameRegions(
  frame: ViewRecipeFrame,
  direction: "vertical" | "horizontal",
  newId: string,
): [ViewRecipeFrame, ViewRecipeFrame] | null {
  const { region } = frame;
  const along = direction === "vertical" ? region.width : region.height;
  if (along < 2) return null;
  const half = Math.floor(along / 2);
  const first = direction === "vertical" ? { ...region, width: half } : { ...region, height: half };
  const second =
    direction === "vertical"
      ? { x: region.x + half, y: region.y, width: region.width - half, height: region.height }
      : { x: region.x, y: region.y + half, width: region.width, height: region.height - half };
  return [
    frameFromRegion(frame.id, frame.source, first),
    frameFromRegion(newId, frame.source, second),
  ];
}

/** `list` with the item at `from` moved to `to` (detached copy). */
export function reordered<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}
