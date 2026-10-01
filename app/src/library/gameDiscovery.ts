import { preferCatalogedEdition, type InstalledGameDescriptor } from "../project/gameTypes.ts";
import { isPlayableFileName } from "../project/gameMetadata.ts";
import { canonicalResourceName } from "../../../src/types.ts";
import { gameIdentity, resourceRevision } from "../../../src/gameIdentity.ts";
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";

/**
 * Discover games installed in the local fixtures directory (Vite dev server).
 */
export async function discoverInstalledGames(): Promise<InstalledGameDescriptor[]> {
  if (!import.meta.env.DEV) return [];
  try {
    const res = await fetch("/fixtures/");
    if (!res.ok) return [];
    const raw = await res.json();
    return Array.isArray(raw)
      ? raw.map((item) => {
          if (typeof item === "string") {
            return { hash: item, alias: item, title: item.toUpperCase() };
          }
          // The public metadata spellings a GAME.JSON export declares are
          // validated at the transport edge like the archive readers do: a
          // revision and parent become branded identities or stay out, and
          // only an interpreter this build ships can be named.
          const revision = resourceRevision(item.revision);
          const parent = gameIdentity(item.parent);
          const profile: ProfileId | undefined =
            typeof item.profile === "string" && Object.hasOwn(PROFILES, item.profile)
              ? (item.profile as ProfileId)
              : undefined;
          return {
            hash: item.hash ?? item.wordsSha256 ?? item.folder,
            alias: item.alias ?? item.folder,
            title: item.title ?? (item.folder ? item.folder.toUpperCase() : "AGI GAME"),
            ...(item.author ? { author: item.author } : {}),
            ...(item.walkthroughLabel ? { walkthroughLabel: item.walkthroughLabel } : {}),
            ...(item.wordsSha256 ? { wordsSha256: item.wordsSha256 } : {}),
            ...(item.objectSha256 ? { objectSha256: item.objectSha256 } : {}),
            ...(revision ? { revision } : {}),
            ...(item.folder ? { folder: item.folder } : {}),
            ...(profile ? { profile } : {}),
            ...(parent ? { parent } : {}),
          } as InstalledGameDescriptor;
        })
      : [];
  } catch {
    return [];
  }
}

/**
 * Resolve an input target (hash, alias, or folder) against discovered installed games.
 */
export function resolveFixtureTarget(
  installedGames: readonly InstalledGameDescriptor[] | null,
  query: string,
): { target: string; match?: InstalledGameDescriptor | undefined } {
  const norm = query.toLowerCase();
  const games = installedGames ?? [];

  // Match folder first for unambiguous instance selection: the exact
  // case-sensitive spelling names one instance outright, while a folded
  // spelling is a convenience that resolves only when a single folder
  // answers — two folders differing only by case are distinct instances.
  const exactFolder = games.find((g) => g.folder === query);
  if (exactFolder) {
    return { target: query, match: exactFolder };
  }
  const byFolder = games.filter((g) => g.folder?.toLowerCase() === norm);
  if (byFolder.length === 1) {
    const match = byFolder[0]!;
    return { target: match.folder ?? query, match };
  }
  if (byFolder.length > 1) {
    throw new Error(
      `Ambiguous fixture query "${query}" matches multiple folders (${byFolder.map((g) => g.folder).join(", ")}); specify the fixture folder.`,
    );
  }

  // Match by exact hash
  const byHash = games.filter((g) => g.hash.toLowerCase() === norm);
  if (byHash.length === 1) {
    const match = byHash[0]!;
    return { target: match.folder ?? match.hash, match };
  } else if (byHash.length > 1) {
    const cataloged = preferCatalogedEdition(byHash);
    if (cataloged) return { target: cataloged.folder ?? cataloged.hash, match: cataloged };
    throw new Error(
      `Ambiguous fixture query "${query}" matches multiple editions (${byHash.map((g) => g.folder).join(", ")}); specify the fixture folder.`,
    );
  }

  // Match by full bundle revision — the exact-content spelling
  const byRevision = games.filter((g) => g.revision?.toLowerCase() === norm);
  if (byRevision.length === 1) {
    const match = byRevision[0]!;
    return { target: match.folder ?? match.revision ?? match.hash, match };
  } else if (byRevision.length > 1) {
    const cataloged = preferCatalogedEdition(byRevision);
    if (cataloged)
      return {
        target: cataloged.folder ?? cataloged.revision ?? cataloged.hash,
        match: cataloged,
      };
    throw new Error(
      `Ambiguous fixture query "${query}" matches multiple editions (${byRevision.map((g) => g.folder).join(", ")}); specify the fixture folder.`,
    );
  }

  // Match by wordsSha256
  const byWords = games.filter((g) => g.wordsSha256?.toLowerCase() === norm);
  if (byWords.length === 1) {
    const match = byWords[0]!;
    return { target: match.folder ?? match.wordsSha256 ?? match.hash, match };
  } else if (byWords.length > 1) {
    const cataloged = preferCatalogedEdition(byWords);
    if (cataloged)
      return {
        target: cataloged.folder ?? cataloged.wordsSha256 ?? cataloged.hash,
        match: cataloged,
      };
    throw new Error(
      `Ambiguous fixture query "${query}" matches multiple editions (${byWords.map((g) => g.folder).join(", ")}); specify the fixture folder.`,
    );
  }

  // Match by alias
  const byAlias = games.filter((g) => g.alias.toLowerCase() === norm);
  if (byAlias.length === 1) {
    const match = byAlias[0]!;
    return { target: match.folder ?? match.alias, match };
  } else if (byAlias.length > 1) {
    const cataloged = preferCatalogedEdition(byAlias);
    if (cataloged) return { target: cataloged.folder ?? cataloged.alias, match: cataloged };
    throw new Error(
      `Ambiguous fixture query "${query}" matches multiple editions (${byAlias.map((g) => g.folder).join(", ")}); specify the fixture folder.`,
    );
  }

  return { target: query };
}

/**
 * Fetch directory manifest and files for a fixture game.
 */
export async function fetchFixtureFiles(target: string): Promise<Record<string, Uint8Array>> {
  const encoded = encodeURIComponent(target);
  const manifestRes = await fetch(`/fixtures/${encoded}/`);
  if (!manifestRes.ok) throw new Error(`Fixture manifest fetch failed for ${target}`);
  const manifest: string[] = await manifestRes.json();
  const names = manifest.filter(isPlayableFileName);
  const files: Record<string, Uint8Array> = {};
  for (const name of names) {
    const res = await fetch(`/fixtures/${encoded}/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`fixture fetch failed: ${name}`);
    files[canonicalResourceName(name)] = new Uint8Array(await res.arrayBuffer());
  }
  return files;
}
