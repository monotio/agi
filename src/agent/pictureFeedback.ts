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

import { EGA_RGB, encodePngRgb } from "../picture/png.ts";
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

const CONTROL_OVERLAY_RGB: readonly (readonly [number, number, number])[] = [
  [255, 85, 85],
  [255, 255, 255],
  [255, 85, 255],
  [85, 255, 255],
];

export const PICTURE_COMPARISON_LEGEND =
  "Left: clean visual. Middle: raw priority/control in EGA colors (0 barrier, 1 conditional barrier, 2 trigger, 3 water, 4 open/far floor, 5..15 higher depth/occluders). Right: overlay (4 untinted; 5..15 50% EGA blend; controls highlighted as 0 light red, 1 white, 2 magenta, 3 cyan).";

/**
 * Three aligned native-aspect panels: clean visual, raw EGA priority/control,
 * and a semantic overlay. Priority 4 leaves the visual untouched; depth 5..15
 * is blended 50%, while controls 0..3 use fixed high-contrast colours.
 */
export function pictureComparisonPng(
  visual: Uint8Array,
  priority: Uint8Array,
  dims: SurfaceDims = PICTURE_DIMS,
): Uint8Array {
  const panelWidth = dims.width * 2;
  const outputWidth = panelWidth * 3;
  const rgb = new Uint8Array(outputWidth * dims.height * 3);
  const writeLogicalPixel = (
    panel: number,
    x: number,
    y: number,
    colour: readonly [number, number, number],
  ): void => {
    let offset = (y * outputWidth + panel * panelWidth + x * 2) * 3;
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      rgb[offset++] = colour[0];
      rgb[offset++] = colour[1];
      rgb[offset++] = colour[2];
    }
  };
  for (let y = 0; y < dims.height; y++) {
    for (let x = 0; x < dims.width; x++) {
      const index = y * dims.width + x;
      const visualRgb = EGA_RGB[visual[index]! & 0x0f]!;
      const priorityValue = priority[index]! & 0x0f;
      const priorityRgb = EGA_RGB[priorityValue]!;
      let overlayRgb: readonly [number, number, number];
      if (priorityValue <= 3) overlayRgb = CONTROL_OVERLAY_RGB[priorityValue]!;
      else if (priorityValue === 4) overlayRgb = visualRgb;
      else
        overlayRgb = [
          (visualRgb[0] + priorityRgb[0]) >> 1,
          (visualRgb[1] + priorityRgb[1]) >> 1,
          (visualRgb[2] + priorityRgb[2]) >> 1,
        ];
      writeLogicalPixel(0, x, y, visualRgb);
      writeLogicalPixel(1, x, y, priorityRgb);
      writeLogicalPixel(2, x, y, overlayRgb);
    }
  }
  return encodePngRgb(outputWidth, dims.height, rgb);
}

interface PriorityExtent extends Box {
  value: number;
  cells: number;
  components: number;
}

function priorityExtents(priority: Uint8Array, dims: SurfaceDims): PriorityExtent[] {
  const { width, height } = dims;
  const total = width * height;
  const extents: PriorityExtent[] = [];
  for (let value = 0; value < 16; value++) {
    const seen = new Uint8Array(total);
    const stack: number[] = [];
    let cells = 0;
    let components = 0;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let start = 0; start < total; start++) {
      if (seen[start] || (priority[start]! & 0x0f) !== value) continue;
      components++;
      seen[start] = 1;
      stack.push(start);
      while (stack.length > 0) {
        const index = stack.pop()!;
        cells++;
        const x = index % width;
        const y = (index - x) / width;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        const neighbours = [
          x > 0 ? index - 1 : -1,
          x < width - 1 ? index + 1 : -1,
          y > 0 ? index - width : -1,
          y < height - 1 ? index + width : -1,
        ];
        for (const neighbour of neighbours) {
          if (neighbour < 0 || seen[neighbour] || (priority[neighbour]! & 0x0f) !== value) continue;
          seen[neighbour] = 1;
          stack.push(neighbour);
        }
      }
    }
    if (cells > 0) extents.push({ value, cells, components, x0, y0, x1, y1 });
  }
  return extents;
}

/** Compact, exact spatial summary of collision controls and scenery depth. */
export function formatPriorityDiagnostics(
  priority: Uint8Array,
  dims: SurfaceDims = PICTURE_DIMS,
): string {
  const extents = priorityExtents(priority, dims);
  const labels = ["barrier", "conditional barrier", "trigger", "water"];
  const controls = extents
    .filter(({ value }) => value <= 3)
    .map(
      (entry) =>
        `${entry.value} ${labels[entry.value]}: ${entry.cells} cells in ${entry.components} component${entry.components === 1 ? "" : "s"}, x${entry.x0}-${entry.x1} y${entry.y0}-${entry.y1}`,
    );
  const bands = extents
    .filter(({ value }) => value >= 4)
    .map(
      (entry) =>
        `${entry.value} x${entry.x0}-${entry.x1} y${entry.y0}-${entry.y1} (${entry.cells})`,
    );
  return [
    `Display geometry: ${dims.width}x${dims.height} logical -> ${dims.width * 2}x${dims.height}; each x unit is 2 display pixels and each y unit is 1.`,
    "Priority/control map (actor collision reads the full baseline/feet row):",
    ...(controls.length > 0 ? controls.map((line) => `- ${line}`) : ["- controls 0..3: absent"]),
    `- depth bands: ${bands.length > 0 ? bands.join("; ") : "absent"}`,
  ].join("\n");
}

interface ActorLayout {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
}

const MAX_ACTOR_LAYOUTS = 16;

/** `# actor: <name> x<X> y<baseline> width<W> height<H> priority<P>`. */
function parseActorLayouts(source: string): ActorLayout[] {
  const pattern =
    /^#\s*actor:\s*(\S+)\s+x(\d+)\s+y(\d+)\s+width(\d+)\s+height(\d+)\s+priority(\d+)/i;
  const actors: ActorLayout[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (actors.length >= MAX_ACTOR_LAYOUTS) break;
    const match = pattern.exec(line.trim());
    if (!match) continue;
    const actor = {
      name: match[1]!,
      x: Number(match[2]),
      y: Number(match[3]),
      width: Number(match[4]),
      height: Number(match[5]),
      priority: Number(match[6]),
    };
    if (actor.width > 0 && actor.height > 0 && actor.priority <= 15) actors.push(actor);
  }
  return actors;
}

function ranges(values: readonly number[]): string {
  const result: string[] = [];
  for (let index = 0; index < values.length; index++) {
    let end = index;
    while (end + 1 < values.length && values[end + 1] === values[end]! + 1) end++;
    result.push(index === end ? String(values[index]) : `${values[index]}-${values[end]}`);
    index = end;
  }
  return result.join(",");
}

function comparisonPriority(priority: Uint8Array, x: number, y: number, dims: SurfaceDims): number {
  let value = priority[y * dims.width + x]! & 0x0f;
  if (value > 2) return value;
  value = 0;
  for (let belowY = y + 1; belowY < dims.height; belowY++) {
    const below = priority[belowY * dims.width + x]! & 0x0f;
    if (below > 2) return below;
  }
  return value;
}

/**
 * Check declared actor scale against the scene plus collision and occlusion at
 * that concrete placement. The declaration is a comment and never changes AGI bytes.
 */
export function actorLayoutFeedback(
  source: string,
  priority: Uint8Array,
  dims: SurfaceDims = PICTURE_DIMS,
): string {
  const lines: string[] = [];
  for (const actor of parseActorLayouts(source)) {
    const x1 = actor.x + actor.width - 1;
    const y0 = actor.y - actor.height + 1;
    const inBounds = actor.x >= 0 && y0 >= 0 && x1 < dims.width && actor.y < dims.height;
    const baselineValues = new Set<number>();
    const controlXs: Record<string, number[]> = {};
    for (let x = Math.max(0, actor.x); x <= Math.min(dims.width - 1, x1); x++) {
      if (actor.y < 0 || actor.y >= dims.height) continue;
      const value = priority[actor.y * dims.width + x]! & 0x0f;
      baselineValues.add(value);
      if (value <= 3) (controlXs[String(value)] ??= []).push(x);
    }
    let higher = 0;
    let sampled = 0;
    for (let y = Math.max(0, y0); y <= Math.min(dims.height - 1, actor.y); y++) {
      for (let x = Math.max(0, actor.x); x <= Math.min(dims.width - 1, x1); x++) {
        sampled++;
        if (comparisonPriority(priority, x, y, dims) > actor.priority) higher++;
      }
    }
    const controls = Object.entries(controlXs)
      .map(([value, xs]) => `${value}@x${ranges(xs)}`)
      .join(", ");
    const values = [...baselineValues].sort((a, b) => a - b).join(", ");
    lines.push(
      `- ${actor.name}: logical x${actor.x}-${x1} y${y0}-${actor.y} (${actor.width}x${actor.height}), display x${actor.x * 2}-${x1 * 2 + 1} y${y0}-${actor.y} (${actor.width * 2}x${actor.height}); priority ${actor.priority}; baseline values [${values}], controls [${controls}]; higher-priority scenery ${higher}/${sampled} cells${inBounds ? "" : "; OUT OF BOUNDS"}`,
    );
  }
  return lines.join("\n");
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
