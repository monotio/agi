/**
 * Direct-checkpoint admission for a live project download. The worker's
 * history recovery reply carries a checkpoint image plus the `HistoryBoot`
 * it was recorded on — `boot.files` are the raw container files, while the
 * exported offer carries the same files with the authored vocabulary
 * overlaid onto WORDS.TOK (the worker's `exportFiles` semantics). The two
 * helpers prove the checkpoint belongs to the offered bytes before the
 * archive may carry it: `checkpointBasisMatches` compares the native file
 * basis and the vocabulary semantically, and `autosaveRecordRestores` runs
 * the same real decode-and-restore check the archive reader applies at
 * import. A checkpoint that fails either is omitted with a note, never
 * relabelled.
 */
import { parseWordsTok } from "../../../src/logic/words.ts";
import { isPlayableFileName } from "../../../src/container/playableFiles.ts";
import { base64ToBytes } from "../project/bytes.ts";
import { AUTOSAVE_FILE, type AutosaveRecord } from "../saves/gameProgress.ts";
import type { HistoryBoot } from "../../../src/agent/history.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

/**
 * The checkpoint's recorded resource basis is the offered game's: every
 * playable file identical, and the snapshot's live dictionary exactly the
 * vocabulary the offered WORDS.TOK parses to. WORDS.TOK itself is compared
 * through the dictionary — the boot files carry the container's copy, the
 * offer carries the authored overlay, and only the parsed vocabulary is the
 * shared basis either way.
 */
export function checkpointBasisMatches(
  boot: HistoryBoot,
  files: Record<string, Uint8Array>,
): boolean {
  let bootFiles: Record<string, Uint8Array>;
  try {
    bootFiles = Object.fromEntries(
      Object.entries(boot.files).map(([name, data]) => [name, base64ToBytes(data)]),
    );
  } catch {
    return false;
  }
  for (const [name, bytes] of Object.entries(files)) {
    if (!isPlayableFileName(name) || name === "WORDS.TOK") continue;
    const recorded = bootFiles[name];
    if (recorded === undefined || !bytesEqual(recorded, bytes)) return false;
  }
  for (const name of Object.keys(bootFiles)) {
    if (!isPlayableFileName(name) || name === "WORDS.TOK") continue;
    if (files[name] === undefined) return false;
  }
  const wordsTok = files["WORDS.TOK"];
  const dictionary = new Map(boot.dictionary);
  if (wordsTok === undefined) return dictionary.size === 0;
  let offered: Map<string, number>;
  try {
    offered = new Map(parseWordsTok(wordsTok).map(({ word, id }) => [word, id]));
  } catch {
    return false;
  }
  if (offered.size !== dictionary.size) return false;
  for (const [word, id] of dictionary) if (offered.get(word) !== id) return false;
  return true;
}

/**
 * The checkpoint record must decode and restore into the offered game under
 * the interpreter the archive ships with — the identical check
 * `readGameZip` performs on `SAVES/AUTOSAVE.JSON` at import. The gameProgress
 * import boundary keeps the runtime Engine out of the menu chunk.
 */
export async function autosaveRecordRestores(
  record: AutosaveRecord,
  files: Record<string, Uint8Array>,
  override?: ProfileId,
): Promise<boolean> {
  try {
    const { readProgressEntries } = await import("../saves/gameProgressImport.ts");
    const entries = new Map<string, Uint8Array>([
      [AUTOSAVE_FILE, new TextEncoder().encode(JSON.stringify(record))],
    ]);
    return readProgressEntries(entries, "", files, override) !== undefined;
  } catch {
    return false;
  }
}
