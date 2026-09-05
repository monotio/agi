/**
 * Picture metrics: structural measurements of a rendered visual + priority
 * surface, used by the picture eval to compare an authored room against a
 * reference without a model in the loop (cheapest assertion layer first).
 *
 * Zero dependencies; browser, worker and Node safe.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH, type PictureSurface } from "../types.ts";

/** Default AGI horizon (set.horizon default): rows above are "sky". */
export const DEFAULT_HORIZON = 36;

export interface PictureMetrics {
  /** Fraction of visual cells not left at the initial white (15). */
  fillCoverage: number;
  /** Fraction of visual cells per colour 0..15; sums to 1. */
  paletteHistogram: number[];
  /** Colours with at least one cell. */
  distinctColors: number;
  /** 4-neighbour visual colour transitions over all adjacent pairs. */
  edgeDensity: number;
  /** 4-connected same-colour regions on the visual surface. */
  regionCount: number;
  /** Fraction of cells whose priority is a depth band 4..15 (not control 0..3). */
  priorityBandFraction: number;
  /** Distinct depth bands 4..15 in use. */
  priorityBands: number;
  /** Fraction of cells above the horizon that keep the far band 4. */
  priorityHorizonSanity: number;
  /** Fraction of cells below the horizon that are walkable (priority >= 4). */
  walkableFraction: number;
  /** Source/byte-stream command count as reported by the caller. */
  commandCount: number;
}

export interface MetricsOptions {
  horizon?: number;
  commandCount?: number;
  /** Surface dimensions; default 160x168. Tests use tiny buffers. */
  width?: number;
  height?: number;
}

export function computePictureMetrics(
  surface: Pick<PictureSurface, "visual" | "priority">,
  opts?: MetricsOptions,
): PictureMetrics {
  const width = opts?.width ?? SCREEN_WIDTH;
  const height = opts?.height ?? SCREEN_HEIGHT;
  const horizon = opts?.horizon ?? DEFAULT_HORIZON;
  const total = width * height;
  const { visual, priority } = surface;

  const counts = new Array<number>(16).fill(0);
  let filled = 0;
  for (let i = 0; i < total; i++) {
    const c = visual[i]! & 0x0f;
    counts[c]!++;
    if (c !== 15) filled++;
  }
  const paletteHistogram = counts.map((n) => n / total);
  const distinctColors = counts.filter((n) => n > 0).length;

  let transitions = 0;
  let pairs = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x + 1 < width) {
        pairs++;
        if (visual[i] !== visual[i + 1]) transitions++;
      }
      if (y + 1 < height) {
        pairs++;
        if (visual[i] !== visual[i + width]) transitions++;
      }
    }
  }
  const edgeDensity = pairs === 0 ? 0 : transitions / pairs;

  const seen = new Uint8Array(total);
  let regionCount = 0;
  const stack: number[] = [];
  for (let start = 0; start < total; start++) {
    if (seen[start]) continue;
    regionCount++;
    const colour = visual[start];
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % width;
      const neighbours = [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        i >= width ? i - width : -1,
        i + width < total ? i + width : -1,
      ];
      for (const n of neighbours) {
        if (n < 0 || seen[n] || visual[n] !== colour) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
  }

  let banded = 0;
  const bandsUsed = new Array<boolean>(16).fill(false);
  let aboveCells = 0;
  let aboveFar = 0;
  let belowCells = 0;
  let belowWalkable = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = priority[y * width + x]! & 0x0f;
      if (p >= 4) {
        banded++;
        bandsUsed[p] = true;
      }
      if (y < horizon) {
        aboveCells++;
        if (p === 4) aboveFar++;
      } else {
        belowCells++;
        if (p >= 4) belowWalkable++;
      }
    }
  }

  return {
    fillCoverage: filled / total,
    paletteHistogram,
    distinctColors,
    edgeDensity,
    regionCount,
    priorityBandFraction: banded / total,
    priorityBands: bandsUsed.filter(Boolean).length,
    priorityHorizonSanity: aboveCells === 0 ? 1 : aboveFar / aboveCells,
    walkableFraction: belowCells === 0 ? 0 : belowWalkable / belowCells,
    commandCount: opts?.commandCount ?? 0,
  };
}

/** Total-variation distance between two palette histograms: 0 (identical) .. 1 (disjoint). */
export function histogramDistance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < 16; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / 2;
}

export interface MetricsComparison {
  /** candidate - reference for each scalar metric. */
  deltas: Record<string, number>;
  histogramDistance: number;
  /** Fraction of cells whose visual colour matches exactly (position-sensitive). */
  pixelAgreement: number;
}

export function comparePictureMetrics(
  reference: PictureMetrics,
  candidate: PictureMetrics,
  surfaces?: {
    reference: Pick<PictureSurface, "visual">;
    candidate: Pick<PictureSurface, "visual">;
  },
): MetricsComparison {
  const keys: (keyof PictureMetrics)[] = [
    "fillCoverage",
    "distinctColors",
    "edgeDensity",
    "regionCount",
    "priorityBandFraction",
    "priorityBands",
    "priorityHorizonSanity",
    "walkableFraction",
    "commandCount",
  ];
  const deltas: Record<string, number> = {};
  for (const k of keys) deltas[k] = (candidate[k] as number) - (reference[k] as number);
  let pixelAgreement = 0;
  if (surfaces) {
    const n = surfaces.reference.visual.length;
    let same = 0;
    for (let i = 0; i < n; i++)
      if (surfaces.reference.visual[i] === surfaces.candidate.visual[i]) same++;
    pixelAgreement = n === 0 ? 0 : same / n;
  }
  return {
    deltas,
    histogramDistance: histogramDistance(reference.paletteHistogram, candidate.paletteHistogram),
    pixelAgreement,
  };
}
