/**
 * One card per game on the Home shelf. A catalog release keeps one identity
 * however it reached this browser: the catalog entry itself, the library copy
 * that Play stores (source "catalog", same release id and version), and an
 * installed development fixture of the same game. A library copy of a release
 * the catalog no longer carries (the 1.0 tutorial beside 1.1) is its own game
 * with its own card, titled with its release. Copies and remixes are new games
 * with their own identity and keep their own cards.
 */
import type { CachedGameMeta } from "../project/gameStorage.ts";
import type { GameCatalogEntry } from "../library/gameCatalog.ts";
import type { InstalledGameDescriptor } from "../project/gameTypes.ts";
import { installedProgressTarget } from "../project/progressTarget.ts";
import { getKnownGameByRevision } from "../../../src/games/knownGames.ts";
import { projectId, type GameIdentity } from "../../../src/gameIdentity.ts";

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
 * A stored game's shelf title. A copy of a release the catalog no longer
 * carries keeps its release name: "Adventure Department 1.0". That is a
 * catalog copy Play stored, or an unchanged, unrenamed import whose bytes are
 * the known release (a 1.0 Project download added again with Add game).
 */
export function shelfTitle(game: CachedGameMeta, catalog: readonly GameCatalogEntry[]): string {
  const release = storedRelease(game);
  if (!release) return game.title;
  const carried = catalog.some(
    (entry) =>
      entry.id === release.id &&
      (release.version
        ? entry.version === release.version
        : releaseName(entry.version) === release.name),
  );
  return carried ? game.title : `${game.title} ${release.name}`;
}

/**
 * The catalog release a stored game is, by provenance or by its bytes: a
 * known release's alias is its catalog id and short release name
 * ("adventure-department-1.0"; the current release's alias is the bare id).
 */
function storedRelease(
  game: CachedGameMeta,
): { id: string; name: string; version?: string } | undefined {
  const library = game.library;
  if (library?.source === "catalog")
    return library.catalog
      ? { ...library.catalog, name: releaseName(library.catalog.version) }
      : undefined;
  if (!library || library.source === "remix") return undefined;
  const known = getKnownGameByRevision(library.revision);
  const match = known?.alias.match(/^(.+)-(\d+\.\d+)$/);
  if (!known || !match || known.title !== game.title) return undefined;
  return { id: match[1]!, name: match[2]! };
}

/** A verified catalog release shares its card; declared remixes keep their own. */
export function isInstalledCatalogCopy(
  game: InstalledGameDescriptor,
  entry: GameCatalogEntry,
): boolean {
  if (game.parent !== undefined || game.revision === undefined || game.title !== entry.title)
    return false;
  return getKnownGameByRevision(game.revision)?.alias === entry.id;
}

/**
 * Share a shelf card for the same explicit instance, full revision and declared
 * interpreter. Declared remixes keep their own cards. Progress stays separate.
 */
export function coalescesInstalled(saved: CachedGameMeta, game: InstalledGameDescriptor): boolean {
  if (game.parent !== undefined || saved.library?.parent !== undefined) return false;
  if (saved.library?.profile !== game.profile) return false;
  if (game.revision === undefined || saved.library?.revision !== game.revision) return false;
  const target = installedProgressTarget(game, game.revision);
  return target !== null && saved.projectId === target.identity.project;
}

/**
 * Resolve the declared parent pair against saved entries and installed identities,
 * including supplied legacy identity spellings. Conflicting titles show the raw
 * project id; an unmatched pair can use its verified known-release title.
 */
export function parentDisplayTitle(
  parent: GameIdentity,
  saved: readonly CachedGameMeta[],
  installed: readonly InstalledGameDescriptor[],
): string {
  const titles = new Set<string>();
  for (const game of saved) {
    if (game.projectId === parent.project && game.library?.revision === parent.revision)
      titles.add(game.title);
  }
  for (const game of installed) {
    if (game.revision === undefined || game.revision !== parent.revision) continue;
    const candidates = new Set<string>([game.hash, game.alias]);
    if (game.folder !== undefined && projectId(game.folder) !== null) candidates.add(game.folder);
    const target = installedProgressTarget(game, game.revision);
    if (target !== null) candidates.add(target.identity.project);
    if (candidates.has(parent.project)) titles.add(game.title);
  }
  if (titles.size === 1) return [...titles][0]!;
  if (titles.size > 1) return parent.project;
  return getKnownGameByRevision(parent.revision)?.title ?? parent.project;
}
