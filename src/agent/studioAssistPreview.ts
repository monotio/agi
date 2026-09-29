/**
 * Images for the Studio assist tools (studioAssistTools.ts): the before |
 * after | diff sheet a candidate returns, the selection crop and the room
 * overview `read_edit_context` returns. Every image keeps AGI's 2:1 logical
 * pixel aspect. Pure; dimensions are fixed by the inputs so tests can state
 * them.
 */

import { EGA_RGB, encodePngRgb } from "../picture/png.ts";
import type { CellBox } from "../studio/editValidation.ts";
import type { SpriteCel } from "../view/spriteDocument.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import { pictureComparisonPng } from "./pictureFeedback.ts";

type Rgb = readonly [number, number, number];

/** A changed cell or pixel in a diff panel. */
const CHANGED: Rgb = [255, 85, 255];
/** Transparent sprite pixels and gutters. */
const BACKDROP: Rgb = [38, 43, 50];
/** Gutter between sprite tiles, in image pixels. */
const TILE_GAP = 4;

/** An unchanged cell in a diff panel: its colour at a quarter, over grey. */
function dim([r, g, b]: Rgb): Rgb {
  return [48 + (r >> 2), 48 + (g >> 2), 48 + (b >> 2)];
}

function blend([r, g, b]: Rgb, [s, t, u]: Rgb): Rgb {
  return [(r + s) >> 1, (g + t) >> 1, (b + u) >> 1];
}

interface Planes {
  readonly visual: Uint8Array;
  readonly priority: Uint8Array;
}

/**
 * A candidate picture as a 960x336 sheet: the visual plane on the top row
 * and the priority plane below it, each as before | after | diff panels of
 * 320x168 (every logical pixel two image pixels wide). The diff panel shows
 * changed cells in magenta over the dimmed result.
 */
export function pictureAssistPreviewPng(before: Planes, after: Planes): Uint8Array {
  const panel = SCREEN_WIDTH * 2;
  const width = panel * 3;
  const height = SCREEN_HEIGHT * 2;
  const rgb = new Uint8Array(width * height * 3);
  const put = (column: number, row: number, x: number, y: number, colour: Rgb) => {
    let at = ((row * SCREEN_HEIGHT + y) * width + column * panel + x * 2) * 3;
    for (let i = 0; i < 2; i++) {
      rgb[at++] = colour[0];
      rgb[at++] = colour[1];
      rgb[at++] = colour[2];
    }
  };
  (["visual", "priority"] as const).forEach((plane, row) => {
    for (let y = 0; y < SCREEN_HEIGHT; y++)
      for (let x = 0; x < SCREEN_WIDTH; x++) {
        const i = y * SCREEN_WIDTH + x;
        const was = EGA_RGB[before[plane][i]! & 0x0f]!;
        const now = EGA_RGB[after[plane][i]! & 0x0f]!;
        put(0, row, x, y, was);
        put(1, row, x, y, now);
        put(2, row, x, y, before[plane][i] === after[plane][i] ? dim(now) : CHANGED);
      }
  });
  return encodePngRgb(width, height, rgb);
}

export const PICTURE_ASSIST_PREVIEW_CAPTION =
  "Candidate, 960x336: top row the visual plane, bottom row the priority plane; columns before | after | diff (changed cells magenta over the dimmed result). Each logical pixel is two image pixels wide.";

/** How much a crop of `box` is enlarged: the largest of 1..4 that keeps each panel within 320x168. */
export function cropScale(box: CellBox): number {
  const w = box.x1 - box.x0 + 1;
  const h = box.y1 - box.y0 + 1;
  return Math.max(1, Math.min(4, Math.floor(SCREEN_HEIGHT / h), Math.floor(SCREEN_WIDTH / w)));
}

/**
 * The cells of `box`, each repeated `scale` times both ways, as the three
 * comparison panels (visual, priority, overlay) of `pictureComparisonPng`:
 * (box width x scale x 6) by (box height x scale).
 */
export function pictureCropPng(planes: Planes, box: CellBox, scale: number): Uint8Array {
  const w = (box.x1 - box.x0 + 1) * scale;
  const h = (box.y1 - box.y0 + 1) * scale;
  const visual = new Uint8Array(w * h);
  const priority = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const source =
        (box.y0 + Math.floor(y / scale)) * SCREEN_WIDTH + box.x0 + Math.floor(x / scale);
      visual[y * w + x] = planes.visual[source]!;
      priority[y * w + x] = planes.priority[source]!;
    }
  return pictureComparisonPng(visual, priority, { width: w, height: h });
}

/** The whole visual plane at 320x168 with the cells of `area` tinted magenta. */
export function pictureOverviewPng(visual: Uint8Array, area: Uint8Array): Uint8Array {
  const width = SCREEN_WIDTH * 2;
  const rgb = new Uint8Array(width * SCREEN_HEIGHT * 3);
  for (let i = 0; i < SCREEN_WIDTH * SCREEN_HEIGHT; i++) {
    const colour = EGA_RGB[visual[i]! & 0x0f]!;
    const shown = area[i] === 1 ? blend(colour, CHANGED) : colour;
    rgb.set(shown, i * 6);
    rgb.set(shown, i * 6 + 3);
  }
  return encodePngRgb(width, SCREEN_HEIGHT, rgb);
}

/** One sheet row: a cel before and after (either may be absent: added or removed). */
export interface CelPair {
  readonly before?: SpriteCel | undefined;
  readonly after?: SpriteCel | undefined;
}

/** Tile geometry for `pairs`: the widest and tallest cel, enlarged 1..4 times to about 96 rows. */
function spriteTileSize(pairs: readonly CelPair[]): {
  scale: number;
  width: number;
  height: number;
} {
  const cels = pairs.flatMap(({ before, after }) => [before, after]).filter((c) => c !== undefined);
  const w = Math.max(1, ...cels.map((cel) => cel.width));
  const h = Math.max(1, ...cels.map((cel) => cel.height));
  const scale = Math.max(1, Math.min(4, Math.floor(96 / h)));
  return { scale, width: w * 2 * scale, height: h * scale };
}

function pixelOf(cel: SpriteCel | undefined, x: number, y: number): number | null {
  if (!cel || x >= cel.width || y >= cel.height) return null;
  const value = cel.pixels[y * cel.width + x]!;
  return value === cel.transparent ? null : value;
}

/**
 * Sprite cels as a sheet, one row per pair. With `compare`, three tiles per
 * row: before | after | diff (changed pixels magenta over the dimmed after);
 * otherwise one tile of `after`. Tiles are `spriteTileSize` with a
 * TILE_GAP-pixel gutter; transparency is dark grey.
 */
export function spriteSheetPng(pairs: readonly CelPair[], compare: boolean): Uint8Array {
  const tile = spriteTileSize(pairs);
  const columns = compare ? 3 : 1;
  const width = columns * tile.width + (columns - 1) * TILE_GAP;
  const height = Math.max(1, pairs.length) * tile.height + Math.max(0, pairs.length - 1) * TILE_GAP;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(BACKDROP, i * 3);
  const cellsW = tile.width / (2 * tile.scale);
  const cellsH = tile.height / tile.scale;
  pairs.forEach((pair, row) => {
    for (let column = 0; column < columns; column++)
      for (let y = 0; y < cellsH; y++)
        for (let x = 0; x < cellsW; x++) {
          const was = pixelOf(pair.before, x, y);
          const now = pixelOf(pair.after, x, y);
          let colour: Rgb | null;
          if (!compare || column === 1) colour = now === null ? null : EGA_RGB[now]!;
          else if (column === 0) colour = was === null ? null : EGA_RGB[was]!;
          else if (was !== now) colour = CHANGED;
          else colour = now === null ? null : dim(EGA_RGB[now]!);
          if (colour === null) continue;
          const left = column * (tile.width + TILE_GAP) + x * 2 * tile.scale;
          const top = row * (tile.height + TILE_GAP) + y * tile.scale;
          for (let dy = 0; dy < tile.scale; dy++)
            for (let dx = 0; dx < 2 * tile.scale; dx++)
              rgb.set(colour, ((top + dy) * width + left + dx) * 3);
        }
  });
  return encodePngRgb(width, height, rgb);
}
