import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Locate a local game installation under games/<slug>/. Always ends with "/".
 */
export function fixtureDir(slug: string): string {
  return fileURLToPath(new URL(`../games/${slug}/`, import.meta.url));
}

const SPLIT_DIRECTORIES = ["LOGDIR", "PICDIR", "VIEWDIR", "SNDDIR"];

/**
 * The v3 combined directory of an installation (`<PREFIX>DIR`, e.g. GRDIR),
 * or null for a v2 split installation. Combined installations name their
 * volumes `<PREFIX>VOL.n`.
 */
export function combinedDirectory(slug: string): { name: string; prefix: string } | null {
  const dir = fixtureDir(slug);
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!/^[A-Z0-9_]+DIR$/.test(name) || SPLIT_DIRECTORIES.includes(name)) continue;
    return { name, prefix: name.slice(0, -3) };
  }
  return null;
}

/** Volume numbers referenced by a run of three-byte entries (v2 rule: high nibble 0xf is absent). */
function referencedVolumes(entries: Uint8Array, exactAbsence: boolean): Set<number> {
  const volumes = new Set<number>();
  for (let offset = 0; offset + 2 < entries.length; offset += 3) {
    const absent = exactAbsence
      ? entries[offset] === 255 && entries[offset + 1] === 255 && entries[offset + 2] === 255
      : entries[offset]! >> 4 === 15;
    if (!absent) volumes.add(entries[offset]! >> 4);
  }
  return volumes;
}

/** A Node test skip reason, also shared by browser tests and local tools. */
export function fixtureSkip(slug: string, requiredFiles: readonly string[] = []): false | string {
  const dir = fixtureDir(slug);
  const combined = combinedDirectory(slug);
  const prefix = combined?.prefix ?? "";
  const required = new Set([
    ...(combined ? [combined.name] : SPLIT_DIRECTORIES),
    "WORDS.TOK",
    "OBJECT",
    `${prefix}VOL.0`,
    ...requiredFiles,
  ]);
  if (combined) {
    // Four u16le section offsets, then the logic, picture, view and sound entries.
    const bytes = readFileSync(dir + combined.name);
    const offsets = [0, 1, 2, 3].map((i) => bytes[i * 2]! | (bytes[i * 2 + 1]! << 8));
    offsets.push(bytes.length);
    for (let i = 0; i < 4; i++) {
      for (const volume of referencedVolumes(bytes.subarray(offsets[i], offsets[i + 1]), true))
        required.add(`${prefix}VOL.${volume}`);
    }
  } else {
    for (const name of SPLIT_DIRECTORIES) {
      if (!existsSync(dir + name)) continue;
      for (const volume of referencedVolumes(readFileSync(dir + name), false))
        required.add(`VOL.${volume}`);
    }
  }
  const missing = [...required].filter((name) => !existsSync(dir + name));
  return missing.length
    ? `Place your own game files in games/${slug}/ to run this test (missing: ${missing.join(", ")}).`
    : false;
}

export function hasFixture(slug: string): boolean {
  return fixtureSkip(slug) === false;
}

export const KQ1_DIR = fixtureDir("kq1");
