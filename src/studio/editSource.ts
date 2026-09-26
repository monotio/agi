/**
 * Coordinate rewriting of single picture source lines for Room Studio edits.
 * Tokens are replaced one for one, so whitespace and comments survive. Every
 * rewritten coordinate is checked against the surface; nothing is clamped.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import { commandHead } from "./editState.ts";

/** A refused edit; `applyEdit` turns it into `{ error }`. */
export class EditRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditRefusal";
  }
}

const PAIR = /^(-?\d+),(-?\d+)$/;
const NUMBER = /^-?\d+$/;

export const MAX_X = SCREEN_WIDTH - 1;
export const MAX_Y = SCREEN_HEIGHT - 1;

export const onSurface = (x: number, y: number): boolean =>
  Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x <= MAX_X && y >= 0 && y <= MAX_Y;

/** The whitespace-separated tokens of the line's command part. */
export function commandTokens(line: string): string[] {
  const hash = line.indexOf("#");
  return (hash >= 0 ? line.slice(0, hash) : line).split(/\s+/).filter((t) => t.length > 0);
}

/** The line with its command tokens replaced one for one; whitespace and comment kept. */
export function replaceTokens(line: string, tokens: readonly string[]): string {
  const hash = line.indexOf("#");
  const code = hash >= 0 ? line.slice(0, hash) : line;
  let i = 0;
  return code.replace(/\S+/g, () => tokens[i++]!) + (hash >= 0 ? line.slice(hash) : "");
}

function pair(token: string): [number, number] | null {
  const match = PAIR.exec(token);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** The vertices of a `rel` line: its start, then each delta applied in turn. */
function relVertices(tokens: readonly string[]): [number, number][] {
  const [x0, y0] = pair(tokens[1]!)!;
  const vertices: [number, number][] = [[x0, y0]];
  for (const token of tokens.slice(2)) {
    const [dx, dy] = pair(token)!;
    const [x, y] = vertices[vertices.length - 1]!;
    vertices.push([x + dx, y + dy]);
  }
  return vertices;
}

/** Whether corner step `k` (1-based) of `head` sets x; an `xcorner` starts horizontally. */
const stepIsX = (head: string, k: number): boolean => (head === "xcorner") === (k % 2 === 1);

/**
 * The line with every absolute coordinate moved by dx,dy: all pairs of
 * line/polyline/polygon/rect/fill/plot, the start of `rel` (its deltas stay),
 * and the start and each step of `xcorner`/`ycorner` on the step's own axis.
 * State lines are returned unchanged. Refuses `copy` and `raw` lines and any
 * coordinate (including a `rel` vertex) that would leave the surface.
 */
export function translateLine(line: string, lineNo: number, dx: number, dy: number): string {
  const tokens = commandTokens(line);
  const head = commandHead(line);
  const check = (x: number, y: number): void => {
    if (!onSurface(x, y)) {
      throw new EditRefusal(
        `moving by ${dx},${dy} puts line ${lineNo} off the surface at ${x},${y} (x 0..${MAX_X}, y 0..${MAX_Y})`,
      );
    }
  };
  const shift = (token: string): string => {
    const point = pair(token);
    if (!point) return token;
    check(point[0] + dx, point[1] + dy);
    return `${point[0] + dx},${point[1] + dy}`;
  };
  switch (head) {
    case "line":
    case "polyline":
    case "polygon":
    case "rect":
    case "fill":
    case "plot":
      return replaceTokens(line, [tokens[0]!, ...tokens.slice(1).map(shift)]);
    case "rel":
      for (const [x, y] of relVertices(tokens)) check(x + dx, y + dy);
      return replaceTokens(line, [tokens[0]!, shift(tokens[1]!), ...tokens.slice(2)]);
    case "xcorner":
    case "ycorner": {
      const out = [tokens[0]!, shift(tokens[1]!)];
      const [x0, y0] = pair(tokens[1]!)!;
      const vertex = [x0 + dx, y0 + dy];
      tokens.slice(2).forEach((token, index) => {
        const axis = stepIsX(head, index + 1) ? 0 : 1;
        vertex[axis] = Number(token) + (axis === 0 ? dx : dy);
        check(vertex[0]!, vertex[1]!);
        out.push(String(vertex[axis]));
      });
      return replaceTokens(line, out);
    }
    case "copy":
      throw new EditRefusal(
        `line ${lineNo} is a copy; its output would move with its source lines, not with this item. Replace the copy with the lines it expands to first`,
      );
    case "raw":
      throw new EditRefusal(
        `line ${lineNo} is raw bytes, whose coordinates cannot be read safely; this item cannot be moved`,
      );
    default:
      return line;
  }
}

/**
 * The line with its vertex `index` (0-based, in the command's operand order)
 * set to x,y, other vertices staying where they are. For `rect` the vertices
 * are the two corners; for `plot` the points (seeds skipped); for `rel` the
 * start and each vertex its deltas reach, so moving one rewrites the deltas
 * on both sides of it (each must stay within -7..7); for `xcorner`/`ycorner`
 * the start and the vertex after each step: its step takes the coordinate on
 * the step's axis and the step before it (or the start) the other, keeping
 * every segment axis-aligned.
 */
export function setLinePoint(
  line: string,
  lineNo: number,
  index: number,
  x: number,
  y: number,
): string {
  if (!onSurface(x, y)) {
    throw new EditRefusal(`point ${x},${y} is off the surface (x 0..${MAX_X}, y 0..${MAX_Y})`);
  }
  const tokens = commandTokens(line);
  const head = commandHead(line);
  const outOfRange = (count: number): EditRefusal =>
    new EditRefusal(
      `line ${lineNo} has ${count} point${count === 1 ? "" : "s"}; no point ${index}`,
    );
  if (!Number.isInteger(index) || index < 0) throw outOfRange(0);
  switch (head) {
    case "line":
    case "polyline":
    case "polygon":
    case "rect":
    case "fill":
    case "plot": {
      const positions = tokens.flatMap((token, k) => (k > 0 && PAIR.test(token) ? [k] : []));
      const at = positions[index];
      if (at === undefined) throw outOfRange(positions.length);
      const out = [...tokens];
      out[at] = `${x},${y}`;
      return replaceTokens(line, out);
    }
    case "rel": {
      const vertices = relVertices(tokens);
      if (index >= vertices.length) throw outOfRange(vertices.length);
      vertices[index] = [x, y];
      const out = [tokens[0]!, `${vertices[0]![0]},${vertices[0]![1]}`];
      for (let k = 1; k < vertices.length; k++) {
        const ddx = vertices[k]![0] - vertices[k - 1]![0];
        const ddy = vertices[k]![1] - vertices[k - 1]![1];
        if (Math.abs(ddx) > 7 || Math.abs(ddy) > 7) {
          throw new EditRefusal(
            `line ${lineNo}: rel delta ${k} would be ${ddx},${ddy}, outside -7..7`,
          );
        }
        out.push(`${ddx},${ddy}`);
      }
      return replaceTokens(line, out);
    }
    case "xcorner":
    case "ycorner": {
      const steps = tokens.length - 2;
      if (index > steps) throw outOfRange(steps + 1);
      const out = [...tokens];
      if (index === 0) {
        out[1] = `${x},${y}`;
        return replaceTokens(line, out);
      }
      const isX = stepIsX(head, index);
      out[index + 1] = String(isX ? x : y);
      const other = isX ? y : x;
      if (index === 1) {
        const [x0, y0] = pair(tokens[1]!)!;
        out[1] = isX ? `${x0},${other}` : `${other},${y0}`;
      } else {
        out[index] = String(other);
      }
      return replaceTokens(line, out);
    }
    default:
      throw new EditRefusal(`line ${lineNo} ('${head || "comment"}') has no points to set`);
  }
}

/** The `a-b` range of a `copy` line, or null for any other line. */
export function copyRange(line: string): { from: number; to: number } | null {
  if (commandHead(line) !== "copy") return null;
  const match = /^(\d+)-(\d+)$/.exec(commandTokens(line)[1] ?? "");
  return match ? { from: Number(match[1]), to: Number(match[2]) } : null;
}

/** The `copy` line with its range renumbered. */
export function withCopyRange(line: string, from: number, to: number): string {
  const tokens = commandTokens(line);
  tokens[1] = `${from}-${to}`;
  return replaceTokens(line, tokens);
}

/** Whether a `raw` line's bytes include any of `commands`. */
export function rawIncludes(line: string, commands: readonly number[]): boolean {
  if (commandHead(line) !== "raw") return false;
  return commandTokens(line)
    .slice(1)
    .some((token) => NUMBER.test(token) && commands.includes(Number(token)));
}
