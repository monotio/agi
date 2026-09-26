/**
 * One card per game on the Home shelf. A catalog release keeps one identity
 * however it reached this browser: the catalog entry itself, the library copy
 * that Play stores (source "catalog", same release id and version), and an
 * installed development fixture of the same game. Copies and remixes are new
 * games with their own identity and keep their own cards.
 */
import type { CachedGameMeta } from "../gameStorage.ts";
import type { GameCatalogEntry } from "../gameCatalog.ts";
import type { InstalledGameDescriptor } from "../gameTypes.ts";
import { getKnownGameByRevision } from "../../../src/games/knownGames.ts";

/** The library copy Play stored for this catalog release, if any. */
export function catalogLibraryCopy(
  games: readonly CachedGameMeta[],
  entry: GameCatalogEntry,
): CachedGameMeta | undefined {
  return games.find(
    (game) =>
      game.library?.source === "catalog" &&
      game.library.catalog?.id === entry.id &&
      game.library.catalog.version === entry.version,
  );
}

/** An installed fixture that is the same known game as this catalog entry. */
export function isInstalledCatalogCopy(
  game: InstalledGameDescriptor,
  entry: GameCatalogEntry,
): boolean {
  const known = game.revision ? getKnownGameByRevision(game.revision) : null;
  return (known?.alias ?? game.alias) === entry.id;
}
