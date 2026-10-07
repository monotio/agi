import type { AgiProfile } from "../runtime/profile.ts";
import { decodeInventoryFile } from "../runtime/inventoryFile.ts";

import { readInventoryObjects } from "../authoring/inventory.ts";
export { readInventoryObjects } from "../authoring/inventory.ts";

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
