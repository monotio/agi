/** Target-specific instructions and cheap, offline measurements of reference art. */
import { EGA_RGB } from "../picture/png.ts";
import { nearestEgaIndex } from "../view/spritesheet.ts";
export const SIERRA_IMAGE_STYLE: Readonly<Record<"picture" | "view", string>> = {
  picture:
    "Draw a 1987 Sierra AGI background using only the 16 EGA colours. Use large flat filled shapes, hard pixel edges and few lines. An optional single dithered band can join two colours. Keep gradients, texture, photographic detail and anti-aliasing out of the art. Use wide framing for the AGI screen's 2:1 pixel aspect, a clear horizon and an open walkable lower area. Leave people, lettering and UI out of the scene.",
  view: "Draw a small side-view sprite for a 1987 Sierra AGI game using only the 16 EGA colours, flat filled shapes and hard pixel edges. Keep the figure's size consistent across poses. Use a transparent background and leave lettering and UI out of the art.",
};
export function imageStylePrompt(
  target: "picture" | "view",
  intent: string,
  enabled = true,
): string {
  return enabled ? `${SIERRA_IMAGE_STYLE[target]}\n\nDraw this: ${intent}` : intent;
}
/** Keep the original image intact; display the tracing copy in the game's palette. */
export function snapImageToEga(rgba: Uint8Array): Uint8Array {
  const pixels = new Uint8Array(rgba);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3]! < 128) continue;
    const colour =
      EGA_RGB[nearestEgaIndex(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!)]!;
    pixels.set(colour, offset);
  }
  return pixels;
}
/** Scores are measurements for comparing saved images; human review assesses the scene. */
export function scoreImageStyle(width: number, height: number, rgba: Uint8Array) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    rgba.length !== width * height * 4
  )
    throw new Error("Image dimensions must match its RGBA pixels.");
  const indices = new Uint8Array(width * height);
  let distance = 0,
    opaque = 0;
  for (let pixel = 0; pixel < indices.length; pixel++) {
    const offset = pixel * 4;
    if (rgba[offset + 3]! < 128) {
      indices[pixel] = 16;
      continue;
    }
    const colour = nearestEgaIndex(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!);
    indices[pixel] = colour;
    const ega = EGA_RGB[colour]!;
    distance += Math.sqrt(
      (rgba[offset]! - ega[0]) ** 2 +
        (rgba[offset + 1]! - ega[1]) ** 2 +
        (rgba[offset + 2]! - ega[2]) ** 2,
    );
    opaque++;
  }
  const seen = new Uint8Array(indices.length);
  const pending: number[] = [];
  let flatRegions = 0,
    isolated = 0;
  for (let pixel = 0; pixel < indices.length; pixel++) {
    if (seen[pixel] || indices[pixel] === 16) continue;
    flatRegions++;
    seen[pixel] = 1;
    pending.push(pixel);
    let size = 0;
    while (pending.length) {
      const current = pending.pop()!;
      size++;
      const x = current % width;
      for (const neighbour of [
        x > 0 ? current - 1 : -1,
        x + 1 < width ? current + 1 : -1,
        current - width,
        current + width,
      ]) {
        if (
          neighbour < 0 ||
          neighbour >= indices.length ||
          seen[neighbour] ||
          indices[neighbour] !== indices[current]
        )
          continue;
        seen[neighbour] = 1;
        pending.push(neighbour);
      }
    }
    if (size === 1) isolated++;
  }
  return {
    egaDistance: opaque ? distance / opaque : 0,
    flatRegions,
    traceCleanliness: opaque ? 1 - isolated / opaque : 1,
  };
}
