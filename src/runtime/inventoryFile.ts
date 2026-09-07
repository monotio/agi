/**
 * OBJECT metadata storage (agi-re spec, "Inventory metadata file"): the early
 * profiles store the expanded bytes directly; the later profiles XOR-encode the
 * file byte for byte with the repeating "Avis Durgan" key.
 */

import { MESSAGE_KEY } from "../logic/resource.ts";
import type { AgiProfile } from "./profile.ts";

function xorWithKey(payload: Uint8Array): Uint8Array {
  return payload.map((byte, i) => byte ^ MESSAGE_KEY.charCodeAt(i % MESSAGE_KEY.length));
}

/**
 * A decoded file whose item table fits: the size is a whole number of
 * three-byte entries and the table ends inside the file. Any transform of the
 * wrong reading fails this for realistic files, because the key bytes land in
 * the size field.
 */
export function inventoryTableFits(decoded: Uint8Array): boolean {
  if (decoded.length < 3) return false;
  const tableSize = decoded[0]! | (decoded[1]! << 8);
  return tableSize % 3 === 0 && 3 + tableSize <= decoded.length;
}

/**
 * The expanded OBJECT file for a profile. The profile's storage rule is
 * applied first. When that reading has no fitting item table but the opposite
 * reading does, the opposite reading is used: development and demonstration
 * installations ship a plain stub OBJECT next to a later interpreter
 * (observed: a Sierra 3.002.102 demo pack with an eight-byte plain file), and
 * decoding such a stub with the key yields thousands of phantom items.
 */
export function decodeInventoryFile(payload: Uint8Array, profile: AgiProfile): Uint8Array {
  const expected = profile.inventoryMetadataEncrypted ? xorWithKey(payload) : payload.slice();
  if (inventoryTableFits(expected)) return expected;
  const alternative = profile.inventoryMetadataEncrypted ? payload.slice() : xorWithKey(payload);
  return inventoryTableFits(alternative) ? alternative : expected;
}
