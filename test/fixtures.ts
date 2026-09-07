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
 * installation folder is absent. Installations disagree on case (PQ1 ships
 * every file lowercase) and Linux lookups are case-sensitive, so all fixture
 * access resolves through this map.
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
  const names = fixtureFiles(slug);
  if (!names) return null;
  for (const [key, actual] of names) {
    if (!/^[a-z0-9_]+dir$/.test(key) || SPLIT_DIRECTORIES.includes(key.toUpperCase())) continue;
    return { name: actual, prefix: actual.slice(0, -3).toUpperCase() };
  }
  return null;
}

/** Section order of a v3 combined directory. */
const COMBINED_SECTION_KINDS = ["logic", "picture", "view", "sound"] as const;

/**
 * Shipped directories with junk entries pointing at volumes that never
 * shipped with the game, verified entry by entry. These are excluded from
 * the volume census; any other missing volume still skips the test. KQ4's
 * KQ4DIR points picture 150/151 at KQ4VOL.6 and view 198/199 at KQ4VOL.7,
 * which no KQ4VOL.* contains and no logic ever loads.
 */
const JUNK_DIRECTORY_ENTRIES: Record<string, readonly string[]> = {
  kq4: ["picture 150", "picture 151", "view 198", "view 199"],
};

/** Volume numbers referenced by a run of three-byte entries (v2 rule: high nibble 0xf is absent). */
function referencedVolumes(
  entries: Uint8Array,
  exactAbsence: boolean,
  skipEntry?: (num: number) => boolean,
): Set<number> {
  const volumes = new Set<number>();
  for (let offset = 0; offset + 2 < entries.length; offset += 3) {
    const absent = exactAbsence
      ? entries[offset] === 255 && entries[offset + 1] === 255 && entries[offset + 2] === 255
      : entries[offset]! >> 4 === 15;
    if (!absent && !skipEntry?.(offset / 3)) volumes.add(entries[offset]! >> 4);
  }
  return volumes;
}

/** A Node test skip reason, also shared by browser tests and local tools. */
export function fixtureSkip(slug: string, requiredFiles: readonly string[] = []): false | string {
  const dir = fixtureDir(slug);
  const onDisk = fixtureFiles(slug);
  const combined = combinedDirectory(slug);
  const prefix = combined?.prefix ?? "";
  const required = new Set([
    ...(combined ? [combined.name] : SPLIT_DIRECTORIES),
    "WORDS.TOK",
    "OBJECT",
    `${prefix}VOL.0`,
    ...requiredFiles,
  ]);
  if (combined && onDisk) {
    // Four u16le section offsets, then the logic, picture, view and sound entries.
    const bytes = readFileSync(dir + onDisk.get(combined.name.toLowerCase())!);
    const offsets = [0, 1, 2, 3].map((i) => bytes[i * 2]! | (bytes[i * 2 + 1]! << 8));
    offsets.push(bytes.length);
    const junk = JUNK_DIRECTORY_ENTRIES[slug] ?? [];
    for (let i = 0; i < 4; i++) {
      const kind = COMBINED_SECTION_KINDS[i]!;
      for (const volume of referencedVolumes(
        bytes.subarray(offsets[i], offsets[i + 1]),
        true,
        (num) => junk.includes(`${kind} ${num}`),
      ))
        required.add(`${prefix}VOL.${volume}`);
    }
  } else {
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
