/**
 * The draggable points of picture source lines, in exactly the operand order
 * `setLinePoint` (editSource.ts) numbers them, so a handle's index is the
 * `pointIndex` of the `setPoint` edit that moves it. `copy` and `raw` lines
 * have none: their coordinates cannot be rewritten.
 */

import type { PictureDocument } from "./pictureDocument.ts";
import { commandHead } from "./editState.ts";
import { commandTokens } from "./editSource.ts";

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
