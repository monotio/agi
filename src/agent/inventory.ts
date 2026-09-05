import type { AgiProfile } from "../runtime/profile.ts";
import { MESSAGE_KEY } from "../logic/resource.ts";

/** Decode the OBJECT table for authoring validation and context. */
export function readInventoryObjects(payload: Uint8Array | undefined, profile: AgiProfile) {
  if (!payload) return [];
  const data = payload.map(
    (byte, i) =>
      byte ^
      (profile.inventoryMetadataEncrypted ? MESSAGE_KEY.charCodeAt(i % MESSAGE_KEY.length) : 0),
  );
  if (data.length < 3) throw new Error("Invalid inventory header");
  const size = data[0]! | (data[1]! << 8);
  if (size % 3 || size > 256 * 3 || size + 3 > data.length)
    throw new Error("Invalid inventory table");
  return Array.from({ length: size / 3 }, (_, i) => {
    const entry = 3 + i * 3;
    let at = 3 + (data[entry]! | (data[entry + 1]! << 8));
    if (at < size + 3 || at >= data.length) throw new Error("Invalid inventory name offset");
    let name = "";
    while (at < data.length && data[at] !== 0) name += String.fromCharCode(data[at++]!);
    if (at === data.length) throw new Error("Unterminated inventory name");
    return { name, startingRoom: data[entry + 2]! };
  });
}

/** New rooms can append items; existing item numbers and initial metadata stay stable. */
export function validateRoomInventory(
  previous: Uint8Array | undefined,
  next: Uint8Array,
  profile: AgiProfile,
): void {
  const before = readInventoryObjects(previous, profile);
  const after = readInventoryObjects(next, profile);
  if (
    (previous && previous[2] !== next[2]) ||
    before.some(
      (item, i) => item.name !== after[i]?.name || item.startingRoom !== after[i]?.startingRoom,
    )
  )
    throw new Error(
      "Keep existing inventory entries in order with their original startingRoom; append new items.",
    );
}
