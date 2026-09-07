import { existsSync, readFileSync, readdirSync } from "node:fs";
import { openContainer } from "../src/container/container.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { INTERPRETER_FILES } from "../src/runtime/profile.ts";
import { combinedDirectory, fixtureDir, fixtureSkip } from "./fixtures.ts";

/**
 * Shared loader for the local, gitignored authentic Sierra fixtures
 * (games/kq1, games/kq2, games/kq3, a v3 demo installation). Never referenced
 * by shipped code.
 */
export interface GameFixture {
  container: ReturnType<typeof openContainer>;
  dict: ReadonlyMap<string, number>;
  /** The container files plus, when requested, the interpreter binaries. */
  files: ReadonlyMap<string, Uint8Array>;
}

export interface LoadGameOptions {
  /**
   * Also load AGIDATA.OVL / AGI so profile detection sees the installation's
   * interpreter version. Off by default: the KQ tests select profiles
   * explicitly and pin the container-shape fallback otherwise.
   */
  readonly interpreterFiles?: boolean;
}

export function loadGame(slug: string, options: LoadGameOptions = {}): GameFixture {
  const dir = fixtureDir(slug);
  const missing = fixtureSkip(slug);
  if (missing) throw new Error(missing);
  const combined = combinedDirectory(slug);
  const files = new Map<string, Uint8Array>();
  const directories = combined ? [combined.name] : ["LOGDIR", "PICDIR", "VIEWDIR", "SNDDIR"];
  const volume = new RegExp(`^${combined?.prefix ?? ""}VOL\\.\\d+$`);
  for (const name of [
    ...directories,
    "OBJECT",
    ...(options.interpreterFiles ? INTERPRETER_FILES : []),
  ]) {
    if (existsSync(dir + name)) files.set(name, new Uint8Array(readFileSync(dir + name)));
  }
  for (const f of readdirSync(dir)) {
    if (volume.test(f)) files.set(f, new Uint8Array(readFileSync(dir + f)));
  }
  const dict = new Map(parseWordsTok(readFileSync(dir + "WORDS.TOK")).map((e) => [e.word, e.id]));
  return { container: openContainer(files), dict, files };
}
