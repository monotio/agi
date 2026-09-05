import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Locate a local game installation under games/<slug>/. Always ends with "/".
 */
export function fixtureDir(slug: string): string {
  return fileURLToPath(new URL(`../games/${slug}/`, import.meta.url));
}

/** A Node test skip reason, also shared by browser tests and local tools. */
export function fixtureSkip(slug: string, requiredFiles: readonly string[] = []): false | string {
  const dir = fixtureDir(slug);
  const directories = ["LOGDIR", "PICDIR", "VIEWDIR", "SNDDIR"];
  const required = new Set([...directories, "WORDS.TOK", "OBJECT", "VOL.0", ...requiredFiles]);
  for (const name of directories) {
    if (!existsSync(dir + name)) continue;
    const bytes = readFileSync(dir + name);
    for (let offset = 0; offset + 2 < bytes.length; offset += 3) {
      if (bytes[offset] === 255 && bytes[offset + 1] === 255 && bytes[offset + 2] === 255) continue;
      required.add(`VOL.${bytes[offset]! >> 4}`);
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
