/**
 * Stored references as the handles an agent turn sees (src/agent/
 * referenceTools.ts): one entry per stored image, its id derived from the
 * stored bytes, so nothing new is written to the project record and released
 * archives read unchanged. Pixels decode on first use and stay cached by id
 * for a few turns. Part of the lazy authoring stack (authoringStack.ts).
 */
import {
  referenceArtId,
  workingBitmap,
  type ReferenceArt,
  type ReferenceBitmap,
  type ReferenceSource,
} from "../../../src/agent/referenceTools.ts";
import { base64ToBytes } from "../project/bytes.ts";
import type { StoredReference } from "./referenceArt.ts";
import { decodeStoredImage } from "./referenceDecode.ts";

type ReferenceDecoder = (bytes: Uint8Array, mime: string) => Promise<ReferenceBitmap>;

/** Decoded working-size bitmaps kept, by id; each is at most 1024x1024 RGBA (4 MB). */
const DECODED_LIMIT = 8;
const decoded = new Map<string, Promise<ReferenceBitmap>>();

function cachedPixels(
  id: string,
  decode: () => Promise<ReferenceBitmap>,
): Promise<ReferenceBitmap> {
  const hit = decoded.get(id);
  if (hit) {
    decoded.delete(id);
    decoded.set(id, hit);
    return hit;
  }
  const pending = decode().then(workingBitmap);
  pending.catch(() => decoded.delete(id));
  decoded.set(id, pending);
  while (decoded.size > DECODED_LIMIT) decoded.delete(decoded.keys().next().value!);
  return pending;
}

function referenceLabel(reference: StoredReference, facing: string | undefined): string {
  if (reference.kind === "room") return "Room plate";
  if (facing) return `Character sheet, ${facing}-facing row`;
  // A view's reference from a Studio's Ask carries one image and no pose manifest.
  return reference.sheet ? "Character sheet" : "Character reference";
}

/**
 * The project's references for one turn. `attached` names the stored records
 * the player attached to the request; their images are marked attached. Two
 * records holding the same bytes share one handle, listed once.
 */
export function referenceSource(
  references: readonly StoredReference[],
  attached: readonly string[],
  decode: ReferenceDecoder = decodeStoredImage,
): ReferenceSource | undefined {
  const art: ReferenceArt[] = [];
  const seen = new Set<string>();
  for (const reference of references)
    for (const image of reference.images) {
      const bytes = base64ToBytes(image.png);
      const id = referenceArtId(bytes);
      if (seen.has(id)) continue;
      seen.add(id);
      art.push({
        id,
        label: referenceLabel(reference, image.facing),
        target: { kind: reference.kind === "room" ? "room" : "view", num: reference.target },
        note: reference.brief,
        attached: attached.includes(reference.id),
        pixels: () => cachedPixels(id, () => decode(bytes, image.mime)),
      });
    }
  return art.length ? { art } : undefined;
}
