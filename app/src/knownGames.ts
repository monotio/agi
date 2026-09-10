export {
  type GameHash,
  type KnownAgiGame,
  KNOWN_GAME_HASH,
  KNOWN_GAMES,
  getKnownGameByAlias,
  getKnownGameByHash,
  getKnownGameByRevision,
  detectKnownGameByHashes,
  resolveGameHash,
} from "../../src/games/knownGames.ts";
import { detectKnownGameByHashes, type KnownAgiGame } from "../../src/games/knownGames.ts";
import { sha256Hex } from "./crypto.ts";

/** Identify a collection of game files by hashing WORDS.TOK. */
export async function detectKnownGame(
  files: Record<string, Uint8Array>,
): Promise<KnownAgiGame | null> {
  const words = files["WORDS.TOK"] ?? files["words.tok"];
  if (!words) return null;
  const wordsSha = await sha256Hex(words);
  const obj = files["OBJECT"] ?? files["object"];
  const objSha = obj ? await sha256Hex(obj) : undefined;
  return detectKnownGameByHashes(wordsSha, objSha);
}
