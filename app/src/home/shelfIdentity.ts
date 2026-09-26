/**
 * One card per game on the Home shelf. A catalog release keeps one identity
 * however it reached this browser: the catalog entry itself, the library copy
 * that Play stores (source "catalog", same release id and version), and an
 * installed development fixture of the same game. A library copy of a release
 * the catalog no longer carries (the 1.0 tutorial beside 1.1) is its own game
 * with its own card, titled with its release. Copies and remixes are new games
 * with their own identity and keep their own cards.
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

/** A release's short name for the shelf: "1.0" for 1.0.0. */
export function releaseName(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

/**
 * A stored game's shelf title. A catalog copy of a release the catalog no
 * longer carries keeps its release name: "Adventure Department 1.0".
 */
export function shelfTitle(game: CachedGameMeta, catalog: readonly GameCatalogEntry[]): string {
  const release = game.library?.catalog;
  if (
    game.library?.source !== "catalog" ||
    !release ||
    catalog.some((entry) => entry.id === release.id && entry.version === release.version)
  )
    return game.title;
  return `${game.title} ${releaseName(release.version)}`;
}

/** An installed fixture that is the same known game as this catalog entry. */
export function isInstalledCatalogCopy(
  game: InstalledGameDescriptor,
  entry: GameCatalogEntry,
): boolean {
  const known = game.revision ? getKnownGameByRevision(game.revision) : null;
  return (known?.alias ?? game.alias) === entry.id;
}
