/** Static validation of contributor-supplied AGI game folders. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIRECTORY_FILES,
  detectContainerFormat,
  openContainer,
} from "../src/container/container.ts";
import { disassembleLogic } from "../src/logic/disassembler.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { decodeInventoryFile, inventoryTableFits } from "../src/runtime/inventoryFile.ts";
import {
  detectProfile,
  detectVersionString,
  INTERPRETER_FILES,
  PROFILES,
  EQUIVALENT_BUILDS,
  type AgiProfile,
  type ProfileId,
} from "../src/runtime/profile.ts";
import { parseSound } from "../src/sound/sound.ts";
import { createPictureSurface, RESOURCE_KINDS, type ResourceKind } from "../src/types.ts";
import { parseView } from "../src/view/view.ts";

export interface FixtureIssue {
  category: "resource-error" | "unsupported-contract";
  kind: ResourceKind | "inventory" | "dictionary" | "file" | "profile";
  id?: number;
  message: string;
}

export interface FixtureAudit {
  name: string;
  profile: ProfileId | null;
  detectedVersion: string | null;
  counts: Record<ResourceKind, number>;
  issues: FixtureIssue[];
}

export interface LibraryAudit {
  schema: 1;
  scope: "static-resources";
  ok: boolean;
  games: FixtureAudit[];
}

const RESOURCE_FILE = /^(?:[A-Z0-9_]*DIR|[A-Z0-9_]*VOL\.\d+|WORDS\.TOK|OBJECT)$/;
const RESOURCE_DIRECTORY = /^[A-Z0-9_]*DIR$/i;
const DISK_IMAGE = /\.(?:img|ima)$/i;
function gameDirectories(library: string): string[] {
  return readdirSync(library, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() ||
        (entry.isSymbolicLink() &&
          statSync(join(library, entry.name), { throwIfNoEntry: false })?.isDirectory()),
    )
    .map((entry) => entry.name)
    .filter((name) =>
      readdirSync(join(library, name)).some(
        (file) => RESOURCE_DIRECTORY.test(file) || DISK_IMAGE.test(file),
      ),
    )
    .sort();
}

function validateInventory(payload: Uint8Array, profile: AgiProfile): void {
  const decoded = decodeInventoryFile(payload, profile);
  if (!inventoryTableFits(decoded)) throw new Error("Invalid OBJECT inventory table");
  const size = decoded[0]! | (decoded[1]! << 8);
  for (let offset = 3; offset < size + 3; offset += 3) {
    const start = 3 + (decoded[offset]! | (decoded[offset + 1]! << 8));
    if (start < size + 3 || decoded.indexOf(0, start) < start)
      throw new Error("Invalid OBJECT name offset or terminator");
  }
}

/** parseSound validates offsets, but accepts partial events for historical callers.
 * Audits additionally require each channel's complete terminating record. */
function validateSound(payload: Uint8Array): void {
  const sound = parseSound(payload);
  for (const channel of sound.channels) {
    const at = channel.channelIndex * 2;
    const offset = payload[at]! | (payload[at + 1]! << 8);
    const terminator = offset + channel.notes.length * 5;
    if (offset < 8 || payload[terminator] !== 255 || payload[terminator + 1] !== 255)
      throw new Error(
        `Invalid sound channel ${channel.channelIndex}: missing in-bounds terminator`,
      );
  }
}

function auditGame(library: string, name: string): FixtureAudit {
  const report: FixtureAudit = {
    name,
    profile: null,
    detectedVersion: null,
    counts: { logic: 0, picture: 0, view: 0, sound: 0 },
    issues: [],
  };
  function check(kind: FixtureIssue["kind"], operation: () => void, id?: number): void {
    try {
      operation();
    } catch (error) {
      report.issues.push({
        category: "resource-error",
        kind,
        ...(id === undefined ? {} : { id }),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  check("file", () => {
    const entries = readdirSync(join(library, name), { withFileTypes: true });
    if (
      !entries.some((entry) => RESOURCE_DIRECTORY.test(entry.name)) &&
      entries.some((entry) => DISK_IMAGE.test(entry.name))
    ) {
      report.issues.push({
        category: "unsupported-contract",
        kind: "file",
        message:
          "Disk images are not supported by the resource-file loader; provide extracted AGI resource files from a supported interpreter format.",
      });
      return;
    }
    const files = new Map<string, Uint8Array>();
    for (const entry of entries) {
      const canonical = entry.name.toUpperCase();
      if (
        !RESOURCE_FILE.test(canonical) &&
        !INTERPRETER_FILES.includes(canonical) &&
        !/^[A-Z0-9_-]+\.COM$/.test(canonical)
      )
        continue;
      if (files.has(canonical))
        throw new Error(`Ambiguous case-insensitive resource: ${canonical}`);
      files.set(canonical, readFileSync(join(library, name, entry.name)));
    }
    const profile = detectProfile(files);
    report.profile = profile.id;
    report.detectedVersion = detectVersionString(files);
    if (
      report.detectedVersion !== null &&
      !Object.hasOwn(PROFILES, report.detectedVersion) &&
      EQUIVALENT_BUILDS[report.detectedVersion] !== profile.id
    )
      report.issues.push({
        category: "unsupported-contract",
        kind: "profile",
        message: `Unrecognized interpreter version ${report.detectedVersion}; engine falls back to ${profile.id}`,
      });
    const format = detectContainerFormat(files);
    if (format.kind !== profile.container)
      report.issues.push({
        category: "unsupported-contract",
        kind: "profile",
        message: `Selected profile ${profile.id} expects ${profile.container}, found ${format.kind}`,
      });
    for (const required of [
      ...(format.kind === "v3-combined" && files.has(`${format.prefix}DIR`)
        ? [`${format.prefix}DIR`]
        : Object.values(DIRECTORY_FILES)),
      "WORDS.TOK",
      "OBJECT",
    ]) {
      if (!files.has(required))
        report.issues.push({
          category: "resource-error",
          kind: "file",
          message: `Missing ${required}`,
        });
    }
    const container = openContainer(files);
    const dictionary = new Map<string, number>();
    const words = files.get("WORDS.TOK");
    if (words)
      check("dictionary", () => {
        for (const entry of parseWordsTok(words)) dictionary.set(entry.word, entry.id);
      });
    const inventory = files.get("OBJECT");
    if (inventory) check("inventory", () => validateInventory(inventory, profile));
    let hasBootLogic = false;
    for (const kind of RESOURCE_KINDS) {
      for (let id = 0; id < 256; id++)
        check(
          kind,
          () => {
            const bytes = container.getResource(kind, id);
            if (!bytes) return;
            report.counts[kind]++;
            if (kind === "logic") {
              if (id === 0) hasBootLogic = true;
              const source = disassembleLogic(bytes, { dictionary, profile });
              for (const line of source.split("\n")) {
                if (!line.trimStart().startsWith("// !!")) continue;
                report.issues.push({
                  // Reconstruction limitations do not alone establish malformed bytes.
                  category: "unsupported-contract",
                  kind,
                  id,
                  message: line.trim().slice(6).trim(),
                });
              }
            } else if (kind === "picture")
              renderPicture(bytes, createPictureSurface(), { profile });
            else if (kind === "view") parseView(bytes, profile);
            else validateSound(bytes);
          },
          id,
        );
    }
    if (!hasBootLogic && !report.issues.some((issue) => issue.kind === "logic" && issue.id === 0))
      report.issues.push({
        category: "resource-error",
        kind: "logic",
        id: 0,
        message: "Missing boot logic 0",
      });
  });
  return report;
}

/** Inspect immediate AGI folders without executing game code or writing derived assets. */
export function auditFixtures(libraryDirectory: string): LibraryAudit {
  const names = gameDirectories(libraryDirectory);
  if (names.length === 0) throw new Error("No AGI game folders found in the library");
  const games = names.map((name) => auditGame(libraryDirectory, name));
  return {
    schema: 1,
    scope: "static-resources",
    ok: games.every((game) => game.issues.length === 0),
    games,
  };
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(canonicalPath(dirname(absolute)), relative(dirname(absolute), absolute));
}

export function runAuditCli(args: readonly string[]): number {
  const [library, output] = args;
  if (args.length !== 2 || !library || !output)
    throw new Error("Usage: audit-fixtures.ts LIBRARY_DIR OUTPUT_JSON");
  const destination = canonicalPath(output);
  for (const name of gameDirectories(library)) {
    const path = relative(realpathSync(join(library, name)), destination);
    if (path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)))
      throw new Error("Audit output must not be inside a fixture");
  }
  const report = auditFixtures(library);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      ok: report.ok,
      games: report.games.length,
      issues: report.games.reduce((count, game) => count + game.issues.length, 0),
    }),
  );
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runAuditCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
