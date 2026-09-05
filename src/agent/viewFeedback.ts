/** Bounded visual feedback from the compiled sprite resource. */
import { parseView, selectViewCel } from "../view/view.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { EGA_RGB, encodePngRgb } from "../picture/png.ts";

const TILE_WIDTH = 80;
const TILE_HEIGHT = 64;
const MAX_FRAMES = 32;
const PREVIEW_PALETTE = [...EGA_RGB, [38, 43, 50], [49, 55, 63]] as const;

function sampleIndices(count: number, limit: number): number[] {
  const size = Math.min(count, limit);
  return Array.from({ length: size }, (_, i) =>
    size === 1 ? 0 : Math.round((i * (count - 1)) / (size - 1)),
  );
}

export function viewFeedback(payload: Uint8Array, profile: AgiProfile, num: number) {
  const view = parseView(payload, profile);
  const loops = sampleIndices(view.loops.length, 8);
  const totalFrames = view.loops.reduce((total, loop) => total + loop.cels.length, 0);
  const directionGuide =
    view.loops.length === 4
      ? "AGI automatic facing: L0 = right, L1 = left, L2 = down (front), L3 = up (back). Check each drawing against its assigned direction; fix.loop in game logic overrides automatic selection. "
      : view.loops.length === 2 || view.loops.length === 3
        ? "AGI automatic facing: L0 = right, L1 = left; up/down keep the current loop. "
        : "";
  const animationGuide = view.loops.some((loop) => loop.cels.length > 1)
    ? "VIEW stores artwork, not timing. Set cycle.time(object, variable) in room-entry logic using a safely reserved variable; 1 advances every logic cycle. For a quiet idle, start with 6-12 cycles per cel and verify the actual rate with playtest_room after acknowledging any modal. Replacing a view preserves object position: y is the bottom baseline, so a taller cel grows upward. "
    : "";
  const frames = loops.flatMap((loop) =>
    sampleIndices(view.loops[loop]!.cels.length, Math.floor(MAX_FRAMES / loops.length)).map(
      (cel) => ({ loop, cel }),
    ),
  );
  const columns = Math.min(4, frames.length);
  const width = columns * TILE_WIDTH;
  const height = Math.ceil(frames.length / columns) * TILE_HEIGHT;
  const surface = new Uint8Array(width * height);
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const cel = selectViewCel(view, frame.loop, frame.cel)!;
    const left = (i % columns) * TILE_WIDTH;
    const top = Math.floor(i / columns) * TILE_HEIGHT;
    for (let y = 4; y < TILE_HEIGHT - 4; y++) {
      for (let x = 4; x < TILE_WIDTH - 4; x++) {
        surface[(top + y) * width + left + x] = ((x >> 2) + (y >> 2)) % 2 ? 17 : 16;
      }
    }
    // Preserve AGI's 2:1 pixel aspect. Enlarge small cels by integer steps;
    // large props fit inside a tile with nearest-neighbour reduction.
    const fit = Math.min(3, (TILE_WIDTH - 8) / (cel.width * 2), (TILE_HEIGHT - 8) / cel.height);
    const scale = fit >= 1 ? Math.floor(fit) : fit;
    const w = Math.max(1, Math.floor(cel.width * 2 * scale));
    const h = Math.max(1, Math.floor(cel.height * scale));
    const x0 = left + Math.floor((TILE_WIDTH - w) / 2);
    const y0 = top + TILE_HEIGHT - 4 - h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const color =
          cel.pixels[
            Math.floor((y * cel.height) / h) * cel.width + Math.floor((x * cel.width) / w)
          ]!;
        if (color !== cel.transparentColor) surface[(y0 + y) * width + x0 + x] = color;
      }
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < surface.length; i++) rgb.set(PREVIEW_PALETTE[surface[i]!]!, i * 3);
  return {
    png: encodePngRgb(width, height, rgb),
    caption: `View ${num}: ${frames.length} of ${totalFrames} cels, rendered from compiled bytes. Tiles left to right, top to bottom: ${frames.map(({ loop, cel }) => `L${loop} C${cel}`).join(", ")}. ${directionGuide}${animationGuide}Checkerboard is transparency; feet share a baseline in each tile. AGI pixels are twice as wide as tall. Inspect silhouette, colors, mirrored directions and animation consistency; revise only specific defects.`,
    width,
    height,
    frames: frames.length,
    totalFrames,
  };
}
