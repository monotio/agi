/**
 * Node faces for the world graph. The map composable caches the pixel
 * surfaces; this caches the encoded image per room, keyed on the surface's
 * identity so a re-rendered or newly-observed frame re-encodes while an
 * evicted-then-restored entry still hits.
 */
import { computed, type ComputedRef } from "vue";
import { useGamePalette, type Palette } from "../render/useGamePalette.ts";
import type { RoomGraphNode } from "../../../src/agent/roomMap.ts";
import type { MapThumbnail, RoomMap } from "./useRoomMap.ts";

let encodeCanvas: HTMLCanvasElement | null = null;

/** RGBA of the half-scale node face (80x84) from a 320-wide picture surface. */
export function thumbRgba(pixels: Uint8Array, palette: Palette): Uint8ClampedArray {
  const out = new Uint8ClampedArray(80 * 84 * 4);
  for (let y = 0; y < 84; y++) {
    for (let x = 0; x < 80; x++) {
      const rgb = palette[pixels[y * 320 + x * 2]! & 0x0f]!;
      const i = (y * 80 + x) * 4;
      out[i] = rgb[0];
      out[i + 1] = rgb[1];
      out[i + 2] = rgb[2];
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Half-scale PNG of the picture surface — enough for a node face. */
function thumbDataUrl(thumb: MapThumbnail, palette: Palette): string {
  const c = (encodeCanvas ??= document.createElement("canvas"));
  c.width = 80;
  c.height = 84;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(80, 84);
  img.data.set(thumbRgba(thumb.pixels, palette));
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

/**
 * Data URLs of each node's picture in the game's colours, re-encoded only
 * when a surface or the palette changes.
 */
export function useNodeThumbs(
  map: Pick<RoomMap, "thumbVersion" | "thumbnailFor">,
  nodes: () => readonly RoomGraphNode[],
): ComputedRef<Map<number, string>> {
  const thumbUrlCache = new Map<number, { thumb: MapThumbnail; palette: Palette; url: string }>();
  const palette = useGamePalette();
  return computed(() => {
    void map.thumbVersion.value;
    const out = new Map<number, string>();
    for (const node of nodes()) {
      const thumb = map.thumbnailFor(node.room);
      if (!thumb) continue;
      const hit = thumbUrlCache.get(node.room);
      if (hit && hit.thumb === thumb && hit.palette === palette.value) {
        out.set(node.room, hit.url);
        continue;
      }
      const url = thumbDataUrl(thumb, palette.value);
      if (thumbUrlCache.size > 300) thumbUrlCache.clear();
      thumbUrlCache.set(node.room, { thumb, palette: palette.value, url });
      out.set(node.room, url);
    }
    return out;
  });
}
