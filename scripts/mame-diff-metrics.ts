/** Exact RGB comparison at the AGI 320×200 presentation boundary. */
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function normalizeFrame(
  image: { width: number; height: number; rgba: Uint8Array },
  crop: Rectangle,
  width = 320,
  height = 200,
): Uint8Array {
  if (
    ![crop.x, crop.y, crop.width, crop.height, width, height].every(Number.isSafeInteger) ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width < 1 ||
    crop.height < 1 ||
    width < 1 ||
    height < 1 ||
    crop.x + crop.width > image.width ||
    crop.y + crop.height > image.height
  )
    throw new Error("Crop must be an integer rectangle inside the source image.");
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = crop.x + Math.floor(((x + 0.5) * crop.width) / width);
      const sy = crop.y + Math.floor(((y + 0.5) * crop.height) / height);
      rgb.set(
        image.rgba.subarray((sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 3),
        (y * width + x) * 3,
      );
    }
  return rgb;
}

/** Screen coordinates, including all 25 text rows; the input band includes spare rows. */
export const REGIONS: Record<string, Rectangle> = {
  status: { x: 0, y: 0, width: 320, height: 8 },
  play: { x: 0, y: 8, width: 320, height: 168 },
  input: { x: 0, y: 176, width: 320, height: 24 },
};

export function compareFrames(original: Uint8Array, ours: Uint8Array) {
  if (original.length !== 320 * 200 * 3 || ours.length !== original.length)
    throw new Error("Expected two 320×200 RGB frames.");
  const histograms: { original: Record<string, number>; ours: Record<string, number> } = {
    original: {},
    ours: {},
  };
  const diff = new Uint8Array(original.length);
  const regions = {} as Record<
    "status" | "play" | "input",
    { differingPixels: number; pixels: number; bounds: Rectangle | null }
  >;
  let differingPixels = 0;
  for (const [name, box] of Object.entries(REGIONS)) {
    let count = 0,
      minX = 320,
      minY = 200,
      maxX = -1,
      maxY = -1;
    for (let y = box.y; y < box.y + box.height; y++)
      for (let x = box.x; x < box.x + box.width; x++) {
        const at = (y * 320 + x) * 3;
        for (const [side, frame] of [
          ["original", original],
          ["ours", ours],
        ] as const) {
          const colour =
            "#" +
            Array.from(frame.subarray(at, at + 3), (n) => n.toString(16).padStart(2, "0")).join("");
          histograms[side][colour] = (histograms[side][colour] ?? 0) + 1;
        }
        if (
          original[at] === ours[at] &&
          original[at + 1] === ours[at + 1] &&
          original[at + 2] === ours[at + 2]
        )
          continue;
        count++;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        // Absolute per-channel RGB difference: black means exact agreement.
        for (let c = 0; c < 3; c++) diff[at + c] = Math.abs(original[at + c]! - ours[at + c]!);
      }
    differingPixels += count;
    regions[name as keyof typeof regions] = {
      differingPixels: count,
      pixels: box.width * box.height,
      bounds: count ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    };
  }
  return { differingPixels, pixels: 64000, regions, histograms, diff };
}
