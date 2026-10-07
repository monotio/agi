import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";
import { scanFixtures, type DiscoveredFixture } from "../test/fixtures.ts";
import { BUILTIN_GAME_BUILDERS } from "../test/game-fixture.ts";
import { KNOWN_GAMES } from "../src/games/knownGames.ts";
import { canonicalResourceName } from "../src/types.ts";
import {
  gameRevision,
  isPlayableFileName,
  readPublicMetadata,
} from "./src/project/gameMetadata.ts";
import { preferCatalogedEdition } from "./src/project/gameTypes.ts";
import type { GameIdentity } from "../src/gameIdentity.ts";
import type { ProfileId } from "../src/runtime/profile.ts";
import { BUNDLE_GRAPH_PATH } from "./bundle-graph.config.ts";
import {
  DEV_KEYS_PATH,
  devKeysFromEnv,
  isLoopbackRequest,
} from "./src/settings/devProviderKeys.ts";

export interface InstalledFixtureDescriptor {
  readonly folder: string;
  readonly hash?: string | undefined;
  readonly alias: string;
  readonly title: string;
  readonly author?: string | undefined;
  readonly wordsSha256?: string | undefined;
  readonly objectSha256?: string | undefined;
  readonly revision?: string | undefined;
  readonly walkthroughLabel?: string | undefined;
  /** The interpreter a GAME.JSON export declared; detection decides without one. */
  readonly profile?: ProfileId | undefined;
  /** A remix's declared immediate parent; absent on plain editions and originals. */
  readonly parent?: GameIdentity | undefined;
}

/**
 * Dev-only fixture server: autodiscovers installed games under ../games/.
 * A subfolder with AGI resource directories is served at
 * /fixtures/<folder>/<file> or /fixtures/<hash>/<file>.
 * GET /fixtures/ returns the installed games.
 * NEVER shipped: build output contains no fixture data.
 */
/** Revision of exactly the file set the client will fetch for a target. */
async function servedRevision(
  files: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>,
): Promise<string> {
  const served: Record<string, Uint8Array> = {};
  for (const [name, bytes] of files instanceof Map ? [...files] : Object.entries(files))
    if (isPlayableFileName(name)) served[canonicalResourceName(name)] = bytes;
  return gameRevision(served);
}

/**
 * The installed-game manifest for the scanned fixtures. A fixture's
 * supported GAME.JSON is read with the same public validator the Add
 * game/folder and ZIP import apply — an export's declared title, interpreter
 * and parent travel to the descriptor, and metadata the validator refuses
 * rejects the fixture rather than silently dropping the declaration.
 * PROJECT.JSON and its storage/history payloads are never imported here.
 *
 * Recognized-family detection (the WORDS.TOK + OBJECT pair) is context, not
 * equality: the catalog alias and title describe the fixture only when its
 * served bundle is the pinned exact edition — or when the recognized game
 * pins no revision at all, as with platform ports whose pair is the whole
 * recognition. A changed bundle keeps its folder spelling and its own
 * title instead of being renamed to the original edition.
 */
export async function describeInstalledFixtures(
  fixtures: readonly DiscoveredFixture[],
): Promise<InstalledFixtureDescriptor[]> {
  // A project export beside a plain edition of the same game keeps its
  // folder as alias, so the edition alone answers to the catalog alias.
  const shadowed = (fixture: DiscoveredFixture): boolean =>
    (fixture.files.has("project.json") || fixture.files.has("game.json")) &&
    fixtures.some(
      (other) =>
        other !== fixture &&
        other.wordsSha256 !== undefined &&
        other.wordsSha256 === fixture.wordsSha256 &&
        !other.files.has("project.json") &&
        !other.files.has("game.json"),
    );
  return Promise.all(
    fixtures.map(async (fixture) => {
      const known = shadowed(fixture) ? null : (fixture.known ?? null);
      const served: Record<string, Uint8Array> = {};
      for (const actual of fixture.files.values())
        if (isPlayableFileName(actual))
          served[canonicalResourceName(actual)] = new Uint8Array(
            readFileSync(join(fixture.dir, actual)),
          );
      const revision = await gameRevision(served);
      let declared: ReturnType<typeof readPublicMetadata> | null = null;
      const gameJson = fixture.files.get("game.json");
      if (gameJson) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(join(fixture.dir, gameJson), "utf8"));
        } catch {
          throw new Error(
            `games/${fixture.folder}/GAME.JSON contains invalid JSON. Obtain a fresh copy of the game or correct its metadata.`,
          );
        }
        declared = readPublicMetadata(parsed);
      }
      const exactEdition =
        known !== null && (known.targetRevision === undefined || revision === known.targetRevision);
      // A scanned title that is only the family default (the recognized
      // game's own title) belongs to the exact edition; a changed bundle
      // falls back to its folder name rather than claiming it.
      const ownTitle = fixture.title !== known?.title ? fixture.title : fixture.folder;
      return {
        folder: fixture.folder,
        hash: fixture.hash,
        alias: exactEdition ? known.alias : fixture.folder,
        title: declared?.title ?? (exactEdition ? known.title : ownTitle),
        ...(fixture.author ? { author: fixture.author } : {}),
        ...(fixture.wordsSha256 ? { wordsSha256: fixture.wordsSha256 } : {}),
        ...(fixture.objectSha256 ? { objectSha256: fixture.objectSha256 } : {}),
        revision,
        ...(exactEdition && known.walkthroughLabel
          ? { walkthroughLabel: known.walkthroughLabel }
          : {}),
        ...(declared?.profile ? { profile: declared.profile } : {}),
        ...(declared?.metadata?.parent ? { parent: declared.metadata.parent } : {}),
      };
    }),
  );
}

/**
 * The fixture-server spelling resolution, shared with the client: an exact
 * folder spelling names the instance outright; a case-folded folder
 * spelling resolves only when one folder answers; hash, vocabulary, alias
 * and revision spellings resolve only when one instance answers, with the
 * catalogued exact edition preferred when revision evidence is available.
 * Returns the folder, an ambiguity refusal, or null when nothing matches.
 */
export function resolveFixtureFolder(
  games: readonly InstalledFixtureDescriptor[],
  query: string,
): { folder: string } | { ambiguous: string } | null {
  const exact = games.find((g) => g.folder === query);
  if (exact) return { folder: exact.folder };
  const norm = query.toLowerCase();
  const folded = games.filter((g) => g.folder.toLowerCase() === norm);
  if (folded.length === 1) return { folder: folded[0]!.folder };
  if (folded.length > 1) {
    return {
      ambiguous: `Ambiguous fixture query "${query}" matches multiple folders (${folded.map((m) => m.folder).join(", ")}); specify the fixture folder.`,
    };
  }
  const matches = games.filter(
    (g) =>
      g.hash?.toLowerCase() === norm ||
      g.wordsSha256?.toLowerCase() === norm ||
      g.revision?.toLowerCase() === norm ||
      g.alias?.toLowerCase() === norm,
  );
  if (matches.length === 1) return { folder: matches[0]!.folder };
  if (matches.length > 1) {
    const cataloged = preferCatalogedEdition(matches);
    if (cataloged) return { folder: cataloged.folder };
    return {
      ambiguous: `Ambiguous fixture query "${query}" matches multiple editions (${matches.map((m) => m.folder).join(", ")}); specify the fixture folder.`,
    };
  }
  return null;
}

/**
 * One installed entry: the public descriptor bound to the source that serves
 * it — a scanned fixture (its discovered directory and actual filename map)
 * or a builtin builder. The manifest serializes only the descriptors; paths
 * and builders never leave the process.
 */
interface InstalledEntry {
  readonly descriptor: InstalledFixtureDescriptor;
  readonly source:
    | { readonly kind: "physical"; readonly fixture: DiscoveredFixture }
    | { readonly kind: "builtin"; readonly build: () => { files: Record<string, Uint8Array> } };
}

export function fixtureServer(
  discover: () => readonly DiscoveredFixture[] = () => scanFixtures().all,
): Plugin {
  const installedEntries = async (): Promise<InstalledEntry[]> => {
    const fixtures = discover();
    const descriptors = await describeInstalledFixtures(fixtures);
    const entries: InstalledEntry[] = fixtures.map((fixture, index) => ({
      descriptor: descriptors[index]!,
      source: { kind: "physical", fixture },
    }));
    for (const known of KNOWN_GAMES) {
      if (!known.builtin) continue;
      const build = BUILTIN_GAME_BUILDERS[known.alias];
      if (!build) continue;
      // One transport key names exactly one source: a physical folder spelled
      // exactly the builtin's key owns it. Shared vocabulary, alias, revision
      // or a case-folded spelling never suppress the virtual entry — those
      // stay separately addressable through their own folder keys.
      if (entries.some((entry) => entry.descriptor.folder === known.alias)) continue;
      entries.push({
        descriptor: {
          folder: known.alias,
          hash: known.wordsSha256,
          alias: known.alias,
          title: known.title,
          author: known.author,
          revision: await servedRevision(build().files),
          ...(known.walkthroughLabel ? { walkthroughLabel: known.walkthroughLabel } : {}),
        },
        source: { kind: "builtin", build },
      });
    }
    return entries;
  };
  return {
    name: "agi-fixture-server",
    configureServer(server) {
      server.middlewares.use("/fixtures", (req, res, next) => {
        void (async () => {
          const forbidden = (): void => {
            res.statusCode = 403;
            res.end("forbidden");
          };
          const pathname = (req.url ?? "").split("?")[0]!.replace(/^\//, "");
          if (pathname === "") {
            // Installed-game picker manifest.
            const entries = await installedEntries();
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(entries.map((entry) => entry.descriptor)));
            return;
          }
          // One target, at most one filename. A single trailing slash is the
          // directory-manifest spelling; the segments are decoded exactly once
          // and case, spaces, Unicode normalization and literal percent, ? or
          // # survive untouched. A malformed escape, an empty or extra
          // segment, a dot segment, or a decoded separator or control
          // character refuses the request — it never reaches a path join.
          const segments = (pathname.endsWith("/") ? pathname.slice(0, -1) : pathname).split("/");
          if (segments.length > 2) {
            forbidden();
            return;
          }
          const decoded: string[] = [];
          for (const segment of segments) {
            let value: string;
            try {
              value = decodeURIComponent(segment);
            } catch {
              forbidden();
              return;
            }
            const hasControl = [...value].some((ch) => {
              const cp = ch.codePointAt(0)!;
              return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
            });
            if (
              value === "" ||
              value === "." ||
              value === ".." ||
              /[\\/]/.test(value) ||
              hasControl
            ) {
              forbidden();
              return;
            }
            decoded.push(value);
          }
          const [target, fileName] = decoded;
          const entries = await installedEntries();
          const resolved = resolveFixtureFolder(
            entries.map((entry) => entry.descriptor),
            target!,
          );
          if (resolved && "ambiguous" in resolved) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: resolved.ambiguous }));
            return;
          }
          const entry = resolved
            ? entries.find((candidate) => candidate.descriptor.folder === resolved.folder)
            : undefined;
          if (!entry) {
            res.statusCode = 404;
            res.end("not found");
            return;
          }
          if (entry.source.kind === "builtin") {
            const game = entry.source.build();
            if (fileName === undefined) {
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify(Object.keys(game.files).filter(isPlayableFileName)));
              return;
            }
            const bytes =
              isPlayableFileName(fileName) === false
                ? undefined
                : (game.files[fileName.toUpperCase()] ?? game.files[fileName]);
            if (bytes) {
              res.setHeader("content-type", "application/octet-stream");
              res.end(Buffer.from(bytes));
              return;
            }
          } else {
            const fixture = entry.source.fixture;
            if (fileName === undefined) {
              // Directory manifest: the discovered playable files under their
              // actual spellings; sidecars (GAME.JSON, TESTS.JSON, notes) are
              // descriptor input, never transport content.
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify([...fixture.files.values()].filter(isPlayableFileName)));
              return;
            }
            const actual = fixture.files.get(fileName.toLowerCase());
            if (actual !== undefined && isPlayableFileName(actual)) {
              res.setHeader("content-type", "application/octet-stream");
              res.end(readFileSync(join(fixture.dir, actual)));
              return;
            }
          }
          res.statusCode = 404;
          res.end("not found");
        })().catch(next);
      });
    },
  };
}

/**
 * Records the production chunk graph, with each chunk's source modules
 * relative to the repository root (which Vite's manifest omits), at
 * BUNDLE_GRAPH_PATH for scripts/check-bundle-budget.ts — outside the output
 * directory, so a deploy of `dist` never carries it. Each build removes the
 * previous graph before it starts, so one that fails leaves none behind
 * rather than a graph of an older build.
 *
 * Workers bundle in builds of their own whose emitted chunks the main
 * bundle only ever sees as opaque assets — so `worker.plugins` adds the
 * same recorder inside every worker build, keyed by the entry file the
 * startup code names. The budget then counts a startup worker's whole
 * static import closure, never just its entry: a lazily split feature's
 * shared Engine/core chunks are still initial download bytes.
 */
interface GraphChunk {
  file: string;
  isEntry: boolean;
  imports: readonly string[];
  dynamicImports: readonly string[];
  css: readonly string[];
  /** Source modules, relative to the repository root. */
  modules: readonly string[];
}

const repository = join(import.meta.dirname, "..");
const local = (id: string): string => relative(repository, id.split("?")[0]!).replaceAll("\\", "/");

/** Worker-bundle graphs keyed by each worker's emitted entry file. */
const workerGraphs = new Map<string, GraphChunk[]>();

/**
 * Opt-in development keys (src/settings/devProviderKeys.ts): with
 * AGI_DEV_KEYS=1, `vite serve` in development mode hands this machine the
 * provider keys from its environment. Absent from builds and test mode.
 */
function devProviderKeys(): Plugin {
  let enabled = false;
  return {
    name: "agi-dev-provider-keys",
    apply: "serve",
    configResolved(config) {
      enabled = config.mode === "development" && process.env["AGI_DEV_KEYS"] === "1";
    },
    configureServer(server) {
      if (!enabled) return;
      server.middlewares.use(DEV_KEYS_PATH, (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        if (
          req.method !== "GET" ||
          !isLoopbackRequest(req.socket.remoteAddress, req.headers.host)
        ) {
          res.statusCode = 403;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(devKeysFromEnv(process.env)));
      });
    },
  };
}

function workerBundleGraph(): Plugin {
  return {
    name: "agi-worker-bundle-graph",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks: GraphChunk[] = [];
      let entry: string | null = null;
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        chunks.push({
          file: output.fileName,
          isEntry: output.isEntry,
          imports: output.imports,
          dynamicImports: output.dynamicImports,
          css: [...(output.viteMetadata?.importedCss ?? [])],
          modules: output.moduleIds.map(local),
        });
        if (output.isEntry) entry = output.fileName;
      }
      if (entry !== null) workerGraphs.set(entry, chunks);
    },
  };
}

function bundleGraph(): Plugin {
  const chunks: GraphChunk[] = [];
  const assets: { file: string }[] = [];
  return {
    name: "agi-bundle-graph",
    apply: "build",
    buildStart() {
      rmSync(BUNDLE_GRAPH_PATH, { force: true });
      workerGraphs.clear();
      chunks.length = 0;
      assets.length = 0;
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          chunks.push({
            file: output.fileName,
            isEntry: output.isEntry,
            imports: output.imports,
            dynamicImports: output.dynamicImports,
            css: [...(output.viteMetadata?.importedCss ?? [])],
            modules: output.moduleIds.map(local),
          });
        } else {
          assets.push({ file: output.fileName });
        }
      }
    },
    // Written at closeBundle: the worker sub-bundles' own generateBundle —
    // which Vite drives lazily while the main bundle emits — has run by
    // then, so workerGraphs holds every worker's complete chunk graph.
    closeBundle() {
      mkdirSync(dirname(BUNDLE_GRAPH_PATH), { recursive: true });
      writeFileSync(
        BUNDLE_GRAPH_PATH,
        JSON.stringify({ chunks, assets, workers: Object.fromEntries(workerGraphs) }, null, 1),
      );
    },
  };
}

/**
 * Stamps `<meta name="agi-build">` into index.html: the commit SHA CI builds
 * (GITHUB_SHA), or `local` for any other build. scripts/verify-deploy.ts
 * compares it with the deployed commit. It holds nothing but the public commit
 * id, so one commit always builds the same page.
 */
function buildIdentity(): Plugin {
  const commit = process.env["GITHUB_SHA"];
  if (commit !== undefined && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit))
    throw new Error(`GITHUB_SHA is not a commit id: ${JSON.stringify(commit)}`);
  return {
    name: "agi-build-identity",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { name: "agi-build", content: commit ?? "local" }, injectTo: "head" },
    ],
  };
}

export default defineConfig({
  plugins: [vue(), fixtureServer(), devProviderKeys(), bundleGraph(), buildIdentity()],
  // Discover the lazy editor's dependencies before a browser connects. Finding
  // them on first Studio open otherwise makes Vite reload the authoring page.
  // This prebundles dependencies on the server; Play still loads no editor code.
  optimizeDeps: { entries: ["index.html", "src/studio/logic/monacoLanguage.ts"] },
  server: {
    // Serve engine modules, adventure templates and hoisted package assets.
    fs: {
      allow: [
        import.meta.dirname,
        join(import.meta.dirname, "../src"),
        join(import.meta.dirname, "../games"),
        join(import.meta.dirname, "../node_modules"),
      ],
    },
    proxy: {
      "/api/openai": {
        target: "https://api.openai.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/openai/, ""),
      },
      "/api/anthropic": {
        target: "https://api.anthropic.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/anthropic/, ""),
      },
    },
  },
  worker: {
    format: "es",
    plugins: () => [workerBundleGraph()],
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // A worker's entry chunk must stay a side-effect endpoint:
            // WebKit module workers re-evaluate the entry's chunk when a
            // lazily imported chunk statically imports it back (the worker's
            // main-script record is not reused as a module record), so the
            // entry's `self.onmessage` would rebind to a second context —
            // proven: engine.worker evaluated twice, later commands answered
            // by inert hooks (debugError notAttached). Every module on the
            // entry's static chain goes to `worker-shared` — side-effect
            // free, so a re-evaluation is harmless — while the `*.worker.ts`
            // entry file itself keeps its chunk (and its side effects) to
            // itself. check-bundle-budget asserts the endpoint property on
            // the emitted graph.
            {
              name: "worker-shared",
              tags: ["$initial"],
              test: (id: string) => !/\.worker\.ts$/.test(id),
            },
          ],
        },
      },
    },
  },
});
