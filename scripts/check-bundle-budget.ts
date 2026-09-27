// Bundle budget for the Play boot path: the JavaScript, CSS and worker scripts
// a browser fetches before a game's first frame, compressed as a host serves
// them. It reads the chunk graph that app/vite.config.ts records beside the
// production build, so no file name is hard-coded, and fails when a budget is
// exceeded or when a Studio module has become part of the boot path.
//
//   npm run build && npm run check:bundle
//   npm run check:bundle -- --warn    report only; `npm run build` uses this
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

interface GraphChunk {
  readonly file: string;
  readonly isEntry: boolean;
  readonly imports: readonly string[];
  readonly css: readonly string[];
  /** Source modules, relative to the repository root. */
  readonly modules: readonly string[];
}

interface BundleGraph {
  readonly chunks: readonly GraphChunk[];
  readonly assets: readonly { readonly file: string }[];
}

interface Size {
  readonly raw: number;
  readonly gzip: number;
  readonly brotli: number;
}

type Group = "entry" | "js" | "css" | "workers";

/**
 * Budgets in bytes (gzip level 9, brotli quality 11). Each is the 1.1.0-rc.4
 * build's size, noted beside it, plus about 10% headroom, rounded. Raise one
 * only on purpose, saying in the commit what grew and why it must load before
 * the first frame; moving the code behind a dynamic import comes first.
 */
const BUDGETS: Record<Group, { readonly gzip: number; readonly brotli: number }> = {
  // The entry chunk alone: measured 702.8 kB gzip, 561.2 kB brotli.
  entry: { gzip: 775_000, brotli: 620_000 },
  // Entry plus every chunk it imports statically: 753.4 kB gzip, 606.4 kB brotli.
  js: { gzip: 830_000, brotli: 670_000 },
  // The stylesheets of those chunks: 15.0 kB gzip, 13.1 kB brotli.
  css: { gzip: 16_500, brotli: 14_500 },
  // Worker scripts those chunks start (the engine, catalog previews):
  // 144.5 kB gzip, 121.9 kB brotli.
  workers: { gzip: 160_000, brotli: 135_000 },
};

const GROUP_LABELS: Record<Group, string> = {
  entry: "entry chunk",
  js: "boot JavaScript",
  css: "boot CSS",
  workers: "boot workers",
};

/**
 * Studio code loads when Room Studio or Sprite Studio opens, never on the way
 * to a Play frame: the Studio components, the rules kernel and the walk-route
 * kernel with its worker. (The walkable mask, src/studio/walkable.ts, is
 * shared with click-to-walk navigation and legitimately boots with Play.)
 */
const STUDIO_MODULES = [/^app\/src\/studio\//, /^src\/studio\/rules\//, /^src\/studio\/route\.ts$/];
const STUDIO_WORKERS = [/(^|\/)route\.worker-[^/]*\.js$/];

const dist = join(import.meta.dirname, "..", "app", "dist");
const graphPath = join(dist, ".vite", "bundle-graph.json");
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

// Static imports only: a dynamic import() is by definition off the boot path.
const boot: GraphChunk[] = [];
const pending = [entry.file];
while (pending.length > 0) {
  const file = pending.pop()!;
  const chunk = byFile.get(file);
  if (!chunk || boot.includes(chunk)) continue;
  boot.push(chunk);
  pending.push(...chunk.imports);
}
const css = [...new Set(boot.flatMap((chunk) => chunk.css))];
const bootCode = boot.map((chunk) => readFileSync(join(dist, chunk.file), "latin1"));
// A worker is an emitted asset that a boot chunk names by URL.
const workers = graph.assets
  .map((asset) => asset.file)
  .filter((file) => file.endsWith(".js"))
  .filter((file) => bootCode.some((code) => code.includes(file.split("/").pop()!)));

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
const failures: string[] = [];

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
    console.log(`  ${file}  ${kB(size.raw)} raw, ${kB(size.gzip)} gzip, ${kB(size.brotli)} brotli`);
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
        `${module} is in the Play boot chunk ${chunk.file}; Studio code must load through a dynamic import.`,
      );
for (const worker of workers)
  if (STUDIO_WORKERS.some((pattern) => pattern.test(worker)))
    failures.push(
      `${worker} is started by a Play boot chunk; the Studio route worker must stay lazy.`,
    );

if (failures.length > 0) {
  console.error(`\nBundle budget ${warnOnly ? "warnings" : "failed"}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "Move the code behind a dynamic import, or raise the budget in scripts/check-bundle-budget.ts with the reason in the commit.",
  );
  if (!warnOnly) process.exit(1);
} else {
  console.log("\nBundle budget: Play boot path within budget; Studio stays lazy.");
}
