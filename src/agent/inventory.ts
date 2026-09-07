import type { AgiProfile } from "../runtime/profile.ts";
import { decodeInventoryFile, inventoryTableFits } from "../runtime/inventoryFile.ts";

/** Decode the OBJECT table for authoring validation and context. */
export function readInventoryObjects(payload: Uint8Array | undefined, profile: AgiProfile) {
  if (!payload) return [];
  const data = decodeInventoryFile(payload, profile);
  if (data.length < 3) throw new Error("Invalid inventory header");
  const size = data[0]! | (data[1]! << 8);
  if (!inventoryTableFits(data)) throw new Error("Invalid inventory table");
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
  // Compare the decoded header: a plain stub read through the fallback and its
  // encrypted replacement share a maximum object index but not a storage byte.
  const objectIndex = (payload: Uint8Array): number => decodeInventoryFile(payload, profile)[2]!;
  if (
    (previous && objectIndex(previous) !== objectIndex(next)) ||
    before.some(
      (item, i) => item.name !== after[i]?.name || item.startingRoom !== after[i]?.startingRoom,
    )
  )
    throw new Error(
      "Keep existing inventory entries in order with their original startingRoom; append new items.",
    );
}
