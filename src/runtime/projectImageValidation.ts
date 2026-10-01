/** Detached native validation for complete project images. */
import { RESOURCE_KINDS, type GameContainer } from "../types.ts";
import type { AgiProfile } from "./profile.ts";
import { decodeInventoryFile, inventoryTableFits } from "./inventoryFile.ts";
import { validateCandidateResource, stageDictionary } from "./previewAdmission.ts";

/** Validate every native resource before a candidate can be saved or replace a run. */
export function validateCompleteImage(
  container: GameContainer,
  profile: AgiProfile,
  soundDevice: number,
): void {
  for (const kind of RESOURCE_KINDS) {
    for (let num = 0; num < 256; num++) {
      const bytes = container.getResource(kind, num);
      if (bytes !== null) validateCandidateResource(kind, num, bytes, null, profile, soundDevice);
    }
  }
  const words = container.files.get("WORDS.TOK");
  if (words !== undefined) stageDictionary(words);
  const objects = container.files.get("OBJECT");
  if (objects === undefined) return;
  const decoded = decodeInventoryFile(objects, profile);
  if (!inventoryTableFits(decoded, profile)) throw new Error("OBJECT has an invalid item table.");
  const size = decoded[0]! | (decoded[1]! << 8);
  for (let entry = 0; entry < size; entry += profile.inventoryEntryBytes) {
    const at = profile.inventoryHeaderBytes + entry;
    let name = profile.inventoryHeaderBytes + (decoded[at]! | (decoded[at + 1]! << 8));
    if (name < profile.inventoryHeaderBytes + size || name >= decoded.length)
      throw new Error("OBJECT has an invalid item name offset.");
    while (name < decoded.length && decoded[name] !== 0) name++;
    if (name === decoded.length) throw new Error("OBJECT has an unterminated item name.");
  }
}
