/**
 * Halation for the CRT pass: light from the phosphors scattering in the
 * glass. The 320x200 frame is averaged in linear light into 4x4 cells and
 * blurred twice with a binomial kernel on each axis, a soft ~6-pixel glow
 * the shader samples with linear filtering. It runs on the CPU per frame
 * (an 80x50 image, a fraction of a millisecond) so the stage keeps one pass.
 */
import { FRAME_HEIGHT, FRAME_WIDTH } from "../render/composite.ts";

const CELL = 4;
export const CRT_GLOW_WIDTH = FRAME_WIDTH / CELL;
export const CRT_GLOW_HEIGHT = FRAME_HEIGHT / CELL;

/** sRGB byte to linear light. */
const LINEAR = Float32Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

const cells = new Float32Array(CRT_GLOW_WIDTH * CRT_GLOW_HEIGHT * 3);
const scratch = new Float32Array(cells.length);

/** One [1 4 6 4 1]/16 pass along an axis, clamped at the edges. */
function blur(from: Float32Array, to: Float32Array, horizontal: boolean): void {
  const w = CRT_GLOW_WIDTH;
  const h = CRT_GLOW_HEIGHT;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        const tap = (d: number) => {
          const tx = horizontal ? Math.min(w - 1, Math.max(0, x + d)) : x;
          const ty = horizontal ? y : Math.min(h - 1, Math.max(0, y + d));
          return from[(ty * w + tx) * 3 + c]!;
        };
        to[(y * w + x) * 3 + c] = (tap(-2) + 4 * tap(-1) + 6 * tap(0) + 4 * tap(1) + tap(2)) / 16;
      }
}

/** Write the frame's glow as linear RGBA bytes into `out` (80x50x4). */
export function crtGlow(frame: Uint8Array | Uint8ClampedArray, out: Uint8Array): void {
  cells.fill(0);
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    const row = ((y / CELL) | 0) * CRT_GLOW_WIDTH;
    for (let x = 0; x < FRAME_WIDTH; x++) {
      const i = (y * FRAME_WIDTH + x) * 4;
      const o = (row + ((x / CELL) | 0)) * 3;
      cells[o] = cells[o]! + LINEAR[frame[i]!]!;
      cells[o + 1] = cells[o + 1]! + LINEAR[frame[i + 1]!]!;
      cells[o + 2] = cells[o + 2]! + LINEAR[frame[i + 2]!]!;
    }
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i]! / (CELL * CELL);
  blur(cells, scratch, true);
  blur(scratch, cells, true);
  blur(cells, scratch, false);
  blur(scratch, cells, false);
  for (let p = 0; p < CRT_GLOW_WIDTH * CRT_GLOW_HEIGHT; p++) {
    out[p * 4] = Math.round(cells[p * 3]! * 255);
    out[p * 4 + 1] = Math.round(cells[p * 3 + 1]! * 255);
    out[p * 4 + 2] = Math.round(cells[p * 3 + 2]! * 255);
    out[p * 4 + 3] = 255;
  }
}
