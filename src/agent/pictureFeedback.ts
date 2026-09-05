/**
 * Numeric picture feedback for the write_picture tool result
 * (the authoring contract, "Perception": composition did not move with prompt rules, a
 * bounds table or a reference colour grid, so the lever is numbers about the
 * agent's OWN render coming back in the tool result).
 *
 * Three measurements, all deterministic and model-free:
 *
 * - `colourGrid` — the render reduced to one dominant EGA colour index per
 *   coarse cell, so placement and scale are readable as text.
 * - `layoutDiff` — for every `# layout: <name> x<a>-<b> y<c>-<d> colour <n>`
 *   comment the agent declared, what actually landed inside that box.
 * - `editReport` — the live-patching safety metrics: how much of the previous
 *   source survived in order, and how far the pixel change spread beyond the
 *   one region it was supposed to touch.
 *
 * Zero dependencies; browser, worker and Node safe. Every function takes
 * explicit dimensions so it can be checked against hand-computed tiny buffers.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";

export interface SurfaceDims {
  width: number;
  height: number;
}

/** The real picture surface; tests pass tiny ones. */
export const PICTURE_DIMS: SurfaceDims = { width: SCREEN_WIDTH, height: SCREEN_HEIGHT };

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Dominant colour index per cell of a cols x rows grid over the visual
 * surface, one text line per row prefixed with the row's y range. Cell
 * boundaries are floor-divided, so dimensions that do not divide evenly still
 * cover the whole surface.
 */
export function colourGrid(
  visual: Uint8Array,
  cols = 8,
  rows = 7,
  dims: SurfaceDims = PICTURE_DIMS,
): string {
  const { width, height } = dims;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const yStart = Math.floor((r * height) / rows);
    const yEnd = Math.floor(((r + 1) * height) / rows);
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const xStart = Math.floor((c * width) / cols);
      const xEnd = Math.floor(((c + 1) * width) / cols);
      const counts = new Array<number>(16).fill(0);
      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) counts[visual[y * width + x]! & 0x0f]!++;
      }
      cells.push(String(counts.indexOf(Math.max(...counts))).padStart(2));
    }
    lines.push(
      `y${String(yStart).padStart(3)}-${String(yEnd - 1).padStart(3)}: ${cells.join(" ")}`,
    );
  }
  return lines.join("\n");
}

export interface LayoutMass {
  name: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  colour: number;
}

/** `# layout: <name> x<a>-<b> y<c>-<d> colour <n>` lines anywhere in the source. */
export function parseLayout(source: string): LayoutMass[] {
  const re = /^#\s*layout:\s*(\S+)\s+x(\d+)-(\d+)\s+y(\d+)-(\d+)\s+colou?r\s+(\d+)/i;
  const out: LayoutMass[] = [];
  for (const line of source.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (!m) continue;
    out.push({
      name: m[1]!,
      x0: Number(m[2]),
      x1: Number(m[3]),
      y0: Number(m[4]),
      y1: Number(m[5]),
      colour: Number(m[6]) & 0x0f,
    });
  }
  return out;
}

export type LayoutVerdict = "OK" | "UNDERFILLED" | "SHIFTED" | "MISSING";

export interface LayoutMassDiff {
  mass: LayoutMass;
  /** Most common colour index inside the declared box. */
  dominant: number;
  /** Fraction of the declared box painted in the declared colour, 0..1. */
  coverage: number;
  /** Bounding box and size of the largest connected declared-colour region overlapping the box. */
  rendered: (Box & { cells: number }) | null;
  verdict: LayoutVerdict;
}

/** Declared colour covering less than this share of its box is UNDERFILLED. */
const COVERAGE_FLOOR = 0.4;

/**
 * Largest 4-connected region of `colour` that overlaps the declared box,
 * measured over the whole surface so a mass that spilled outside is reported
 * at its true extent.
 */
function largestRegionOverlapping(
  visual: Uint8Array,
  colour: number,
  mass: LayoutMass,
  dims: SurfaceDims,
): (Box & { cells: number }) | null {
  const { width, height } = dims;
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  let best: (Box & { cells: number }) | null = null;
  for (let sy = Math.max(0, mass.y0); sy <= Math.min(height - 1, mass.y1); sy++) {
    for (let sx = Math.max(0, mass.x0); sx <= Math.min(width - 1, mass.x1); sx++) {
      const start = sy * width + sx;
      if (seen[start] || (visual[start]! & 0x0f) !== colour) continue;
      seen[start] = 1;
      stack.push(start);
      let x0 = width;
      let y0 = height;
      let x1 = -1;
      let y1 = -1;
      let cells = 0;
      while (stack.length > 0) {
        const i = stack.pop()!;
        cells++;
        const x = i % width;
        const y = (i - x) / width;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        const neighbours = [
          x > 0 ? i - 1 : -1,
          x < width - 1 ? i + 1 : -1,
          y > 0 ? i - width : -1,
          y < height - 1 ? i + width : -1,
        ];
        for (const n of neighbours) {
          if (n < 0 || seen[n] || (visual[n]! & 0x0f) !== colour) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (!best || cells > best.cells) best = { x0, y0, x1, y1, cells };
    }
  }
  return best;
}

/** Intended-vs-rendered comparison for every `# layout:` mass declared in the source. */
export function layoutDiff(
  source: string,
  visual: Uint8Array,
  dims: SurfaceDims = PICTURE_DIMS,
): LayoutMassDiff[] {
  const { width, height } = dims;
  const out: LayoutMassDiff[] = [];
  for (const mass of parseLayout(source)) {
    const counts = new Array<number>(16).fill(0);
    let boxCells = 0;
    for (let y = Math.max(0, mass.y0); y <= Math.min(height - 1, mass.y1); y++) {
      for (let x = Math.max(0, mass.x0); x <= Math.min(width - 1, mass.x1); x++) {
        counts[visual[y * width + x]! & 0x0f]!++;
        boxCells++;
      }
    }
    const dominant = counts.indexOf(Math.max(...counts));
    const coverage = boxCells === 0 ? 0 : counts[mass.colour]! / boxCells;
    const rendered = largestRegionOverlapping(visual, mass.colour, mass, dims);
    let verdict: LayoutVerdict;
    if (!rendered) {
      verdict = "MISSING";
    } else if (
      // Centre of what was actually drawn fell outside the declared box.
      (rendered.x0 + rendered.x1) / 2 < mass.x0 ||
      (rendered.x0 + rendered.x1) / 2 > mass.x1 ||
      (rendered.y0 + rendered.y1) / 2 < mass.y0 ||
      (rendered.y0 + rendered.y1) / 2 > mass.y1
    ) {
      verdict = "SHIFTED";
    } else if (coverage < COVERAGE_FLOOR) {
      verdict = "UNDERFILLED";
    } else {
      verdict = "OK";
    }
    out.push({ mass, dominant, coverage, rendered, verdict });
  }
  return out;
}

/** One compact line per declared mass. */
export function formatLayoutDiff(diffs: readonly LayoutMassDiff[]): string {
  return diffs
    .map((d) => {
      const m = d.mass;
      const where = d.rendered
        ? `largest region x${d.rendered.x0}-${d.rendered.x1} y${d.rendered.y0}-${d.rendered.y1}`
        : "colour absent";
      return `- ${m.name} x${m.x0}-${m.x1} y${m.y0}-${m.y1} colour ${m.colour}: dominant ${d.dominant}, coverage ${Math.round(d.coverage * 100)}%, ${where} -> ${d.verdict}`;
    })
    .join("\n");
}

export interface EditReport {
  /** Original command lines still present, in order (LCS length) / how many there were. */
  preserved: { kept: number; total: number };
  changedCells: number;
  /** Bounding box of the largest 4-connected changed region. */
  changedBox: Box | null;
  /** Changed cells outside that box. */
  strayCells: number;
  /** 4-connected changed regions in total. */
  changedComponents: number;
}

/** Non-comment, non-blank command lines, whitespace-normalised. */
function commandLines(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
}

/** Length of the longest common subsequence of two line arrays. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length]!;
}

/**
 * How faithful a live patch was: how much of the previous source survived in
 * order, and whether the pixel change stayed in one place.
 */
export function editReport(
  previousSource: string,
  newSource: string,
  previousVisual: Uint8Array,
  newVisual: Uint8Array,
  dims: SurfaceDims = PICTURE_DIMS,
): EditReport {
  const original = commandLines(previousSource);
  const preserved = { kept: lcsLength(original, commandLines(newSource)), total: original.length };

  const { width, height } = dims;
  const total = width * height;
  const changed = new Uint8Array(total);
  let changedCells = 0;
  for (let i = 0; i < total; i++) {
    if ((previousVisual[i]! & 0x0f) !== (newVisual[i]! & 0x0f)) {
      changed[i] = 1;
      changedCells++;
    }
  }

  const seen = new Uint8Array(total);
  const stack: number[] = [];
  let changedComponents = 0;
  let best: (Box & { cells: number }) | null = null;
  for (let start = 0; start < total; start++) {
    if (!changed[start] || seen[start]) continue;
    changedComponents++;
    seen[start] = 1;
    stack.push(start);
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    let cells = 0;
    while (stack.length > 0) {
      const i = stack.pop()!;
      cells++;
      const x = i % width;
      const y = (i - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const neighbours = [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1,
      ];
      for (const n of neighbours) {
        if (n < 0 || seen[n] || !changed[n]) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (!best || cells > best.cells) best = { x0, y0, x1, y1, cells };
  }

  let strayCells = 0;
  if (best) {
    for (let i = 0; i < total; i++) {
      if (!changed[i]) continue;
      const x = i % width;
      const y = (i - x) / width;
      if (x < best.x0 || x > best.x1 || y < best.y0 || y > best.y1) strayCells++;
    }
  }

  return {
    preserved,
    changedCells,
    changedBox: best ? { x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1 } : null,
    strayCells,
    changedComponents,
  };
}
