/** PICTURE tracing uses the same white paper and native marks as the editor. */
import type { ProjectContent } from "../../../src/authoring/projectContent.ts";
import { readImageReferences, imageTraceUnderlay } from "../../../src/creative/imageOperations.ts";
import { EGA_RGB } from "../../../src/picture/png.ts";
type Documents = Readonly<Record<string, ProjectContent>>;

export function imageReviewTargets(before: Documents, after: Documents): string[] {
  const was = readImageReferences(before).traces;
  const now = readImageReferences(after).traces;
  return [...new Set([...Object.keys(was), ...Object.keys(now)])]
    .filter((target) => JSON.stringify(was[target]) !== JSON.stringify(now[target]))
    .sort();
}

export function pictureReviewPixels(
  visual: Uint8Array,
  documents: Documents,
  target: string,
): Uint8Array {
  const underlay = imageTraceUnderlay(documents, target);
  const rgba = new Uint8Array(320 * 168 * 4);
  for (let i = 0; i < visual.length; i++) {
    const colour = EGA_RGB[visual[i]! & 15]!;
    // Behind the art only the white paper shows the image; over it, every pixel does.
    const shown = underlay !== null && (!underlay.behindArt || visual[i] === 15);
    const alpha = shown ? (underlay.opacity * underlay.pixels[i * 4 + 3]!) / 255 : 0;
    for (let channel = 0; channel < 3; channel++) {
      const value = Math.round(
        colour[channel]! * (1 - alpha) + (underlay?.pixels[i * 4 + channel] ?? 0) * alpha,
      );
      rgba[i * 8 + channel] = value;
      rgba[i * 8 + channel + 4] = value;
    }
    rgba[i * 8 + 3] = 255;
    rgba[i * 8 + 7] = 255;
  }
  return rgba;
}
