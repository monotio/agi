/**
 * The draggable points of picture source lines, in exactly the operand order
 * `setLinePoint` (editSource.ts) numbers them, so a handle's index is the
 * `pointIndex` of the `setPoint` edit that moves it. `copy` and `raw` lines
 * have none: their coordinates cannot be rewritten.
 */

import type { PictureDocument } from "./pictureDocument.ts";
import { commandHead } from "./editState.ts";
import { commandTokens, INSERTABLE_HEADS } from "./editSource.ts";

export interface LinePoint {
  readonly x: number;
  readonly y: number;
}

/** One point of one source line: a vertex, or a fill's seed. */
export interface LineHandle extends LinePoint {
  /** 1-based source line. */
  readonly line: number;
  /** The `pointIndex` of a `setPoint` edit on that line. */
  readonly index: number;
  readonly kind: "vertex" | "seed";
}

const PAIR = /^(-?\d+),(-?\d+)$/;

function pair(token: string | undefined): [number, number] | null {
  const match = PAIR.exec(token ?? "");
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** The points of one source line, in `setLinePoint` order; empty for any other line. */
export function linePoints(line: string): LinePoint[] {
  const tokens = commandTokens(line);
  const head = commandHead(line);
  switch (head) {
    case "line":
    case "polyline":
    case "polygon":
    case "rect":
    case "fill":
    case "plot":
      return tokens.slice(1).flatMap((token) => {
        const point = pair(token);
        return point ? [{ x: point[0], y: point[1] }] : [];
      });
    case "rel": {
      const start = pair(tokens[1]);
      if (!start) return [];
      const out: LinePoint[] = [{ x: start[0], y: start[1] }];
      for (const token of tokens.slice(2)) {
        const delta = pair(token);
        if (!delta) return out;
        const last = out[out.length - 1]!;
        out.push({ x: last.x + delta[0], y: last.y + delta[1] });
      }
      return out;
    }
    case "xcorner":
    case "ycorner": {
      const start = pair(tokens[1]);
      if (!start) return [];
      const vertex = [start[0], start[1]];
      const out: LinePoint[] = [{ x: vertex[0]!, y: vertex[1]! }];
      tokens.slice(2).forEach((token, index) => {
        // Step k (1-based) of an xcorner sets x when k is odd; a ycorner starts with y.
        const setsX = (head === "xcorner") === ((index + 1) % 2 === 1);
        vertex[setsX ? 0 : 1] = Number(token);
        out.push({ x: vertex[0]!, y: vertex[1]! });
      });
      return out;
    }
    default:
      return [];
  }
}

/** Every point of an item's command lines, in source order; empty for an unknown item. */
export function itemHandles(document: PictureDocument, itemId: string): LineHandle[] {
  const item = document.items.find((candidate) => candidate.id === itemId);
  if (!item) return [];
  return item.commandLines.flatMap((line) => {
    const text = document.lines[line - 1] ?? "";
    const kind = commandHead(text) === "fill" ? "seed" : "vertex";
    return linePoints(text).map((point, index) => ({ ...point, line, index, kind }));
  });
}

/** Where an `insertPoint` edit puts a new vertex on an item's line. */
export interface PointInsertion extends LinePoint {
  /** 1-based source line. */
  readonly line: number;
  /** The `pointIndex` of the `insertPoint` edit: the new vertex's index. */
  readonly pointIndex: number;
  /** From the asked point to the segment, in logical rows (x scaled by the pixel aspect). */
  readonly distance: number;
}

/**
 * The point on the item's nearest line segment to `at`, as an `insertPoint`
 * would add it: the closest point of the segment, rounded to a pixel that is
 * neither of its ends. Segments of line, polyline, polygon (its closing edge
 * too) and rel lines count; one too short to hold a pixel between its ends
 * does not. `aspect` is a logical pixel's width in rows (2 on the 160-wide
 * picture shown 2:1). Undefined when the item has no such segment.
 */
export function nearestInsertion(
  document: PictureDocument,
  itemId: string,
  at: LinePoint,
  aspect = 2,
): PointInsertion | undefined {
  const item = document.items.find((candidate) => candidate.id === itemId);
  let best: PointInsertion | undefined;
  for (const line of item?.commandLines ?? []) {
    const text = document.lines[line - 1] ?? "";
    const head = commandHead(text);
    if (!INSERTABLE_HEADS.includes(head)) continue;
    const points = linePoints(text);
    const ends = points.slice(1).map((b, k) => [points[k]!, b, k + 1] as const);
    if (head === "polygon" && points.length > 2)
      ends.push([points.at(-1)!, points[0]!, points.length]);
    for (const [a, b, pointIndex] of ends) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (steps < 2) continue;
      const along =
        ((at.x - a.x) * dx * aspect * aspect + (at.y - a.y) * dy) /
        (dx * dx * aspect * aspect + dy * dy);
      const t = Math.min(1 - 1 / steps, Math.max(1 / steps, along));
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const distance = Math.hypot((at.x - px) * aspect, at.y - py);
      if (best && best.distance <= distance) continue;
      best = { line, pointIndex, x: Math.round(px), y: Math.round(py), distance };
    }
  }
  return best;
}
