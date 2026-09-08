/** Static references for contributor-supplied AGI resources; indexes do not
 * prove reachability or live collision state. */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openContainer,
  DIRECTORY_FILES,
  detectContainerFormat,
} from "../src/container/container.ts";
import { disassembleLogic } from "../src/logic/disassembler.ts";
import { parseLogicResource } from "../src/logic/resource.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { parseView } from "../src/view/view.ts";
import { createPictureSurface, RESOURCE_KINDS } from "../src/types.ts";
import { detectProfile, INTERPRETER_FILES } from "../src/runtime/profile.ts";
import { decodeInventoryFile, inventoryTableFits } from "../src/runtime/inventoryFile.ts";
import { pictureComparisonPng, PICTURE_COMPARISON_LEGEND } from "../src/agent/pictureFeedback.ts";

const HOOKS: Readonly<Record<string, RegExp>> = {
  commands: /said\(/,
  transitions: /new\.room(?:\.v)?\(|call(?:\.v)?\(/,
  geometry:
    /posn\(|obj\.in\.box\(|center\.posn\(|right\.posn\(|distance\(|set\.horizon\(|block\(|ignore\.(blocks|objs|horizon)\(|observe\.(blocks|objs|horizon)\(|position(?:\.v)?\(|move\.obj(?:\.v)?\(/,
  "inventory-hooks": /\b(?:get|get\.v|drop|put|put\.v|has|obj\.in\.room)\(/,
  score: /\bv3\b/,
  "pictures-hooks": /(?:load|draw|overlay)\.pic\(|add\.to\.pic/,
  prompts: /get\.(string|num)\(|parse\(|set\.string\(/,
};
const CATEGORIES = [
  ...Object.keys(HOOKS),
  "inventory",
  "dictionary",
  "logics",
  "pictures",
  "views",
  "problems",
];
const USAGE =
  "Usage: walkthrough-reference.ts prepare GAME_DIR OUTPUT_DIR | query OUTPUT_DIR CATEGORY [TERM] | render OUTPUT_DIR PICTURE_ID";
interface Manifest {
  schema: 1;
  digest: string;
  generation: string;
  profile: string;
  counts: Record<string, number>;
}
interface Problem {
  kind: string;
  id?: number;
  error: string;
}
interface Hook {
  logic: number;
  line: number;
  text: string;
}

/** Hash relative source names and content, independent of installation location. */
export function fingerprintReference(
  files: ReadonlyMap<string, Uint8Array>,
  sources: ReadonlyMap<string, string>,
): string {
  const hash = createHash("sha256");
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify(["fixture", name, bytes.length])).update(bytes);
  }
  for (const [name, source] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify(["source", name, source]));
  }
  return hash.digest("hex");
}

function sourcesForFingerprint(): Map<string, string> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const sources = new Map([
    ["scripts/walkthrough-reference.ts", readFileSync(fileURLToPath(import.meta.url), "utf8")],
  ]);
  function visit(directory: string): void {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const name = join(directory, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && entry.name.endsWith(".ts"))
        sources.set(name.split(sep).join("/"), readFileSync(join(root, name), "utf8"));
    }
  }
  visit("src");
  return sources;
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(canonicalPath(dirname(absolute)), basename(absolute));
}

function overlaps(a: string, b: string): boolean {
  const path = relative(a, b);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function readManifest(output: string): Manifest {
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")) as Manifest;
  if (
    manifest.schema !== 1 ||
    !/^reference-[A-Za-z0-9]+$/.test(manifest.generation) ||
    !/^[a-f0-9]{64}$/.test(manifest.digest)
  )
    throw new Error("Unsupported reference manifest");
  if (!lstatSync(join(output, manifest.generation)).isDirectory())
    throw new Error("Invalid reference generation");
  return manifest;
}

/** Prepare a fresh isolated generation; existing generations and user files are
 * retained. Only the manifest pointer is replaced after preparation completes. */
export function prepareReference(
  gameDirectory: string,
  outputDirectory: string,
): Manifest & { cached: boolean } {
  const game = canonicalPath(gameDirectory);
  const output = canonicalPath(outputDirectory);
  if (overlaps(game, output) || overlaps(output, game))
    throw new Error("Input and output paths overlap");
  const names = readdirSync(game, { withFileTypes: true });
  const files = new Map<string, Uint8Array>();
  for (const entry of names) {
    const name = entry.name.toUpperCase();
    const supported =
      /^(?:[A-Z0-9_]*DIR|[A-Z0-9_]*VOL\.\d+|WORDS\.TOK|OBJECT)$/.test(name) ||
      INTERPRETER_FILES.includes(name);
    if (!supported || !entry.isFile()) continue;
    if (files.has(name)) throw new Error(`Ambiguous case-insensitive resource: ${name}`);
    files.set(name, readFileSync(join(game, entry.name)));
  }
  if (![...files.keys()].some((name) => name.endsWith("DIR")))
    throw new Error("No supported AGI resource directory found");
  const digest = fingerprintReference(files, sourcesForFingerprint());
  if (existsSync(join(output, "manifest.json"))) {
    const previous = readManifest(output);
    if (previous.digest === digest) return { ...previous, cached: true };
  }
  const profile = detectProfile(files);
  const format = detectContainerFormat(files);
  const problems: Problem[] = [];
  for (const name of [
    ...(format.kind === "v3-combined" ? [`${format.prefix}DIR`] : Object.values(DIRECTORY_FILES)),
    "WORDS.TOK",
    "OBJECT",
    `${format.prefix}VOL.0`,
  ]) {
    if (!files.has(name)) problems.push({ kind: "file", error: `Missing ${name}` });
  }
  const container = openContainer(files);
  const dictionary = new Map<string, number>();
  try {
    const words = files.get("WORDS.TOK");
    if (words) for (const entry of parseWordsTok(words)) dictionary.set(entry.word, entry.id);
  } catch (error) {
    problems.push({ kind: "dictionary", error: String(error) });
  }
  mkdirSync(output, { recursive: true });
  const generation = mkdtempSync(join(output, "reference-"));
  for (const name of ["logic", "context", "maps"]) mkdirSync(join(generation, name));
  function json(name: string, value: unknown): void {
    writeFileSync(join(generation, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
  }
  const index: Record<string, Hook[]> = Object.fromEntries(
    Object.keys(HOOKS).map((name) => [name, []]),
  );
  const logics: unknown[] = [],
    pictures: unknown[] = [],
    views: unknown[] = [];
  for (let id = 0; id < 256; id++) {
    const stem = String(id).padStart(3, "0");
    for (const kind of RESOURCE_KINDS) {
      try {
        const bytes = container.getResource(kind, id);
        if (!bytes) continue;
        if (kind === "logic") {
          const source = disassembleLogic(bytes, { dictionary, profile });
          const lines = source.split("\n");
          const hooks: Record<string, Hook[]> = Object.fromEntries(
            Object.keys(HOOKS).map((name) => [name, []]),
          );
          for (const [line, text] of lines.entries())
            for (const [name, pattern] of Object.entries(HOOKS)) {
              // Message declarations and comments are data, not executable hooks.
              if (
                !text.trimStart().startsWith("#") &&
                !text.trimStart().startsWith("//") &&
                pattern.test(text)
              ) {
                const hook = { logic: id, line: line + 1, text: text.trim() };
                hooks[name]!.push(hook);
                index[name]!.push(hook);
              }
            }
          writeFileSync(join(generation, "logic", `${stem}.agi`), source);
          json(`context/${stem}`, {
            logic: id,
            source: `logic/${stem}.agi`,
            messages: parseLogicResource(bytes).messages,
            hooks,
          });
          logics.push({ id, bytes: bytes.length, lines: lines.length });
          if (source.includes("// !!"))
            problems.push({ kind, id, error: "Disassembler warning: inspect source" });
        } else if (kind === "picture") {
          const surface = createPictureSurface();
          renderPicture(bytes, surface, { profile });
          writeFileSync(join(generation, "maps", `${stem}.visual.bin`), surface.visual);
          writeFileSync(join(generation, "maps", `${stem}.priority.bin`), surface.priority);
          const rows = [
            "160x168 static picture controls: #=0 barrier, b=1 conditional barrier, t=2 trigger, ~=3 water, .=4..15. Excludes live overlays and actors.",
          ];
          for (let y = 0; y < 168; y++)
            rows.push(
              `${String(y).padStart(3)} ${Array.from(surface.priority.subarray(y * 160, (y + 1) * 160), (value) => ["#", "b", "t", "~"][value] ?? ".").join("")}`,
            );
          writeFileSync(join(generation, "maps", `${stem}.txt`), rows.join("\n") + "\n");
          pictures.push({
            id,
            bytes: bytes.length,
            controls: Array.from(
              { length: 4 },
              (_, color) => surface.priority.filter((value) => value === color).length,
            ),
          });
        } else if (kind === "view") {
          const view = parseView(bytes, profile);
          views.push({
            id,
            loops: view.loops.map((loop) =>
              loop.cels.map((cel) => ({ width: cel.width, height: cel.height })),
            ),
          });
        }
      } catch (error) {
        problems.push({ kind, id, error: String(error) });
      }
    }
  }
  const inventory: { id: number; name: string; room: number }[] = [];
  try {
    const object = files.get("OBJECT");
    if (object) {
      const decoded = decodeInventoryFile(object, profile);
      if (!inventoryTableFits(decoded)) throw new Error("Invalid OBJECT inventory table");
      const size = decoded[0]! | (decoded[1]! << 8);
      for (let offset = 3; offset < size + 3; offset += 3) {
        const start = 3 + (decoded[offset]! | (decoded[offset + 1]! << 8));
        const end = decoded.indexOf(0, start);
        if (start < size + 3 || end < start)
          throw new Error("Invalid OBJECT name offset or terminator");
        inventory.push({
          id: (offset - 3) / 3,
          name: String.fromCharCode(...decoded.subarray(start, end)),
          room: decoded[offset + 2]!,
        });
      }
    }
  } catch (error) {
    problems.push({ kind: "inventory", error: String(error) });
  }
  const words: Record<string, string[]> = {};
  for (const [word, id] of dictionary) (words[String(id)] ??= []).push(word);
  for (const [name, entries] of Object.entries(index)) json(name, entries);
  for (const [name, entries] of Object.entries({
    logics,
    pictures,
    views,
    inventory,
    dictionary: words,
    problems,
  }))
    json(name, entries);
  const manifest: Manifest = {
    schema: 1,
    digest,
    generation: basename(generation),
    profile: profile.id,
    counts: {
      logics: logics.length,
      pictures: pictures.length,
      views: views.length,
      problems: problems.length,
    },
  };
  json("manifest", manifest);
  renameSync(join(generation, "manifest.json"), join(output, "manifest.json"));
  return { ...manifest, cached: false };
}

/** Literal case-insensitive search, capped at 30 entries and 1,500 characters per entry. */
export function queryReference(
  output: string,
  category: string,
  term = "",
): { matches: number; shown: number; hits: unknown[] } {
  if (!CATEGORIES.includes(category))
    throw new Error(`Unknown category; choose ${CATEGORIES.join(", ")}`);
  const manifest = readManifest(output);
  const data: unknown = JSON.parse(
    readFileSync(join(output, manifest.generation, `${category}.json`), "utf8"),
  );
  const entries: unknown[] = Array.isArray(data)
    ? data
    : Object.entries(data as Record<string, unknown>).map(([id, words]) => ({ id, words }));
  const matches = entries.filter((entry) =>
    JSON.stringify(entry).toLowerCase().includes(term.toLowerCase()),
  );
  const hits = matches.slice(0, 30).map((entry) => {
    const text = JSON.stringify(entry);
    return text.length > 1500 ? { truncated: true, preview: text.slice(0, 1500) } : entry;
  });
  return { matches: matches.length, shown: hits.length, hits };
}

/** Render only cached raw picture maps, with no game execution or provider calls. */
export function renderReference(output: string, pictureId: number): string {
  if (!Number.isInteger(pictureId) || pictureId < 0 || pictureId > 255)
    throw new Error("picture ID must be 0..255");
  const manifest = readManifest(output);
  const base = join(output, manifest.generation, "maps", String(pictureId).padStart(3, "0"));
  const visual = readFileSync(`${base}.visual.bin`),
    priority = readFileSync(`${base}.priority.bin`);
  if (
    visual.length !== 160 * 168 ||
    priority.length !== 160 * 168 ||
    visual.some((value) => value > 15) ||
    priority.some((value) => value > 15)
  )
    throw new Error("Invalid cached picture maps");
  const png = `${base}.png`;
  if (existsSync(png) && !lstatSync(png).isFile()) throw new Error("Invalid PNG output path");
  writeFileSync(png, pictureComparisonPng(visual, priority));
  return resolve(png);
}

export function runReferenceCli(args: readonly string[]): void {
  const [command, first, second, third] = args;
  if (command === "prepare" && args.length === 3 && first && second)
    console.log(JSON.stringify(prepareReference(first, second), null, 2));
  else if (command === "query" && (args.length === 3 || args.length === 4) && first && second)
    console.log(JSON.stringify(queryReference(first, second, third), null, 2));
  else if (command === "render" && args.length === 3 && first && second) {
    if (!/^\d{1,3}$/.test(second)) throw new Error("Invalid picture ID; expected 0..255");
    console.log(renderReference(first, Number(second)));
    console.log(PICTURE_COMPARISON_LEGEND);
  } else throw new Error(USAGE);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runReferenceCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
