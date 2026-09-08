import { readFileSync } from "node:fs";
import { openContainer } from "../src/container/container.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { INTERPRETER_FILES } from "../src/runtime/profile.ts";
import {
  combinedDirectory,
  fixtureDir,
  fixtureFiles,
  fixtureSkip,
  type FixtureRequirements,
} from "./fixtures.ts";

/**
 * Shared loader for optional AGI game fixtures under games/<slug>/.
 * Used by compatibility tests and development tools.
 */
export interface GameFixture {
  container: ReturnType<typeof openContainer>;
  dict: ReadonlyMap<string, number>;
  /** The container files plus, when requested, the interpreter binaries. */
  files: ReadonlyMap<string, Uint8Array>;
}

export interface LoadGameOptions extends Pick<FixtureRequirements, "checkVolumes"> {
  /**
   * Also load AGIDATA.OVL / AGI so profile detection sees the installation's
   * interpreter version. Off by default: the KQ tests select profiles
   * explicitly and pin the container-shape fallback otherwise.
   */
  readonly interpreterFiles?: boolean;
}

export function loadGame(slug: string, options: LoadGameOptions = {}): GameFixture {
  const dir = fixtureDir(slug);
  const missing = fixtureSkip(slug, [], options);
  if (missing) throw new Error(missing);
  // One case-insensitive enumeration, keyed by the canonical names the
  // container and profile detection expect (LOGDIR, <PREFIX>VOL.0,
  // AGIDATA.OVL), including on case-sensitive filesystems.
  const onDisk = fixtureFiles(slug)!;
  const combined = combinedDirectory(slug);
  const prefix = combined?.prefix ?? "";
  const files = new Map<string, Uint8Array>();
  const load = (canonical: string): void => {
    const actual = onDisk.get(canonical.toLowerCase());
    if (actual) files.set(canonical, new Uint8Array(readFileSync(dir + actual)));
  };
  if (combined) load(combined.name.toUpperCase());
  else for (const name of ["LOGDIR", "PICDIR", "VIEWDIR", "SNDDIR"]) load(name);
  load("OBJECT");
  if (options.interpreterFiles) for (const name of INTERPRETER_FILES) load(name);
  for (const [key, actual] of onDisk) {
    const match = /^([a-z0-9_]*)vol\.(\d+)$/.exec(key);
    if (match && match[1] === prefix.toLowerCase())
      files.set(`${prefix}VOL.${match[2]!}`, new Uint8Array(readFileSync(dir + actual)));
  }
  const words = onDisk.get("words.tok")!; // fixtureSkip required WORDS.TOK
  const dict = new Map(parseWordsTok(readFileSync(dir + words)).map((e) => [e.word, e.id]));
  return { container: openContainer(files), dict, files };
}
