/**
 * Node faces for the world graph. The map composable caches the pixel
 * surfaces; this caches the encoded image per room, keyed on the surface's
 * identity so a re-rendered or newly-observed frame re-encodes while an
 * evicted-then-restored entry still hits.
 */
import { computed, type ComputedRef } from "vue";
import { EGA_RGB } from "../../../src/picture/png.ts";
import type { RoomGraphNode } from "../../../src/agent/roomMap.ts";
import type { MapThumbnail, RoomMap } from "../useRoomMap.ts";

let encodeCanvas: HTMLCanvasElement | null = null;

/** Half-scale PNG of the picture surface — enough for a node face. */
function thumbDataUrl(thumb: MapThumbnail): string {
  const c = (encodeCanvas ??= document.createElement("canvas"));
  c.width = 80;
  c.height = 84;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(80, 84);
  for (let y = 0; y < 84; y++) {
    for (let x = 0; x < 80; x++) {
      const rgb = EGA_RGB[thumb.pixels[y * 320 + x * 2]! & 0x0f]!;
      const i = (y * 80 + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

/** Data URLs of each node's picture, re-encoded only when a surface changes. */
export function useNodeThumbs(
  map: Pick<RoomMap, "thumbVersion" | "thumbnailFor">,
  nodes: () => readonly RoomGraphNode[],
): ComputedRef<Map<number, string>> {
  const thumbUrlCache = new Map<number, { thumb: MapThumbnail; url: string }>();
  return computed(() => {
    void map.thumbVersion.value;
    const out = new Map<number, string>();
    for (const node of nodes()) {
      const thumb = map.thumbnailFor(node.room);
      if (!thumb) continue;
      const hit = thumbUrlCache.get(node.room);
      if (hit && hit.thumb === thumb) {
        out.set(node.room, hit.url);
        continue;
      }
      const url = thumbDataUrl(thumb);
      if (thumbUrlCache.size > 300) thumbUrlCache.clear();
      thumbUrlCache.set(node.room, { thumb, url });
      out.set(node.room, url);
    }
    return out;
  });
}
