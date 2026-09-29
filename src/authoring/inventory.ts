/** Native OBJECT writer shared by manual and agent authoring. */
import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";

const MESSAGE_KEY = "Avis Durgan";

export function buildObjectFile(
  items: readonly { name: string; startingRoom?: number | undefined }[],
  profile: AgiProfile = DEFAULT_V2_PROFILE,
  maximumDrawableObjectIndex = 255,
): Uint8Array {
  const header = profile.inventoryHeaderBytes;
  const stride = profile.inventoryEntryBytes;
  const tableSize = items.length * stride;
  let totalNamesLen = 0;
  for (const item of items) {
    totalNamesLen += item.name.length + 1;
  }
  const plain = new Uint8Array(header + tableSize + totalNamesLen);
  plain[0] = tableSize & 0xff;
  plain[1] = (tableSize >> 8) & 0xff;
  // The drawable-object index lives in header bytes 2..3 where the header has
  // room (PC one byte, Amiga u16le); the two-byte 2.001 header omits it.
  if (header >= 3) {
    plain[2] = maximumDrawableObjectIndex & 0xff;
    if (header === 4) plain[3] = (maximumDrawableObjectIndex >> 8) & 0xff;
  }

  let currentOffset = tableSize;
  let poolAt = header + tableSize;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const entryAt = header + i * stride;
    plain[entryAt] = currentOffset & 0xff;
    plain[entryAt + 1] = (currentOffset >> 8) & 0xff;
    plain[entryAt + 2] = (item.startingRoom ?? 0) & 0xff;

    for (let c = 0; c < item.name.length; c++) {
      plain[poolAt++] = item.name.charCodeAt(c);
    }
    plain[poolAt++] = 0;
    currentOffset += item.name.length + 1;
  }

  if (!profile.inventoryMetadataEncrypted) return plain;
  const encrypted = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) {
    encrypted[i] = plain[i]! ^ MESSAGE_KEY.charCodeAt(i % MESSAGE_KEY.length);
  }
  return encrypted;
}
