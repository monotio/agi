// Bundle budget for the startup path: the JavaScript, CSS and worker scripts
// a browser fetches from opening Home to a catalog game's first frame,
// compressed as a host serves them. That is the entry chunk's static import
// closure plus the dynamic imports Home starts unconditionally (HOME_START),
// each with its own static closure. It reads the chunk graph that
// app/vite.config.ts records beside the production build, so no file name is
// hard-coded, and fails when a budget is exceeded or when a Studio or AI
// authoring module has joined the startup path. Features that load on a
// player's action (Ask, the Studios, the map, lessons) stay outside it.
//
//   npm run build && npm run check:bundle
//   npm run check:bundle -- --warn    report only; `npm run build` uses this
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { BUNDLE_GRAPH_PATH } from "../app/bundle-graph.config.ts";

export interface GraphChunk {
  readonly file: string;
  readonly isEntry: boolean;
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
  readonly css: readonly string[];
  /** Source modules, relative to the repository root. */
  readonly modules: readonly string[];
}

export interface BundleGraph {
  readonly chunks: readonly GraphChunk[];
  readonly assets: readonly { readonly file: string }[];
  /**
   * Each emitted worker's own chunk graph — the main bundle sees a worker
   * only as an opaque asset, so its internal static imports are recorded
   * inside the worker's bundle build. Keyed by the worker's entry file.
   */
  readonly workers?: Readonly<Record<string, readonly GraphChunk[]>>;
}

/**
 * A worker bundle's startup closure: the entry chunk and every chunk it
 * statically imports, each exactly once — the bytes a browser fetches when
 * the worker starts. Dynamic imports (a lazy feature like the execution
 * debugger) are action-triggered and stay out. Follows the compiled
 * `imports` lists, not source syntax, so minified output counts correctly.
 */
export function workerStaticClosure(chunks: readonly GraphChunk[], entry: string): GraphChunk[] {
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
  // An incomplete record is a broken proof, not zero bytes: a graph that
  // lost the startup entry, or a chunk a static import names, is refused
  // rather than silently omitted from the measured total.
  if (!byFile.has(entry)) {
    throw new Error(
      `worker bundle graph has no record of entry ${entry}; its startup bytes cannot be measured`,
    );
  }
  const into: GraphChunk[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    const chunk = byFile.get(file);
    if (chunk === undefined) {
      throw new Error(
        `worker bundle graph lost ${file}, statically imported by the startup closure of ${entry}; its startup bytes cannot be measured`,
      );
    }
    if (into.includes(chunk)) continue;
    into.push(chunk);
    pending.push(...chunk.imports);
  }
  return into;
}

/**
 * A worker's entry chunk must stay a side-effect endpoint: WebKit module
 * workers re-evaluate the entry's chunk when a lazily loaded chunk imports
 * it back — the worker's main-script record is not reused as a module
 * record — and the second evaluation's `self.onmessage` rebinding steals
 * the wire (proven: engine.worker evaluated twice, subsequent commands
 * answered by the second context's inert hooks). Returns each entry file
 * statically reachable from a non-entry chunk, naming the first importer on
 * the path. Dynamic imports are action-triggered and do not count.
 */
export function workerEntryImportBacks(
  chunks: readonly GraphChunk[],
): readonly { entry: string; importer: string }[] {
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
  const entries = new Set(chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.file));
  const found = new Map<string, { entry: string; importer: string }>();
  for (const chunk of chunks) {
    if (chunk.isEntry) continue;
    const pending = chunk.imports.map((file) => ({ file, importer: chunk.file }));
    const seen = new Set<string>();
    while (pending.length > 0) {
      const { file, importer } = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (entries.has(file)) {
        found.set(`${file}${importer}`, { entry: file, importer });
        continue;
      }
      const dep = byFile.get(file);
      if (dep !== undefined) pending.push(...dep.imports.map((d) => ({ file: d, importer: file })));
    }
  }
  return [...found.values()];
}

interface Size {
  readonly raw: number;
  readonly gzip: number;
  readonly brotli: number;
}

type Group = "entry" | "js" | "css" | "workers";

/**
 * Budgets in bytes (gzip level 9, brotli quality 11). Each began as a measured
 * build's size plus about 10% headroom, rounded: the entry and startup
 * JavaScript after the AI authoring stack moved behind a dynamic import,
 * and the CSS from the 1.1.0-rc.4 build. Workers were re-measured for 1.2
 * with the smaller headroom recorded below. The startup JavaScript budget
 * kept its value when the Home-start tutorial build joined the measure.
 * Raise one only on purpose,
 * saying in the commit what grew and why it must load before the first frame;
 * moving the code behind a dynamic import comes first.
 */
const BUDGETS: Record<Group, { readonly gzip: number; readonly brotli: number }> = {
  // The entry chunk alone: measured 453.0 kB gzip, 367.3 kB brotli.
  entry: { gzip: 500_000, brotli: 405_000 },
  // The entry and HOME_START chunks with their static imports: measured
  // 556.5 kB gzip, 458.7 kB brotli (the entry's closure alone was 536.7 kB,
  // 441.8 kB).
  js: { gzip: 575_000, brotli: 472_000 },
  // The stylesheets of those chunks: 16.4 kB gzip, 14.3 kB brotli.
  css: { gzip: 16_500, brotli: 14_500 },
  // The 1.2 engine and catalog workers share Engine's synchronous native
  // preview staging. Debugging and source compilation load on demand.
  // Complete document admission retains encoder exports alongside the runtime
  // decoders in shared worker modules: 164.7 kB gzip, 138.3 kB brotli.
  // Version 3 timeline readers synchronously verify document hashes and bounded
  // workspaces before replay: 166.6 kB gzip, 139.9 kB brotli. Admission and its
  // compiler remain outside the startup closure.
  // Entering Create grants authority on the existing MAIN run without a reboot.
  // The message gate and frozen-run denial bring this closure to 166.9 kB gzip,
  // 140.0 kB brotli; the admission controller still loads on demand.
  workers: { gzip: 167_500, brotli: 140_500 },
};

const GROUP_LABELS: Record<Group, string> = {
  entry: "entry chunk",
  js: "startup JavaScript",
  css: "startup CSS",
  workers: "startup workers",
};

/**
 * Dynamic imports Home starts on every visit, named by a source module of the
 * chunk they load: the catalog warm-up (mountCatalog in
 * app/src/library/useGameLibrary.ts) builds the bundled tutorial for its
 * thumbnail, and Play reuses that build. A name no chunk dynamically imported
 * from the startup path carries fails the check, so the list cannot go stale.
 */
const HOME_START = ["games/adventure-department/game.ts"];

/**
 * Studio code loads when Room Studio or Sprite Studio opens, never on the way
 * to a Play frame: the Studio components and every Studio kernel, the walk-
 * route kernel with its worker among them. Helpers Play shares with the
 * Studios (the walkable mask, view usage, the sprite document) live outside
 * the studio folders, as `npm run lint:deps` enforces.
 */
const STUDIO_MODULES = [/^app\/src\/studio\//, /^src\/studio\//];
const STUDIO_WORKERS = [/(^|\/)route\.worker-[^/]*\.js$/];

/**
 * The execution debugger loads on the first debug/Test action through the
 * one dynamic import in app/src/worker/debugLoader.ts: the controller and
 * the breakpoint, step, watchpoint and expression machinery behind it. A
 * player who never opens the debugger or a test never downloads it — and a
 * startup worker that statically reaches any of them fails the check.
 */
const DEBUGGER_MODULES = [
  /^app\/src\/worker\/(debugController|previewAdmission|projectAdmission)\.ts$/,
  /^src\/runtime\/(debugExpression|debugBreakpoints|debugStep|debugWatchpoints)\.ts$/,
];

/**
 * The AI authoring stack loads on the first AI action, through the one
 * dynamic import in app/src/agent/authoringLoader.ts: its lazy entry, the
 * agent session and the stub agent, the LLM clients with the provider SDKs,
 * the tool registry and prompts, and the Studio edit and sprite kernels the
 * assist tools drive. A player who never uses AI never downloads it.
 */
const AUTHORING_MODULES = [
  /^app\/src\/agent\/(authoringStack|agentSession|llmClient|stubAgent|studioAssist|referenceStub)\.ts$/,
  /^app\/src\/references\/referenceHandles\.ts$/,
  /^src\/agent\/(tools|studioAssistTools|authoringTools|roomTools|pictureTools|referenceTools|prompt|playtest)\.ts$/,
  /^src\/studio\/(editOperations|editValidation|pictureDocument|probe|lensRules|assistScope)\.ts$/,
  /^src\/studio\/sprite\/(spriteOperations|spriteCels)\.ts$/,
  /^app\/node_modules\/(openai|@anthropic-ai\/sdk)\//,
];

function main(): void {
  const dist = join(import.meta.dirname, "..", "app", "dist");
  const graphPath = BUNDLE_GRAPH_PATH;
  const warnOnly = process.argv.includes("--warn");

  if (!existsSync(graphPath)) {
    console.error(
      `Bundle budget: ${graphPath} is missing. Run \`npm run build\` first; the graph is written by app/vite.config.ts.`,
    );
    process.exit(1);
  }
  const graph = JSON.parse(readFileSync(graphPath, "utf8")) as BundleGraph;
  const byFile = new Map(graph.chunks.map((chunk) => [chunk.file, chunk]));

  const entries = graph.chunks.filter((chunk) => chunk.isEntry);
  if (entries.length !== 1) {
    console.error(`Bundle budget: expected one entry chunk, found ${entries.length}.`);
    process.exit(1);
  }
  const entry = entries[0]!;

  // The entry and the Home-start chunks, each with its static imports. Every
  // other dynamic import() waits for a player's action and stays off the path.
  const staticClosure = (roots: readonly string[], into: GraphChunk[]): void => {
    const pending = [...roots];
    while (pending.length > 0) {
      const file = pending.pop()!;
      const chunk = byFile.get(file);
      if (!chunk || into.includes(chunk)) continue;
      into.push(chunk);
      pending.push(...chunk.imports);
    }
  };
  const boot: GraphChunk[] = [];
  staticClosure([entry.file], boot);
  const lazy = new Set(boot.flatMap((chunk) => chunk.dynamicImports));
  for (const module of HOME_START) {
    const chunk = graph.chunks.find(
      (candidate) => lazy.has(candidate.file) && candidate.modules.includes(module),
    );
    if (!chunk) {
      console.error(
        `Bundle budget: no chunk dynamically imported from the entry's static closure carries ${module}; update HOME_START.`,
      );
      process.exit(1);
    }
    staticClosure([chunk.file], boot);
  }
  const css = [...new Set(boot.flatMap((chunk) => chunk.css))];
  const bootCode = boot.map((chunk) => readFileSync(join(dist, chunk.file), "latin1"));
  // A worker is an emitted asset that a startup chunk names by URL.
  const workerEntries = graph.assets
    .map((asset) => asset.file)
    .filter((file) => file.endsWith(".js"))
    .filter((file) => bootCode.some((code) => code.includes(file.split("/").pop()!)));
  // Each startup worker counts its whole static import closure — a lazily
  // split feature's shared chunks are still initial download bytes. A
  // worker with no recorded graph fails rather than undercounting.
  const workerChunks: GraphChunk[] = [];
  const failures: string[] = [];
  for (const workerEntry of workerEntries) {
    const record = graph.workers?.[workerEntry];
    if (record === undefined) {
      failures.push(
        `${workerEntry} is started by a startup chunk but has no recorded worker chunk graph; its static imports cannot be counted. Rebuild so app/vite.config.ts's worker plugin records it.`,
      );
      continue;
    }
    try {
      for (const chunk of workerStaticClosure(record, workerEntry))
        if (!workerChunks.includes(chunk)) workerChunks.push(chunk);
    } catch (error) {
      failures.push(String(error instanceof Error ? error.message : error));
    }
  }
  // Every recorded worker bundle — not only startup ones — keeps its entry
  // a side-effect endpoint: a lazily split feature must never import the
  // entry chunk back.
  for (const record of Object.values(graph.workers ?? {})) {
    for (const back of workerEntryImportBacks(record)) {
      failures.push(
        `${back.entry} is statically imported back by ${back.importer}: WebKit module workers re-evaluate the entry chunk, and its side effects steal the wire. Keep worker entries side-effect endpoints (vite.config.ts worker-shared split).`,
      );
    }
  }
  const workers = workerChunks.map((chunk) => chunk.file);

  const sizes = new Map<string, Size>();
  function sizeOf(file: string): Size {
    const cached = sizes.get(file);
    if (cached) return cached;
    const bytes = readFileSync(join(dist, file));
    const size = {
      raw: bytes.length,
      gzip: gzipSync(bytes, { level: 9 }).length,
      brotli: brotliCompressSync(bytes).length,
    };
    sizes.set(file, size);
    return size;
  }

  const groups: Record<Group, readonly string[]> = {
    entry: [entry.file],
    js: boot.map((chunk) => chunk.file),
    css,
    workers,
  };

  const kB = (bytes: number): string => `${(bytes / 1000).toFixed(1)} kB`;

  for (const group of Object.keys(groups) as Group[]) {
    const files = [...groups[group]].sort((a, b) => sizeOf(b).gzip - sizeOf(a).gzip);
    const total = files.reduce(
      (sum, file) => ({
        raw: sum.raw + sizeOf(file).raw,
        gzip: sum.gzip + sizeOf(file).gzip,
        brotli: sum.brotli + sizeOf(file).brotli,
      }),
      { raw: 0, gzip: 0, brotli: 0 },
    );
    const budget = BUDGETS[group];
    console.log(
      `${GROUP_LABELS[group]}: ${kB(total.gzip)} gzip / ${kB(budget.gzip)}, ${kB(total.brotli)} brotli / ${kB(budget.brotli)}`,
    );
    for (const file of files) {
      const size = sizeOf(file);
      console.log(
        `  ${file}  ${kB(size.raw)} raw, ${kB(size.gzip)} gzip, ${kB(size.brotli)} brotli`,
      );
    }
    for (const encoding of ["gzip", "brotli"] as const) {
      if (total[encoding] <= budget[encoding]) continue;
      const largest = files[0]!;
      failures.push(
        `${GROUP_LABELS[group]} is ${kB(total[encoding])} ${encoding}, over its ${kB(budget[encoding])} budget` +
          (files.length > 1
            ? ` (largest: ${largest} at ${kB(sizeOf(largest)[encoding])})`
            : ` (${largest})`),
      );
    }
  }

  for (const chunk of boot)
    for (const module of chunk.modules)
      if (STUDIO_MODULES.some((pattern) => pattern.test(module)))
        failures.push(
          `${module} is in the startup chunk ${chunk.file}; Studio code must load through a dynamic import.`,
        );
  for (const chunk of boot)
    for (const module of new Set(chunk.modules))
      if (AUTHORING_MODULES.some((pattern) => pattern.test(module)))
        failures.push(
          `${module} is in the startup chunk ${chunk.file}; the AI authoring stack must load through app/src/agent/authoringLoader.ts.`,
        );
  for (const worker of workerEntries)
    if (STUDIO_WORKERS.some((pattern) => pattern.test(worker)))
      failures.push(
        `${worker} is started by a startup chunk; the Studio route worker must stay lazy.`,
      );
  for (const chunk of workerChunks)
    for (const module of chunk.modules)
      if (DEBUGGER_MODULES.some((pattern) => pattern.test(module)))
        failures.push(
          `${module} is in the startup closure of worker chunk ${chunk.file}; the execution debugger must load through app/src/worker/debugLoader.ts's dynamic import.`,
        );

  if (failures.length > 0) {
    console.error(`\nBundle budget ${warnOnly ? "warnings" : "failed"}:`);
    for (const failure of failures) console.error(`- ${failure}`);
    console.error(
      "Move the code behind a dynamic import, or raise the budget in scripts/check-bundle-budget.ts with the reason in the commit.",
    );
    if (!warnOnly) process.exit(1);
  } else {
    console.log(
      "\nBundle budget: startup path within budget; Studio and the AI authoring stack stay lazy.",
    );
  }
}

// Run only when invoked as the CLI; tests import the exported helpers.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
