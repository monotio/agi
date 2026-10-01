/**
 * Canvas helpers for the creative workspace: paint a canonical RGBA8 raster
 * or a prepared native (EGA-indexed + mask) frame onto a <canvas>. All reads
 * are exact pixel copies — preview code never resamples the working data.
 */
import { EGA_PALETTE } from "../../render/palette.ts";

/** Draw a w×h RGBA8 raster onto the canvas, scaled to the canvas size. */
export function drawRaster(
  canvas: HTMLCanvasElement,
  rgba: Uint8Array,
  width: number,
  height: number,
): void {
  const scratch = new ImageData(width, height);
  scratch.data.set(rgba);
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  source.getContext("2d")!.putImageData(scratch, 0, 0);
  const context = canvas.getContext("2d")!;
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
}

/**
 * Draw one prepared cel: `pixels` holds EGA palette indices and `mask` marks
 * transparent cells (the transparent index is not painted). Composited over
 * the canvas's existing content when `backdrop` is painted first, else
 * cleared to transparent.
 */
export function drawPreparedCel(
  canvas: HTMLCanvasElement,
  cel: { width: number; height: number; pixels: Uint8Array; mask: Uint8Array },
): void {
  const scratch = new ImageData(cel.width, cel.height);
  for (let i = 0; i < cel.pixels.length; i++) {
    if (cel.mask[i] === 0) continue;
    const [r, g, b] = EGA_PALETTE[cel.pixels[i]! & 0x0f]!;
    const p = i * 4;
    scratch.data[p] = r;
    scratch.data[p + 1] = g;
    scratch.data[p + 2] = b;
    scratch.data[p + 3] = 255;
  }
  const source = document.createElement("canvas");
  source.width = cel.width;
  source.height = cel.height;
  source.getContext("2d")!.putImageData(scratch, 0, 0);
  const context = canvas.getContext("2d")!;
  context.imageSmoothingEnabled = false;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
}
