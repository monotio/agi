/** Native OBJECT writer shared by manual and agent authoring. */
import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";
import { decodeInventoryFile, inventoryTableFits } from "../runtime/inventoryFile.ts";

const MESSAGE_KEY = "Avis Durgan";

export function buildObjectFile(
  items: readonly { name: string; startingRoom?: number | undefined }[],
  profile: AgiProfile = DEFAULT_V2_PROFILE,
  maximumDrawableObjectIndex = 255,
): Uint8Array {
  const header = profile.inventoryHeaderBytes;
  const stride = profile.inventoryEntryBytes;
  if (items.length > 256) throw new RangeError("Inventory supports at most 256 items.");
  if (
    !Number.isInteger(maximumDrawableObjectIndex) ||
    maximumDrawableObjectIndex < 0 ||
    maximumDrawableObjectIndex > (header === 4 ? 0xffff : 0xff)
  )
    throw new RangeError("Invalid inventory drawable-object limit.");
  const tableSize = items.length * stride;
  let totalNamesLen = 0;
  for (const item of items) {
    if (typeof item.name !== "string") throw new Error("Inventory names must be text.");
    for (let i = 0; i < item.name.length; i++) {
      const byte = item.name.charCodeAt(i);
      if (byte === 0 || byte > 255)
        throw new Error("Inventory names must contain nonzero byte characters.");
    }
    if (
      item.startingRoom !== undefined &&
      (!Number.isInteger(item.startingRoom) || item.startingRoom < 0 || item.startingRoom > 255)
    )
      throw new RangeError("Inventory startingRoom must be an integer in 0..255.");
    totalNamesLen += item.name.length + 1;
    if (tableSize + totalNamesLen > 0xffff)
      throw new RangeError(
        "OBJECT authoring size limit exceeded; inventory name offsets must fit 16 bits.",
      );
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

/** Decode the OBJECT table for authoring validation and context. */
export function readInventoryObjects(payload: Uint8Array | undefined, profile: AgiProfile) {
  if (!payload) return [];
  const data = decodeInventoryFile(payload, profile);
  if (data.length < profile.inventoryHeaderBytes) throw new Error("Invalid inventory header");
  const size = data[0]! | (data[1]! << 8);
  if (!inventoryTableFits(data, profile)) throw new Error("Invalid inventory table");
  const header = profile.inventoryHeaderBytes;
  const stride = profile.inventoryEntryBytes;
  return Array.from({ length: size / stride }, (_, i) => {
    const entry = header + i * stride;
    let at = header + (data[entry]! | (data[entry + 1]! << 8));
    if (at < size + header || at >= data.length) throw new Error("Invalid inventory name offset");
    let name = "";
    while (at < data.length && data[at] !== 0) name += String.fromCharCode(data[at++]!);
    if (at === data.length) throw new Error("Unterminated inventory name");
    return { name, startingRoom: data[entry + 2]! };
  });
}
