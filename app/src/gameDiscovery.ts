import type { InstalledGameDescriptor } from "./gameTypes.ts";

const FIXTURE_FILE_PATTERN =
  /^([A-Z0-9_]*DIR|[A-Z0-9_]*VOL\.(?:[0-9]|1[0-5])|WORDS\.TOK|OBJECT|AGIDATA\.OVL|AGI|[A-Z0-9_-]+\.COM)$/i;

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
          return {
            hash: item.hash ?? item.wordsSha256 ?? item.folder,
            alias: item.alias ?? item.folder,
            title: item.title ?? (item.folder ? item.folder.toUpperCase() : "AGI GAME"),
            ...(item.author ? { author: item.author } : {}),
            ...(item.walkthroughLabel ? { walkthroughLabel: item.walkthroughLabel } : {}),
            ...(item.wordsSha256 ? { wordsSha256: item.wordsSha256 } : {}),
            ...(item.objectSha256 ? { objectSha256: item.objectSha256 } : {}),
            ...(item.folder ? { folder: item.folder } : {}),
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
  hashOrAlias: string,
): { target: string; match?: InstalledGameDescriptor } {
  const norm = hashOrAlias.toLowerCase();
  const match = (installedGames ?? []).find(
    (g) =>
      g.hash.toLowerCase() === norm ||
      g.alias.toLowerCase() === norm ||
      g.wordsSha256?.toLowerCase() === norm ||
      g.folder?.toLowerCase() === norm,
  );
  const target = match?.wordsSha256 ?? match?.hash ?? hashOrAlias;
  return match ? { target, match } : { target };
}

/**
 * Fetch directory manifest and files for a fixture game.
 */
export async function fetchFixtureFiles(target: string): Promise<Record<string, Uint8Array>> {
  const manifestRes = await fetch(`/fixtures/${target}/`);
  if (!manifestRes.ok) throw new Error(`Fixture manifest fetch failed for ${target}`);
  const manifest: string[] = await manifestRes.json();
  const names = manifest.filter((name) => FIXTURE_FILE_PATTERN.test(name));
  const files: Record<string, Uint8Array> = {};
  for (const name of names) {
    const res = await fetch(`/fixtures/${target}/${name}`);
    if (!res.ok) throw new Error(`fixture fetch failed: ${name}`);
    files[name.toUpperCase()] = new Uint8Array(await res.arrayBuffer());
  }
  return files;
}
