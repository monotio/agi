/** Pixel-grid geometry for marking image frames; regions use exclusive right/bottom edges. */
import type { Rect } from "./catalog.ts";
import { scaleImageFrame, type ImageFrame } from "./imageOperations.ts";

export interface FrameBox extends ImageFrame {
  readonly id: string;
  readonly edited: boolean;
  readonly linked?: boolean;
}
interface Size {
  readonly width: number;
  readonly height: number;
}
interface Point {
  readonly x: number;
  readonly y: number;
}
export type FrameHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}
function snapSize(value: number, sizes: readonly number[], max: number) {
  const rounded = clamp(value, 1, max);
  const nearest = sizes
    .filter((size) => size <= max && Math.abs(size - rounded) <= 1)
    .sort((a, b) => Math.abs(a - rounded) - Math.abs(b - rounded) || a - b)[0];
  return nearest ?? rounded;
}
export function drawFrameRegion(
  start: Point,
  end: Point,
  sheet: Size,
  peers: readonly ImageFrame[],
): Rect {
  const x = clamp(Math.min(start.x, end.x), 0, sheet.width - 1);
  const y = clamp(Math.min(start.y, end.y), 0, sheet.height - 1);
  return {
    x,
    y,
    width: snapSize(
      Math.round(Math.max(start.x, end.x)) - x,
      peers.map((f) => f.region.width),
      sheet.width - x,
    ),
    height: snapSize(
      Math.round(Math.max(start.y, end.y)) - y,
      peers.map((f) => f.region.height),
      sheet.height - y,
    ),
  };
}
export function moveFrameRegion(region: Rect, dx: number, dy: number, sheet: Size): Rect {
  return {
    ...region,
    x: clamp(region.x + dx, 0, sheet.width - region.width),
    y: clamp(region.y + dy, 0, sheet.height - region.height),
  };
}
export function resizeFrameRegion(
  region: Rect,
  handle: FrameHandle,
  dx: number,
  dy: number,
  sheet: Size,
  peers: readonly ImageFrame[],
): Rect {
  let { x, y, width, height } = region;
  const right = x + width,
    bottom = y + height;
  if (handle.includes("w")) {
    width = snapSize(
      right - clamp(x + dx, 0, right - 1),
      peers.map((f) => f.region.width),
      right,
    );
    x = right - width;
  }
  if (handle.includes("e"))
    width = snapSize(
      width + dx,
      peers.map((f) => f.region.width),
      sheet.width - x,
    );
  if (handle.includes("n")) {
    height = snapSize(
      bottom - clamp(y + dy, 0, bottom - 1),
      peers.map((f) => f.region.height),
      bottom,
    );
    y = bottom - height;
  }
  if (handle.includes("s"))
    height = snapSize(
      height + dy,
      peers.map((f) => f.region.height),
      sheet.height - y,
    );
  return { x, y, width, height };
}
export function lockFrameSizes(boxes: readonly FrameBox[], size: Size, sheet: Size): FrameBox[] {
  const width = clamp(size.width, 1, sheet.width),
    height = clamp(size.height, 1, sheet.height);
  return boxes.map((f) => ({
    ...f,
    edited: true,
    width: Math.min(160, width),
    height: Math.min(168, height),
    region: {
      width,
      height,
      x: Math.min(f.region.x, sheet.width - width),
      y: Math.min(f.region.y, sheet.height - height),
    },
  }));
}
/** Give found figures the smallest shared crop that contains every figure. */
export function linkFoundFrames(boxes: readonly FrameBox[], sheet: Size): FrameBox[] {
  if (!boxes.length) return [];
  const width = Math.max(...boxes.map((f) => f.region.width));
  const height = Math.max(...boxes.map((f) => f.region.height));
  return boxes.map((f) => {
    const region = {
      x: Math.min(f.region.x, sheet.width - width),
      y: Math.min(f.region.y, sheet.height - height),
      width,
      height,
    };
    return { ...f, region, linked: true, ...scaleImageFrame(region, f.height) };
  });
}
/** Resize a linked set by the same edge deltas, constrained by every member. */
export function resizeLinkedFrameBoxes(
  boxes: readonly FrameBox[],
  id: string,
  handle: FrameHandle,
  dx: number,
  dy: number,
  sheet: Size,
): FrameBox[] {
  const active = boxes.find((f) => f.id === id);
  if (!active) return [...boxes];
  const members = boxes.filter((f) => f.id === id || (active.linked && f.linked));
  let width = active.region.width,
    height = active.region.height;
  if (handle.includes("e") || handle.includes("w")) {
    const max = Math.min(
      ...members.map((f) =>
        handle.includes("w") ? f.region.x + f.region.width : sheet.width - f.region.x,
      ),
    );
    width = clamp(width + (handle.includes("w") ? -dx : dx), 1, max);
  }
  if (handle.includes("n") || handle.includes("s")) {
    const max = Math.min(
      ...members.map((f) =>
        handle.includes("n") ? f.region.y + f.region.height : sheet.height - f.region.y,
      ),
    );
    height = clamp(height + (handle.includes("n") ? -dy : dy), 1, max);
  }
  return boxes.map((f) => {
    if (!members.includes(f)) return f;
    const region = {
      x: f.region.x + (handle.includes("w") ? f.region.width - width : 0),
      y: f.region.y + (handle.includes("n") ? f.region.height - height : 0),
      width,
      height,
    };
    return { ...f, edited: true, region };
  });
}
/** Relink to the first shared size while preserving the figure's top-left offset. */
export function toggleFrameLink(boxes: readonly FrameBox[], id: string, sheet: Size): FrameBox[] {
  const active = boxes.find((f) => f.id === id);
  if (!active) return [...boxes];
  const shared = boxes.find((f) => f.id !== id && f.linked)?.region;
  return boxes.map((f) => {
    if (f.id !== id) return f;
    const region =
      !f.linked && shared ? { ...f.region, width: shared.width, height: shared.height } : f.region;
    if (region.x + region.width > sheet.width || region.y + region.height > sheet.height)
      throw new Error("Move this frame inside the sheet to link it.");
    return { ...f, edited: true, linked: !f.linked, region };
  });
}
export function orderFrameBoxes(boxes: readonly FrameBox[]): FrameBox[] {
  const rows: FrameBox[][] = [];
  let row: FrameBox[] = [];
  let bottom = 0;
  for (const frame of [...boxes].sort((a, b) => a.region.y - b.region.y)) {
    if (!row.length || frame.region.y >= bottom) {
      row = [];
      rows.push(row);
      bottom = frame.region.y + frame.region.height;
    } else bottom = Math.min(bottom, frame.region.y + frame.region.height);
    row.push(frame);
  }
  return rows.flatMap((frames) => frames.sort((a, b) => a.region.x - b.region.x));
}
export function reorderFrameBoxes(
  boxes: readonly FrameBox[],
  source: string,
  destination: string,
): FrameBox[] {
  const from = boxes.findIndex((f) => f.id === source),
    to = boxes.findIndex((f) => f.id === destination);
  if (from < 0 || to < 0 || from === to) return [...boxes];
  const next = boxes.map((f) => ({ ...f, edited: true }));
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
export function assignFrameLoop(
  boxes: readonly FrameBox[],
  ids: readonly string[],
  loop: number,
): FrameBox[] {
  if (!Number.isInteger(loop) || loop < 0 || loop > 7)
    throw new Error("Choose a loop from 0 to 7.");
  return boxes.map((f) => (ids.includes(f.id) ? { ...f, loop, edited: true } : f));
}
export function mergeFrameSuggestions(
  boxes: readonly FrameBox[],
  suggestions: readonly FrameBox[],
  replace = false,
): FrameBox[] {
  const kept = replace ? [] : boxes.filter((f) => f.edited);
  const fresh = suggestions.filter(
    (f) =>
      !kept.some(
        ({ region: r }) =>
          f.region.x < r.x + r.width &&
          f.region.x + f.region.width > r.x &&
          f.region.y < r.y + r.height &&
          f.region.y + f.region.height > r.y,
      ),
  );
  return orderFrameBoxes([...kept, ...fresh]);
}
