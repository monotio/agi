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
export function combinedDirectoryOf(
  names: ReadonlyMap<string, string> | null,
): { name: string; prefix: string } | null {
  if (!names) return null;
  for (const [key, actual] of names) {
    if (!/^[a-z0-9_]*dir$/.test(key) || SPLIT_DIRECTORIES.includes(key.toUpperCase())) continue;
    return { name: actual, prefix: actual.slice(0, -3).toUpperCase() };
  }
  return null;
}

let cachedScan: {
  byWordsHash: Map<string, DiscoveredFixture[]>;
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
  byWordsHash: Map<string, DiscoveredFixture[]>;
  byDirName: Map<string, DiscoveredFixture>;
  all: readonly DiscoveredFixture[];
} {
  if (cachedScan) return cachedScan;
  const gamesRoot = fileURLToPath(new URL("../games/", import.meta.url));
  const byWordsHash = new Map<string, DiscoveredFixture[]>();
  const byDirName = new Map<string, DiscoveredFixture>();
  const all: DiscoveredFixture[] = [];

  if (existsSync(gamesRoot)) {
    for (const folder of readdirSync(gamesRoot)) {
      if (folder.startsWith(".")) continue;
      const folderPath = join(gamesRoot, folder);
      if (!statSync(folderPath, { throwIfNoEntry: false })?.isDirectory()) continue;
      const fileList = readdirSync(folderPath);
      const names = new Map<string, string>();
      for (const name of fileList) names.set(name.toLowerCase(), name);

      const combined = combinedDirectoryOf(names);
      const hasSplitDir = SPLIT_DIRECTORIES.some((d) => names.has(d.toLowerCase()));
      const hasVol = [...names.keys()].some((k) => /vol\.\d+$/.test(k));
      const hasGameJson = names.has("game.json");
      const hasWords = names.has("words.tok");
      if (!hasGameJson && !hasWords && !((combined !== null || hasSplitDir) && hasVol)) continue;

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

      const gameActual = names.get("game.json");
      if (gameActual) {
        try {
          const parsed = JSON.parse(readFileSync(join(folderPath, gameActual), "utf8"));
          if (parsed && typeof parsed === "object") {
            if (typeof parsed.title === "string") title = parsed.title;
            if (parsed.metadata && typeof parsed.metadata === "object") {
              if (typeof parsed.metadata.author === "string") author = parsed.metadata.author;
            }
          }
        } catch {
          // Invalid json
        }
      }

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

      if (wordsSha256) {
        const key = wordsSha256.toLowerCase();
        const list = byWordsHash.get(key) ?? [];
        list.push(fixture);
        byWordsHash.set(key, list);
      }
      byDirName.set(folder.toLowerCase(), fixture);
      all.push(fixture);
    }
  }

  cachedScan = { byWordsHash, byDirName, all };
  return cachedScan;
}

/**
 * A project export placed under `games/` (a `PROJECT.JSON` or `GAME.JSON`
 * beside the resources) is an authored copy, not an edition fixture. When a
 * hash matches one plain edition plus such exports, the edition is the fixture;
 * several plain editions or several exports stay ambiguous.
 */
function uniqueEdition(query: string, matches: readonly DiscoveredFixture[]): DiscoveredFixture {
  if (matches.length === 1) return matches[0]!;
  const editions = matches.filter((m) => !m.files.has("project.json") && !m.files.has("game.json"));
  if (editions.length === 1) return editions[0]!;
  throw new Error(
    `Ambiguous fixture query "${query}" matches multiple editions (${matches.map((m) => m.folder).join(", ")}); specify the fixture folder.`,
  );
}

/**
 * Find an installed fixture by its content hash (WORDS.TOK SHA-256) or alias/folder key.
 * Resolves by exact folder first, then unique content hash; a plain edition
 * wins over project exports that share its vocabulary.
 */
export function findFixture(query: string): DiscoveredFixture | null {
  const { byWordsHash, byDirName } = scanFixtures();
  const norm = query.toLowerCase();
  const byDir = byDirName.get(norm);
  if (byDir) return byDir;

  const matches = byWordsHash.get(norm);
  if (matches) return uniqueEdition(query, matches);

  const resolved = resolveGameHash(norm);
  if (resolved) {
    const matched = byWordsHash.get(resolved.toLowerCase());
    if (matched) return uniqueEdition(query, matched);
  }

  // If a directory was created dynamically at runtime (e.g. temp test fixture):
  const gamesRoot = fileURLToPath(new URL("../games/", import.meta.url));
  const candidate = join(gamesRoot, query);
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    const fileList = readdirSync(candidate);
    const names = new Map<string, string>();
    for (const name of fileList) names.set(name.toLowerCase(), name);
    return {
      folder: query,
      hash: query,
      dir: candidate.endsWith("/") ? candidate : `${candidate}/`,
      files: names,
      combined: combinedDirectoryOf(names),
      known: null,
      title: query,
    };
  }
  return null;
}

/** Absolute path to an installed game's folder, ending with a slash. */
export function fixtureDir(query: string): string {
  try {
    const fixture = findFixture(query);
    if (fixture) return fixture.dir;
  } catch {
    // Ambiguous query
  }
  const gamesRoot = fileURLToPath(new URL("../games/", import.meta.url));
  return join(gamesRoot, query) + "/";
}

/** Case-normalized file map of an installation, or null if missing. */
export function fixtureFiles(query: string): ReadonlyMap<string, string> | null {
  try {
    const fixture = findFixture(query);
    return fixture ? fixture.files : null;
  } catch {
    return null;
  }
}

/**
 * The v3 combined directory of an installation (`<PREFIX>DIR`, e.g. GRDIR),
 * or null for a v2 split installation.
 */
export function combinedDirectory(query: string): { name: string; prefix: string } | null {
  try {
    const fixture = findFixture(query);
    return fixture ? fixture.combined : null;
  } catch {
    return null;
  }
}

export interface FixtureRequirements {
  readonly resourceFiles?: boolean;
  /**
   * `true` (default) requires every volume the directories reference, `false`
   * only VOL.0. `"shipped"` requires every referenced volume except those a
   * fingerprinted original edition never shipped (see UNSHIPPED_VOLUMES), which
   * is what a play route through that edition can rely on.
   */
  readonly checkVolumes?: boolean | "shipped";
}

/**
 * Original releases whose combined directory references volumes absent from
 * the release itself, keyed by the directory file's SHA-256 so only that exact
 * edition gets the allowance. Both directories match the ScummVM detection
 * fingerprints for these releases; docs/testing.md records the evidence.
 */
const UNSHIPPED_VOLUMES: Record<string, readonly number[]> = {
  // King's Quest IV 2.0 (1988-07-27, 3.5"): pictures 150-151, views 198-199.
  "3ceb755dc98398f3369038d21528763c05aac926238681ad88efac74c60d4d2d": [6, 7],
  // Manhunter 2 3.02 (1989-07-26, 3.5"): sounds 215-216.
  f646929faac4b905c4ed9fe3d8661cb33c97e4ae3168c38fa097cf3e1dbd8948: [6],
};

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
  query: string,
  requiredFiles: readonly string[] = [],
  options: FixtureRequirements = {},
): false | string {
  // Code-assembled games have no fixture directory; the loader builds them.
  const known = getKnownGameByHash(query) ?? getKnownGameByAlias(query.toLowerCase());
  if (known?.builtin) return false;
  let fixture: DiscoveredFixture | null;
  try {
    fixture = findFixture(query);
  } catch (err) {
    return (err as Error).message;
  }
  const dir = fixture ? fixture.dir : fixtureDir(query);
  const onDisk = fixtureFiles(query);
  if (!existsSync(dir) || !onDisk) {
    const known = getKnownGameByHash(query) ?? getKnownGameByAlias(query);
    const label = known ? `${known.title} (${known.wordsSha256})` : `games/${query}/`;
    return `Place your own game files in ${label} to run this test.`;
  }
  return fixtureReadiness(query, dir, onDisk, requiredFiles, options);
}

export function fixtureReadiness(
  query: string,
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
    const unshipped =
      options.checkVolumes === "shipped"
        ? (UNSHIPPED_VOLUMES[createHash("sha256").update(bytes).digest("hex")] ?? [])
        : [];
    for (let i = 0; i < 4; i++) {
      for (const volume of referencedVolumes(bytes.subarray(offsets[i], offsets[i + 1]), true))
        if (!unshipped.includes(volume)) required.add(`${prefix}VOL.${volume}`);
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
  const known = getKnownGameByHash(query);
  const targetDesc = known ? `${known.title}` : `games/${query}/`;
  return `Place your own game files in ${targetDesc} to run this test (missing: ${missing.join(", ")}).`;
}

export function hasFixture(query: string): boolean {
  return fixtureSkip(query) === false;
}
