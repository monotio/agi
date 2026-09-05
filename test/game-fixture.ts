import { existsSync, readFileSync, readdirSync } from "node:fs";
import { openContainer } from "../src/container/container.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { fixtureDir, fixtureSkip } from "./fixtures.ts";

/**
 * Shared loader for the local, gitignored authentic Sierra fixtures
 * (games/kq1, games/kq2, games/kq3). Never referenced by shipped code.
 */
export interface GameFixture {
  container: ReturnType<typeof openContainer>;
  dict: ReadonlyMap<string, number>;
}

export function loadGame(slug: string): GameFixture {
  const dir = fixtureDir(slug);
  const missing = fixtureSkip(slug);
  if (missing) throw new Error(missing);
  const files = new Map<string, Uint8Array>();
  for (const name of ["LOGDIR", "PICDIR", "VIEWDIR", "SNDDIR", "OBJECT"]) {
    if (existsSync(dir + name)) files.set(name, new Uint8Array(readFileSync(dir + name)));
  }
  for (const f of readdirSync(dir)) {
    if (/^VOL\.\d+$/.test(f)) files.set(f, new Uint8Array(readFileSync(dir + f)));
  }
  const dict = new Map(parseWordsTok(readFileSync(dir + "WORDS.TOK")).map((e) => [e.word, e.id]));
  return { container: openContainer(files), dict };
}
