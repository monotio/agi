/**
 * Picture elements: groups of source lines that draw one thing, from one
 * traced render. Behind `annotatePictureSource` (agent orientation) and the
 * Room Studio's native items (`src/studio/nativeItems.ts`).
 */

import { createPictureSurface, SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import { renderPicture } from "./renderer.ts";
import {
  compilePictureSource,
  disassemblePicture,
  type CompilePictureResult,
  type PictureSourceOptions,
} from "./source.ts";
import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";

/** Drawing state in effect when the command at `offset` starts; null is a disabled channel. */
export interface PictureCommandState {
  offset: number;
  visual: number | null;
  priority: number | null;
}

/**
 * The drawing state before each command of a stream, in byte order, mirroring
 * the renderer's command loop: bytes below 0xf0 at a command boundary and
 * commands above the profile's vocabulary are skipped, and 0xf0/0xf2/0xf9 read
 * a raw operand. A final entry at `bytes.length` holds the state after the
 * last command.
 */
export function pictureCommandStates(
  bytes: Uint8Array,
  profile: AgiProfile = DEFAULT_V2_PROFILE,
): PictureCommandState[] {
  const out: PictureCommandState[] = [];
  let visual: number | null = null;
  let priority: number | null = null;
  let pos = 0;
  scan: while (pos < bytes.length) {
    const command = bytes[pos]!;
    const offset = pos;
    pos += 1;
    if (command < 0xf0) continue;
    out.push({ offset, visual, priority });
    if (command === 0xff) break;
    if (command > profile.pictureMaxCommand) continue;
    switch (command) {
      case 0xf0:
      case 0xf2:
      case 0xf9: {
        const operand = bytes[pos];
        if (operand === undefined) break scan;
        pos += 1;
        if (command === 0xf0) visual = operand & 0x0f;
        else if (command === 0xf2) priority = operand & 0x0f;
        break;
      }
      case 0xf1:
        visual = null;
        break;
      case 0xf3:
        priority = null;
        break;
      default:
        break;
    }
  }
  out.push({ offset: bytes.length, visual, priority });
  return out;
}

/** The state in effect at byte `offset`: that of the first command at or after it. */
export function pictureStateAt(
  states: readonly PictureCommandState[],
  offset: number,
): PictureCommandState {
  let lo = 0;
  let hi = states.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (states[mid]!.offset < offset) lo = mid + 1;
    else hi = mid;
  }
  return states[lo]!;
}

/** Plane bits of the cell writes credited to a line. */
export const PLANE_VISUAL = 1;
/** Priority values 0..3: barriers, triggers and water. */
export const PLANE_CONTROL = 2;
/** Priority values 4..15: depth bands. */
export const PLANE_DEPTH = 4;

export interface PictureBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PictureElements {
  /** Source lines as the compiler numbers them (index = line - 1). */
  lines: readonly string[];
  compiled: CompilePictureResult;
  /** Per line: element 1..count, numbered by first appearance, or 0 for a loose line. */
  elementOf: Int32Array;
  count: number;
  /** Per line: the cells whose value it changed, ascending. */
  pixels: readonly (readonly number[])[];
  /** Per line: bounding box of `pixels`, or null. */
  boxes: readonly (PictureBox | null)[];
  /** Per line: PLANE_* bits of the cell writes credited to it. */
  planes: Uint8Array;
}

export interface GroupPictureOptions extends PictureSourceOptions {
  /**
   * Credit a line whose bytes continue the previous command (its first byte
   * is below 0xf0, e.g. a `raw` rel continuation) to that command's line, so
   * both land in one element as the renderer's opcode ownership does.
   */
  joinContinuations?: boolean;
}

/**
 * Group the lines of picture source into drawing elements: a command joins
 * the element of the previous drawing command when their pixels are adjacent
 * (an outline drawn as several strokes); a fill joins the element that wrote
 * most of the pixels bounding its region (an outline and the fills seeded
 * inside it, wherever they sit in the file); non-drawing lines (state lines,
 * comments, commands that changed nothing) attach to the next drawing command,
 * and those after the last one, or `end`, stay loose. Throws
 * PictureSourceSyntaxError when the source does not compile (leniently).
 */
export function groupPictureElements(source: string, opts?: GroupPictureOptions): PictureElements {
  const profile = opts?.profile ?? DEFAULT_V2_PROFILE;
  const lines = source.split(/\r?\n/);
  const stripped = lines.map((raw) => {
    const hash = raw.indexOf("#");
    return (hash >= 0 ? raw.slice(0, hash) : raw).trim();
  });
  const n = lines.length;
  const W = SCREEN_WIDTH;
  const H = SCREEN_HEIGHT;
  const total = W * H;

  // The pixels each line changes, and the last writer per pixel, from one
  // traced render. A write belongs to the line holding the last byte consumed
  // before it: exactly what re-rendering each line prefix yielded, since a
  // truncated stream writes nothing after reading its terminator.
  const compiled = compilePictureSource(source, { lenient: true, profile });
  const lineOfByte = new Int32Array(compiled.bytes.length).fill(-1);
  const headOf = new Int32Array(n);
  for (let k = 0; k < n; k++) headOf[k] = k;
  let previous = -1;
  for (const span of compiled.spans) {
    const k = span.line - 1;
    lineOfByte.fill(k, span.start, span.end);
    if (opts?.joinContinuations && previous >= 0 && compiled.bytes[span.start]! < 0xf0) {
      headOf[k] = headOf[previous]!;
    }
    previous = k;
  }
  const states = pictureCommandStates(compiled.bytes, profile);
  const surface = createPictureSurface();
  const writer = new Int32Array(total).fill(-1);
  const pixels: number[][] = Array.from({ length: n }, (): number[] => []);
  const boxes: (PictureBox | null)[] = new Array(n).fill(null);
  const planes = new Uint8Array(n);
  // Cells the current line wrote, with their packed value before the line.
  const touched: number[] = [];
  const touchedBy = new Int32Array(total).fill(-1);
  const before = new Uint16Array(total);
  let current = -1;
  let stateOpcode = -1;
  let statePlanes = 0;
  const closeLine = (): void => {
    if (current < 0) return;
    const px = pixels[current]!;
    for (const i of touched) {
      if (((surface.visual[i]! << 8) | surface.priority[i]!) !== before[i]) px.push(i);
    }
    touched.length = 0;
    if (px.length === 0) return;
    px.sort((a, b) => a - b); // fill votes break ties by pixel order
    const box = { x0: W, y0: H, x1: -1, y1: -1 };
    for (const i of px) {
      writer[i] = current;
      const x = i % W;
      const y = (i - x) / W;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
    }
    boxes[current] = box;
  };
  renderPicture(compiled.bytes, surface, {
    profile,
    onCellWrite: (index, opcode, consumed) => {
      const k = headOf[lineOfByte[consumed - 1]!]!;
      if (k !== current) {
        closeLine();
        current = k;
      }
      if (opcode !== stateOpcode) {
        stateOpcode = opcode;
        const { visual, priority } = pictureStateAt(states, opcode);
        statePlanes =
          (visual === null ? 0 : PLANE_VISUAL) |
          (priority === null ? 0 : priority < 4 ? PLANE_CONTROL : PLANE_DEPTH);
      }
      planes[k] = planes[k]! | statePlanes;
      if (touchedBy[index] === k) return;
      touchedBy[index] = k;
      before[index] = (surface.visual[index]! << 8) | surface.priority[index]!;
      touched.push(index);
    },
  });
  closeLine();

  // Union-find over commands.
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const mask = new Int32Array(total).fill(-1); // command index owning the pixel, for adjacency tests
  let prevDrawing = -1;
  for (let k = 0; k < n; k++) {
    const px = pixels[k]!;
    if (px.length === 0) continue;
    const isFill = /^fill\b/i.test(stripped[k]!);
    if (isFill) {
      // Boundary writers: neighbours of the region that are not in the region.
      const inRegion = new Uint8Array(total);
      for (const i of px) inRegion[i] = 1;
      const votes = new Map<number, number>();
      for (const i of px) {
        const x = i % W;
        for (const nb of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
          if (nb < 0 || nb >= total || inRegion[nb]) continue;
          const w = writer[nb]!;
          if (w >= 0 && w !== k) votes.set(w, (votes.get(w) ?? 0) + 1);
        }
      }
      let bestW = -1;
      let bestN = 0;
      for (const [w, c] of votes) if (c > bestN) [bestW, bestN] = [w, c];
      if (bestW >= 0) union(k, bestW);
    } else if (prevDrawing >= 0) {
      let touches = false;
      for (const i of px) {
        const x = i % W;
        for (const nb of [i, x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
          if (nb >= 0 && nb < total && mask[nb] === prevDrawing) {
            touches = true;
            break;
          }
        }
        if (touches) break;
      }
      if (touches) union(k, prevDrawing);
    }
    for (const i of px) mask[i] = k;
    prevDrawing = k;
  }

  // Attach non-drawing lines to the next drawing command and continuations to
  // their command; number elements by first appearance.
  const rootOf = new Int32Array(n).fill(-1);
  let pending: number[] = [];
  for (let k = 0; k < n; k++) {
    const head = headOf[k]!;
    if (head !== k && rootOf[head]! >= 0) {
      rootOf[k] = rootOf[head]!;
    } else if (pixels[k]!.length > 0) {
      const root = find(k);
      for (const s of pending) rootOf[s] = root;
      pending = [];
      rootOf[k] = root;
    } else if (!/^end\b/i.test(stripped[k]!)) {
      pending.push(k);
    }
  }
  const ids = new Map<number, number>();
  const elementOf = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const root = rootOf[k]!;
    if (root < 0) continue;
    if (!ids.has(root)) ids.set(root, ids.size + 1);
    elementOf[k] = ids.get(root)!;
  }
  return { lines, compiled, elementOf, count: ids.size, pixels, boxes, planes };
}

/**
 * Disassemble a picture and annotate it with its drawing elements
 * (`groupPictureElements`). Output is the plain disassembly plus comments:
 * a header `# element N: lines a-b, c-d  bbox x0-x1 y0-y1  colours 6,2` per
 * element (line numbers of the annotated text, usable with `copy`) and a
 * `# --- element N` marker before each range. Compiling the annotated text
 * yields the identical byte stream.
 */
export function annotatePictureSource(bytes: Uint8Array, opts?: PictureSourceOptions): string {
  const profile = opts?.profile ?? DEFAULT_V2_PROFILE;
  const source = disassemblePicture(bytes, { profile });
  const { lines, elementOf, count, pixels, boxes } = groupPictureElements(source, { profile });
  const srcLines = lines.slice();
  if (srcLines[srcLines.length - 1] === "") srcLines.pop();
  const n = srcLines.length;
  const W = SCREEN_WIDTH;
  const H = SCREEN_HEIGHT;

  // Runs of consecutive lines per element -> output line numbers (headers + markers included).
  const runs: { id: number; from: number; to: number }[] = [];
  for (let k = 0; k < n; k++) {
    const id = elementOf[k]!;
    const last = runs[runs.length - 1];
    if (last && last.id === id && last.to === k - 1) last.to = k;
    else runs.push({ id, from: k, to: k });
  }
  const body: string[] = [];
  const ranges = new Map<number, string[]>();
  const info = new Map<number, PictureBox & { colours: Set<number> }>();
  let colour = -1; // runs cover every line in order
  for (const run of runs) {
    if (run.id > 0) body.push(`# --- element ${run.id}`);
    const start = count + body.length + 1;
    for (let k = run.from; k <= run.to; k++) {
      const vis = /^vis (\d+)/i.exec(srcLines[k]!);
      if (vis) colour = Number(vis[1]) & 0x0f;
      body.push(srcLines[k]!);
      if (run.id === 0) continue;
      const rec = info.get(run.id) ?? { x0: W, y0: H, x1: -1, y1: -1, colours: new Set<number>() };
      const b = boxes[k];
      if (b) {
        rec.x0 = Math.min(rec.x0, b.x0);
        rec.y0 = Math.min(rec.y0, b.y0);
        rec.x1 = Math.max(rec.x1, b.x1);
        rec.y1 = Math.max(rec.y1, b.y1);
      }
      if (pixels[k]!.length > 0 && colour >= 0) rec.colours.add(colour);
      info.set(run.id, rec);
    }
    if (run.id > 0) {
      const end = count + body.length;
      const list = ranges.get(run.id) ?? [];
      list.push(`${start}-${end}`);
      ranges.set(run.id, list);
    }
  }
  const header: string[] = [];
  for (let id = 1; id <= count; id++) {
    const rec = info.get(id)!;
    const colours = [...rec.colours].sort((a, b) => a - b).join(",");
    header.push(
      `# element ${id}: lines ${ranges.get(id)!.join(", ")}  bbox x${rec.x0}-${rec.x1} y${rec.y0}-${rec.y1}  colours ${colours}`,
    );
  }
  return [...header, ...body].join("\n") + "\n";
}
