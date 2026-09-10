import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  KNOWN_GAME_HASH,
  getKnownGameByHash,
  getKnownGameByAlias,
  resolveGameHash,
  type GameHash,
  type KnownAgiGame,
} from "../src/games/knownGames.ts";

export { KNOWN_GAME_HASH, type GameHash };

export interface DiscoveredFixture {
  readonly folder: string;
  readonly hash: GameHash;
  readonly dir: string;
  readonly files: ReadonlyMap<string, string>;
  readonly combined: { name: string; prefix: string } | null;
  readonly known: KnownAgiGame | null | undefined;
  readonly title: string;
  readonly author?: string | undefined;
  readonly wordsSha256?: string | undefined;
  readonly objectSha256?: string | undefined;
}

const SPLIT_DIRECTORIES = ["LOGDIR", "PICDIR", "VIEWDIR", "SNDDIR"];

/** The combined directory among an installation's names, or null. */
function combinedDirectoryOf(
  names: ReadonlyMap<string, string> | null,
): { name: string; prefix: string } | null {
  if (!names) return null;
  for (const [key, actual] of names) {
    if (!/^[a-z0-9_]+dir$/.test(key) || SPLIT_DIRECTORIES.includes(key.toUpperCase())) continue;
    return { name: actual, prefix: actual.slice(0, -3).toUpperCase() };
  }
  return null;
}

let cachedScan: {
  byWordsHash: Map<string, DiscoveredFixture>;
  byDirName: Map<string, DiscoveredFixture>;
  all: readonly DiscoveredFixture[];
} | null = null;

export function clearFixtureCache(): void {
  cachedScan = null;
}

/**
 * Scan games/ subfolders, hashing WORDS.TOK (and OBJECT) to discover fixtures
 * by content hash regardless of local folder name.
 */
export function scanFixtures(): {
  byWordsHash: Map<string, DiscoveredFixture>;
  byDirName: Map<string, DiscoveredFixture>;
  all: readonly DiscoveredFixture[];
} {
  if (cachedScan) return cachedScan;
  const gamesRoot = fileURLToPath(new URL("../games/", import.meta.url));
  const byWordsHash = new Map<string, DiscoveredFixture>();
  const byDirName = new Map<string, DiscoveredFixture>();
  const all: DiscoveredFixture[] = [];

  if (existsSync(gamesRoot)) {
    for (const folder of readdirSync(gamesRoot)) {
      const folderPath = join(gamesRoot, folder);
      if (!statSync(folderPath, { throwIfNoEntry: false })?.isDirectory()) continue;
      const fileList = readdirSync(folderPath);
      const names = new Map<string, string>();
      for (const name of fileList) names.set(name.toLowerCase(), name);

      const wordsActual = names.get("words.tok");
      const objActual = names.get("object");
      let wordsSha256: string | undefined;
      let objectSha256: string | undefined;

      if (wordsActual) {
        try {
          wordsSha256 = createHash("sha256")
            .update(readFileSync(join(folderPath, wordsActual)))
            .digest("hex");
        } catch {
          // Unreadable file
        }
      }
      if (objActual) {
        try {
          objectSha256 = createHash("sha256")
            .update(readFileSync(join(folderPath, objActual)))
            .digest("hex");
        } catch {
          // Unreadable file
        }
      }

      const known = wordsSha256 ? getKnownGameByHash(wordsSha256) : null;
      let title: string | undefined = known?.title;
      let author: string | undefined = known?.author;

      const metaActual = names.get("metadata.json");
      if (!title && metaActual) {
        try {
          const parsed = JSON.parse(readFileSync(join(folderPath, metaActual), "utf8"));
          if (typeof parsed.title === "string") title = parsed.title;
          if (typeof parsed.author === "string") author = parsed.author;
        } catch {
          // Invalid json
        }
      }

      const combined = combinedDirectoryOf(names);
      const fixture: DiscoveredFixture = {
        folder,
        hash: wordsSha256 ?? folder,
        dir: folderPath.endsWith("/") ? folderPath : `${folderPath}/`,
        files: names,
        combined,
        known: known ?? null,
        title: title ?? folder,
        ...(wordsSha256 !== undefined ? { wordsSha256 } : {}),
        ...(objectSha256 !== undefined ? { objectSha256 } : {}),
        ...(author !== undefined ? { author } : {}),
      };

      if (wordsSha256) byWordsHash.set(wordsSha256.toLowerCase(), fixture);
      byDirName.set(folder.toLowerCase(), fixture);
      all.push(fixture);
    }
  }

  cachedScan = { byWordsHash, byDirName, all };
  return cachedScan;
}

/**
 * Find an installed fixture by its content hash (WORDS.TOK SHA-256) or alias/folder key.
 * Resolves by hash first so folder names are completely arbitrary.
 */
export function findFixture(hashOrAlias: string): DiscoveredFixture | null {
  const { byWordsHash, byDirName } = scanFixtures();
  const norm = hashOrAlias.toLowerCase();
  const byHash = byWordsHash.get(norm);
  if (byHash) return byHash;
  const resolved = resolveGameHash(norm);
  if (resolved) {
    const matched = byWordsHash.get(resolved.toLowerCase());
    if (matched) return matched;
  }
  const byDir = byDirName.get(norm);
  if (byDir) return byDir;

  // If a directory was created dynamically at runtime (e.g. temp test fixture):
  const gamesRoot = fileURLToPath(new URL("../games/", import.meta.url));
  const candidate = join(gamesRoot, hashOrAlias);
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    const fileList = readdirSync(candidate);
    const names = new Map<string, string>();
    for (const name of fileList) names.set(name.toLowerCase(), name);
    return {
      folder: hashOrAlias,
      hash: hashOrAlias,
      dir: candidate.endsWith("/") ? candidate : `${candidate}/`,
      files: names,
      combined: combinedDirectoryOf(names),
      known: null,
      title: hashOrAlias,
    };
  }
  return null;
}

/**
 * Locate a local game installation by content hash or alias.
 * Always ends with "/".
 */
export function fixtureDir(hashOrAlias: string): string {
  const fixture = findFixture(hashOrAlias);
  if (fixture) return fixture.dir;
  return fileURLToPath(new URL(`../games/${hashOrAlias}/`, import.meta.url));
}

/**
 * On-disk names of an installation, keyed by lowercase name, or null when the
 * installation folder is absent.
 */
export function fixtureFiles(hashOrAlias: string): ReadonlyMap<string, string> | null {
  const fixture = findFixture(hashOrAlias);
  return fixture ? fixture.files : null;
}

/**
 * The v3 combined directory of an installation (`<PREFIX>DIR`, e.g. GRDIR),
 * or null for a v2 split installation.
 */
export function combinedDirectory(hashOrAlias: string): { name: string; prefix: string } | null {
  const fixture = findFixture(hashOrAlias);
  return fixture ? fixture.combined : null;
}

export interface FixtureRequirements {
  readonly resourceFiles?: boolean;
  readonly checkVolumes?: boolean;
}

function referencedVolumes(entries: Uint8Array, exactAbsence: boolean): Set<number> {
  const volumes = new Set<number>();
  for (let offset = 0; offset + 2 < entries.length; offset += 3) {
    const absent = exactAbsence
      ? entries[offset] === 255 && entries[offset + 1] === 255 && entries[offset + 2] === 255
      : entries[offset]! >> 4 === 15;
    if (!absent) {
      const volume = entries[offset]! >> 4;
      volumes.add(volume);
    }
  }
  return volumes;
}

/** A Node test skip reason, resolved by content hash or key. */
export function fixtureSkip(
  hashOrKey: string,
  requiredFiles: readonly string[] = [],
  options: FixtureRequirements = {},
): false | string {
  const fixture = findFixture(hashOrKey);
  const dir = fixture ? fixture.dir : fixtureDir(hashOrKey);
  const onDisk = fixtureFiles(hashOrKey);
  if (!existsSync(dir) || !onDisk) {
    const known = getKnownGameByHash(hashOrKey) ?? getKnownGameByAlias(hashOrKey);
    const label = known ? `${known.title} (${known.wordsSha256})` : `games/${hashOrKey}/`;
    return `Place your own game files in ${label} to run this test.`;
  }
  return fixtureReadiness(hashOrKey, dir, onDisk, requiredFiles, options);
}

export function fixtureReadiness(
  gameId: string,
  dir: string,
  onDisk: ReadonlyMap<string, string> | null,
  requiredFiles: readonly string[] = [],
  options: FixtureRequirements = {},
): false | string {
  const resources = options.resourceFiles !== false;
  if (!resources && requiredFiles.length === 0)
    throw new Error("Binary-only fixture checks require named files.");
  const combined = combinedDirectoryOf(onDisk);
  const prefix = combined?.prefix ?? "";
  const required = new Set([
    ...(resources
      ? [
          ...(combined ? [combined.name] : SPLIT_DIRECTORIES),
          "WORDS.TOK",
          "OBJECT",
          `${prefix}VOL.0`,
        ]
      : []),
    ...requiredFiles,
  ]);
  if (resources && options.checkVolumes !== false && combined && onDisk) {
    const bytes = readFileSync(dir + onDisk.get(combined.name.toLowerCase())!);
    const offsets = [0, 1, 2, 3].map((i) => bytes[i * 2]! | (bytes[i * 2 + 1]! << 8));
    offsets.push(bytes.length);
    for (let i = 0; i < 4; i++) {
      for (const volume of referencedVolumes(bytes.subarray(offsets[i], offsets[i + 1]), true))
        required.add(`${prefix}VOL.${volume}`);
    }
  } else if (resources && options.checkVolumes !== false) {
    for (const name of SPLIT_DIRECTORIES) {
      const actual = onDisk?.get(name.toLowerCase());
      if (!actual) continue;
      for (const volume of referencedVolumes(readFileSync(dir + actual), false))
        required.add(`VOL.${volume}`);
    }
  }
  const missing = [...required].filter((name) => !onDisk?.has(name.toLowerCase()));
  if (!missing.length) return false;
  const known = getKnownGameByHash(gameId);
  const targetDesc = known ? `${known.title}` : `games/${gameId}/`;
  return `Place your own game files in ${targetDesc} to run this test (missing: ${missing.join(", ")}).`;
}

export function hasFixture(hashOrKey: string): boolean {
  return fixtureSkip(hashOrKey) === false;
}
