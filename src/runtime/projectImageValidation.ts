/** Detached native validation for complete project images. */
import type { GameContainer } from "../types.ts";
import type { AgiProfile } from "./profile.ts";
import { decodeInventoryFile, inventoryTableFits } from "./inventoryFile.ts";
import { diffResources, validateCandidateResource, stageDictionary } from "./previewAdmission.ts";

function fileChanged(container: GameContainer, previous: GameContainer, name: string): boolean {
  const bytes = container.files.get(name);
  const before = previous.files.get(name);
  return (
    bytes !== undefined &&
    (before === undefined ||
      bytes.length !== before.length ||
      bytes.some((byte, i) => byte !== before[i]))
  );
}

/** Validate changed payloads; unchanged imported bytes retain their native runtime behavior. */
export function validateCompleteImage(
  container: GameContainer,
  profile: AgiProfile,
  soundDevice: number,
  previous: GameContainer,
): void {
  for (const { kind, num, newPayload, oldPayload } of diffResources(previous, container).changes)
    validateCandidateResource(kind, num, newPayload, oldPayload, profile, soundDevice);
  const words = container.files.get("WORDS.TOK");
  if (words !== undefined && fileChanged(container, previous, "WORDS.TOK")) stageDictionary(words);
  const objects = container.files.get("OBJECT");
  if (objects === undefined || !fileChanged(container, previous, "OBJECT")) return;
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
