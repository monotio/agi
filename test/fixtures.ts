import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  KNOWN_GAME_HASH,
  detectKnownGameByHashes,
  getKnownGameByHash,
  getKnownGameByAlias,
  resolveGameHash,
  type GameHash,
  type KnownAgiGame,
} from "../src/games/knownGames.ts";
import {
  AMIGA_INTERPRETER_FILES,
  INTERPRETER_FILES,
  canonicalResourceName,
} from "../src/container/playableFiles.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import { unshippedDiskVolumes } from "../src/container/disk/volumes.ts";

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
    // The Amiga v3 `dirs` file is the combined directory with an empty prefix.
    if (key === "dirs") return { name: actual, prefix: "" };
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
/**
 * A folder's entries, or null when it disappeared after the listing named it.
 * Test files run in parallel processes and some create and remove temporary
 * folders under games/, so a scan can meet a folder that is already gone.
 */
export function folderEntries(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

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
      const fileList = folderEntries(folderPath);
      if (fileList === null) continue;
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

      // The catalog fingerprints an edition by its WORDS.TOK + OBJECT pair; a
      // port or fan edition sharing only the vocabulary is not the catalogued
      // release and must not inherit its title or profile.
      const known = wordsSha256 ? detectKnownGameByHashes(wordsSha256, objectSha256) : null;
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
 * hash matches one plain edition plus such exports, the edition is the fixture.
 * Anything else ambiguous still asks.
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

  // A catalogued alias or vocabulary hash names one edition, fingerprinted by
  // its (WORDS.TOK, OBJECT) pair. Platform editions share the vocabulary but
  // not the OBJECT file, so a port alias never resolves to the PC release, nor
  // a PC query to a port; both stay reachable by folder name.
  const cataloged = getKnownGameByAlias(norm) ?? detectKnownGameByHashes(norm);
  if (cataloged) {
    const editions = (byWordsHash.get(cataloged.wordsSha256.toLowerCase()) ?? []).filter(
      (m) => m.known === cataloged,
    );
    return editions.length ? uniqueEdition(query, editions) : null;
  }

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
 * The file map profile detection sees for a fixture folder: every name under
 * its canonical spelling, with real bytes behind the names detection reads —
 * the interpreter executables and the WORDS.TOK/OBJECT catalog pair. Other
 * files keep placeholder bytes; detection only asks their names.
 */
function fixtureDetectionFiles(
  dir: string,
  onDisk: ReadonlyMap<string, string>,
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const actual of onDisk.values()) {
    const canonical = canonicalResourceName(actual);
    const upper = canonical.toUpperCase();
    const read =
      INTERPRETER_FILES.includes(upper) ||
      /^[A-Z0-9_-]+\.(?:COM|SYS16)$/.test(upper) ||
      Object.hasOwn(AMIGA_INTERPRETER_FILES, upper) ||
      upper === "WORDS.TOK" ||
      upper === "OBJECT";
    let bytes = new Uint8Array(0);
    if (read) {
      try {
        bytes = new Uint8Array(readFileSync(dir + actual));
      } catch {
        // An unreadable file is reported by the required-name check below.
      }
    }
    files.set(canonical, bytes);
  }
  return files;
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
    // An ambiguous query is a setup the contributor resolves; any other error
    // is a failure, and reporting it as a skip would hide it.
    const message = (err as Error).message;
    if (message.startsWith("Ambiguous fixture query")) return message;
    throw err;
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
    const unshipped = options.checkVolumes === "shipped" ? unshippedDiskVolumes(bytes) : [];
    // The absence rule of the fixture's own interpreter decides whether an
    // entry references a volume at all — detected on the fixture's real
    // bytes, through the same pipeline the container opens with. An Amiga
    // `dirs` entry whose volume nibble reads f names no VOL.15 (docs/testing.md).
    // The volumes are what this check computes, so detection cannot see the
    // container family off them; the combined directory itself declares it
    // through the unconditionally required first volume.
    const detectionFiles = fixtureDetectionFiles(dir, onDisk);
    detectionFiles.set(`${prefix}VOL.0`, detectionFiles.get(`${prefix}VOL.0`) ?? new Uint8Array(0));
    const exactAbsence = detectProfile(detectionFiles).directoryAbsence === "exact-fff";
    for (let i = 0; i < 4; i++) {
      for (const volume of referencedVolumes(
        bytes.subarray(offsets[i], offsets[i + 1]),
        exactAbsence,
      ))
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

/** Original media identities. Match image bytes, independently of local names. */
export const DISK_IMAGE_FIXTURES: Readonly<Record<string, readonly string[]>> = {
  "sq2-tandy": [
    "bb10899cd873746c8da6bcc942f8b9cedd26d174f087cabcaeb49f87d208dab3",
    "fed37cc0362dc55d1d8400c7f674131955c8ebe148c93ed982bf697f631a3818",
  ],
  "sq2-amiga": ["e46084876466879600fbde240a512dcd23b10e23058c680151d7f0e608dee4c4"],
  "sq2-iigs-2mg": [
    "b0f08338a2ccb8706097c62b40e537ba53fe9d22c7d8dfeedeebae6ec271b553",
    "6c3b701e0983ecdf709450a8563b93bf016e55c4bd589a4339835ebfa9210596",
  ],
  "sq2-iigs-po": [
    "d56922036e77aade45deb52923e643a2a87be25a2bb5c5c188496692b5a6c596",
    "f68511d0b9b21cb6bc7e4e9e072ddc7a6d5008081b8a07fcfdc487ae9be5d285",
  ],
  "ddp-booter": ["254c1406aeb25868fd5a188a534faa2855f468c5e02e76f4b628df8fbd8560c2"],
};

/** Scan each fixture folder for disk media; the complete image hash is authority. */
export function diskImageFixture(hash: string): { name: string; bytes: Uint8Array } | null {
  const root = fileURLToPath(new URL("../games/", import.meta.url));
  for (const folder of readdirSync(root)) {
    const directory = join(root, folder);
    if (!statSync(directory).isDirectory()) continue;
    for (const name of readdirSync(directory)) {
      if (!/\.(?:img|ima|dsk|td0|adf|po|2mg)$/i.test(name)) continue;
      const path = join(directory, name);
      if (!statSync(path).isFile()) continue;
      const bytes = new Uint8Array(readFileSync(path));
      if (createHash("sha256").update(bytes).digest("hex") === hash) return { name, bytes };
    }
  }
  return null;
}

export function diskImageSkip(hashes: readonly string[]): false | string {
  const missing = hashes.filter((hash) => !diskImageFixture(hash));
  return missing.length
    ? `Place your own disk images in a subfolder under games/ to run this test (image SHA-256: ${missing.join(", ")}). Add all disks in the set together.`
    : false;
}
