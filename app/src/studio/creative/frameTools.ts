/**
 * Frame geometry helpers for the VIEW preparation editor: collision-free
 * ids, regular grid and manual region builders, splitting and reordering.
 * Pure — every function returns detached records and never mutates the job.
 */
import type { Rect } from "../../../../src/creative/catalog.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../../src/types.ts";
import type { SourceIdentity, ViewRecipeFrame } from "../../../../src/view/preparation.ts";

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
