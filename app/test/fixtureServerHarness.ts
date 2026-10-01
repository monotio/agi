import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type InlineConfig, type ViteDevServer } from "vite";
import { fixtureServer } from "../vite.config.ts";
import { combinedDirectoryOf, type DiscoveredFixture } from "../../test/fixtures.ts";
import { detectKnownGameByHashes } from "../../src/games/knownGames.ts";

/**
 * Real-transport fixture harness: temporary on-disk game folders described by
 * the same record scanFixtures produces, served by the production
 * fixtureServer plugin inside a real Vite dev server. Contributor games/ is
 * never touched — the plugin's discovery seam returns these records instead.
 */

export interface FixtureFiles {
  [name: string]: Uint8Array | string;
}

/** A fresh temporary parent for fixture folders; callers remove it in after(). */
export function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "agi-fixture-transport-"));
}

/**
 * Write a real game folder under `root` and describe it the way a scanFixtures
 * pass would: the on-disk name as `folder`, the actual file spellings keyed by
 * lowercase, content hashes over WORDS.TOK and OBJECT, and the catalog lookup
 * for the (WORDS.TOK, OBJECT) pair. `folder` can differ from the backing
 * directory name — the only portable way to model case-only siblings, which a
 * case-folding filesystem cannot hold side by side.
 */
export function writeFixture(
  root: string,
  backing: string,
  files: FixtureFiles,
  folder = backing,
): DiscoveredFixture {
  const dir = join(root, backing);
  mkdirSync(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof contents === "string" ? contents : Buffer.from(contents));
  }
  const names = new Map<string, string>();
  for (const actual of readdirSync(dir)) names.set(actual.toLowerCase(), actual);
  const hashOf = (key: string): string | undefined => {
    const actual = names.get(key);
    if (actual === undefined) return undefined;
    try {
      return createHash("sha256")
        .update(readFileSync(join(dir, actual)))
        .digest("hex");
    } catch {
      return undefined;
    }
  };
  const wordsSha256 = hashOf("words.tok");
  const objectSha256 = hashOf("object");
  const known = wordsSha256 ? detectKnownGameByHashes(wordsSha256, objectSha256) : null;
  return {
    folder,
    hash: wordsSha256 ?? folder,
    dir: `${dir}/`,
    files: names,
    combined: combinedDirectoryOf(names),
    known: known ?? null,
    title: folder,
    ...(wordsSha256 !== undefined ? { wordsSha256 } : {}),
    ...(objectSha256 !== undefined ? { objectSha256 } : {}),
  };
}

export interface RunningFixtureServer {
  readonly url: string;
  readonly port: number;
  readonly server: ViteDevServer;
  close(): Promise<void>;
}

/**
 * A real Vite dev server with the production fixture plugin and no config
 * file. `fixtures` is the installed-game discovery result the plugin serves —
 * the exact seam the dev server defaults to scanFixtures().all for.
 */
export async function startFixtureServer(
  fixtures: readonly DiscoveredFixture[] | (() => readonly DiscoveredFixture[]),
  config: InlineConfig = {},
): Promise<RunningFixtureServer> {
  const discover = typeof fixtures === "function" ? fixtures : () => fixtures;
  const plugins = [...(config.plugins ?? []), fixtureServer(discover)];
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "silent",
    ...config,
    plugins,
    server: { host: "127.0.0.1", port: 0, strictPort: true, ...config.server },
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    server,
    close: () => server.close(),
  };
}
