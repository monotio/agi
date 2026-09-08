import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Locate a local game installation under games/<slug>/. Always ends with "/".
 */
export function fixtureDir(slug: string): string {
  return fileURLToPath(new URL(`../games/${slug}/`, import.meta.url));
}

/**
 * On-disk names of an installation, keyed by lowercase name, or null when the
 * installation folder is absent. Resolve fixture names case-insensitively
 * so the same inputs work on case-sensitive and case-insensitive filesystems.
 */
export function fixtureFiles(slug: string): ReadonlyMap<string, string> | null {
  const dir = fixtureDir(slug);
  if (!existsSync(dir)) return null;
  const names = new Map<string, string>();
  for (const name of readdirSync(dir)) names.set(name.toLowerCase(), name);
  return names;
}

const SPLIT_DIRECTORIES = ["LOGDIR", "PICDIR", "VIEWDIR", "SNDDIR"];

/**
 * The v3 combined directory of an installation (`<PREFIX>DIR`, e.g. GRDIR),
 * or null for a v2 split installation. Combined installations name their
 * volumes `<PREFIX>VOL.n`.
 */
export function combinedDirectory(slug: string): { name: string; prefix: string } | null {
  return combinedDirectoryOf(fixtureFiles(slug));
}

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

export interface FixtureRequirements {
  /** Require resource directories, vocabulary and object metadata. Defaults to true. */
  readonly resourceFiles?: boolean;
  /** Require every volume named by a directory. Set false for tests that read only part of a game. */
  readonly checkVolumes?: boolean;
}

/** Volume numbers referenced by a run of three-byte entries (v2 rule: high nibble 0xf is absent). */
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

/** A Node test skip reason, also shared by browser tests and local tools. */
export function fixtureSkip(
  slug: string,
  requiredFiles: readonly string[] = [],
  options: FixtureRequirements = {},
): false | string {
  return fixtureReadiness(slug, fixtureDir(slug), fixtureFiles(slug), requiredFiles, options);
}

/**
 * The installation census behind fixtureSkip, with the directory and its
 * on-disk names passed in so a synthetic installation can exercise it
 * without a real fixture: the directory file(s), WORDS.TOK, OBJECT, every
 * volume a directory entry references and
 * any caller-required files. Returns the skip message naming what is
 * missing, or false when the requested inputs are present. Binary-only evidence
 * may set resourceFiles:false with an explicit nonempty list of named files.
 * Tests that exercise only part of a game can set checkVolumes:false; resource
 * readers still reject unavailable data when those tests request it.
 */
export function fixtureReadiness(
  slug: string,
  dir: string,
  onDisk: ReadonlyMap<string, string> | null,
  requiredFiles: readonly string[] = [],
  options: FixtureRequirements = {},
): false | string {
  // Binary evidence has explicit dependencies and does not need playable game
  // resources. An empty list here would turn a missing installation green.
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
    // Four u16le section offsets, then the logic, picture, view and sound entries.
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
  return missing.length
    ? `Place your own game files in games/${slug}/ to run this test (missing: ${missing.join(", ")}).`
    : false;
}

export function hasFixture(slug: string): boolean {
  return fixtureSkip(slug) === false;
}

export const KQ1_DIR = fixtureDir("kq1");
