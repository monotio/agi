export {
  type GameHash,
  type KnownAgiGame,
  KNOWN_GAME_HASH,
  KNOWN_GAMES,
  getKnownGameById,
  getKnownGameByHash,
  getKnownGameByRevision,
  detectKnownGameByHashes,
  resolveGameHash,
} from "../../src/games/knownGames.ts";
import { detectKnownGameByHashes, type KnownAgiGame } from "../../src/games/knownGames.ts";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
