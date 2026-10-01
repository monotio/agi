/**
 * Shared project-archive format helpers used by both the synchronous
 * readers/public ZIP writer (`projectArchive.ts`) and the on-demand full
 * archive preparation (`projectArchiveWriter.ts`). Neither side imports
 * the other, so the writer stays a lazy chunk the reader never anchors.
 * Conversation validation lives in `projectConversation.ts`, where the
 * entry composables reach it without anchoring these archive helpers.
 */
import type { ZipFileInput } from "./zip.ts";
import { publicGameMetadata, isPlayableFileName } from "../project/gameMetadata.ts";
import { buildObjectFile } from "../../../src/agent/agentState.ts";
import { detectProfile } from "../../../src/runtime/profile.ts";
import type { CachedGameData } from "../project/gameTypes.ts";

export { validateTranscript } from "./projectConversation.ts";

export const PROJECT_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Only current game resources and interpreter identification travel publicly.
 * The playable files ship exactly as stored: every write in the app repacks
 * its container (ResourceContainer.putResource), so a game made or changed
 * here carries no stale bytes, and an untouched original exports as the
 * same bytes it was imported as, with the same revision.
 */
export function gameEntries(
  data: Pick<CachedGameData, "files" | "title" | "roomGeneration" | "library">,
  supplyInventory = true,
): ZipFileInput[] {
  const files = new Map(Object.entries(data.files));
  if (supplyInventory && !files.has("OBJECT"))
    files.set("OBJECT", buildObjectFile([], detectProfile(files, data.library?.profile)));
  const entries = [...files]
    .filter(([name]) => isPlayableFileName(name))
    .map(([name, bytes]) => ({ name, data: bytes }) as ZipFileInput);
  entries.push({
    name: "GAME.JSON",
    data: JSON.stringify({
      format: "monotio.agi",
      version: 1,
      metadata: publicGameMetadata(data.library),
      title: data.title,
      // The player's interpreter choice travels with the game; detection
      // evidence does not — the importer checks the opening itself.
      ...(data.library?.profile ? { profile: data.library.profile } : {}),
      roomGeneration: data.roomGeneration === true,
      // Completion travels apart from generation: a copy that cannot grow
      // is still unfinished, through every later export.
      workInProgress: data.roomGeneration === true || data.library?.workInProgress === true,
    }),
  });
  return entries;
}
