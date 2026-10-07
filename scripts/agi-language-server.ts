#!/usr/bin/env -S node --experimental-strip-types
/** Stdio transport and file loading around the shared LOGIC LSP core. */
import {
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
  mkdirSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { InitializeResult } from "vscode-languageserver/node";
import {
  createConnection,
  ProposedFeatures,
  ResponseError,
  DidChangeWatchedFilesNotification,
} from "vscode-languageserver/node";
import { createLogicLspServer } from "../src/logic/lspServer.ts";
import type { LogicLanguageProject } from "../src/logic/lspServer.ts";
import { readProjectLanguageInput } from "../src/authoring/projectLanguageInput.ts";
import { readBindingsDocument } from "../src/authoring/projectDocuments.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { PROFILES, type AgiProfile, type ProfileId } from "../src/runtime/profile.ts";

const USAGE = `AGI LOGIC language server.

Usage:
  agi-language-server --stdio [--project PATH] [--sources DIR] [--profile ID] [--words WORDS.TOK]

Options:
  --stdio          Speak LSP over stdin/stdout.
  --project PATH   Exported project ZIP or AGI game directory (v2/v3).
  --sources DIR    LOGIC source folder; default: beside the ZIP or in the game directory.
  --profile ID     Standalone profile (default 2.936). Known: ${Object.keys(PROFILES).join(", ")}.
  --words PATH     Standalone WORDS.TOK dictionary.
  --extract-sources DIR  Write authored .lgc files and language inputs to a new folder, then exit.
  --help, -h       Print usage to stderr and exit.

Sources use logic.<number>.lgc (0..255) and language id agi-logic.
Project bindings.json and WORDS.TOK override archived inputs. Send
workspace/didChangeWatchedFiles after input changes to reload them.
`;

interface CliOptions {
  readonly stdio: boolean;
  readonly help: boolean;
  readonly profile: string;
  readonly words: string | undefined;
  readonly project: string | undefined;
  readonly sources: string | undefined;
  readonly extractSources: string | undefined;
}

function parseCli(args: string[]): CliOptions {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      stdio: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      profile: { type: "string", default: "2.936" },
      words: { type: "string" },
      project: { type: "string" },
      sources: { type: "string" },
      "extract-sources": { type: "string" },
      // Passed through to the SDK watchdog; some clients add it for every
      // spawned server.
      clientProcessId: { type: "string" },
    },
  });
  return {
    stdio: values.stdio === true,
    help: values.help === true,
    profile: values.profile as string,
    words: values.words,
    project: values.project,
    sources: values.sources,
    extractSources: values["extract-sources"],
  };
}

function loadDictionary(path: string | undefined): ReadonlyMap<string, number> {
  const dictionary = new Map<string, number>();
  if (path === undefined) return dictionary;
  const entries = parseWordsTok(new Uint8Array(readFileSync(path)));
  for (const entry of entries) dictionary.set(entry.word, entry.id);
  return dictionary;
}

async function readProject(path: string) {
  const { readGameZip, readGameFiles } = await import("../app/src/archive/gameZip.ts");
  const folder = statSync(path).isDirectory();
  const game = folder
    ? readGameFiles(
        new Map(
          readdirSync(path)
            .filter((name) => statSync(join(path, name)).isFile())
            .map((name) => [name, new Uint8Array(readFileSync(join(path, name)))]),
        ),
      )
    : await readGameZip(new Uint8Array(readFileSync(path)));
  return game;
}

async function loadProject(options: CliOptions) {
  if (!options.project) return undefined;
  // Editors send resolved file paths, so project URIs use them too.
  const path = realpathSync(resolve(options.project));
  const folder = statSync(path).isDirectory();
  const game = await readProject(path);
  const input = readProjectLanguageInput(game);
  const root = options.sources
    ? realpathSync(resolve(options.sources))
    : folder
      ? path
      : dirname(path);
  const wordsPath = join(root, "WORDS.TOK");
  if (statExists(wordsPath)) {
    input.dictionary.clear();
    for (const [word, id] of loadDictionary(wordsPath)) input.dictionary.set(word, id);
  }
  const objectPath = join(root, "OBJECT");
  let inventory = input.inventory;
  if (statExists(objectPath)) {
    const { readInventoryObjects } = await import("../src/authoring/inventory.ts");
    inventory = readInventoryObjects(new Uint8Array(readFileSync(objectPath)), input.profile);
    input.objects = inventory.map((item) => item.name);
  }
  const bindingPath = join(root, "bindings.json");
  if (statExists(bindingPath))
    input.bindings = readBindingsDocument(readFileSync(bindingPath, "utf8"));
  const documents: LogicLanguageProject["documents"] extends Readonly<infer T> ? T : never = {};
  for (const [key, source] of Object.entries(input.sources))
    documents[key] = { source, uri: pathToFileURL(join(root, `logic.${key.slice(6)}.lgc`)).href };
  for (const name of readdirSync(root)) {
    if (/^logic\.(0|[1-9]\d{0,2})\.lgc$/.test(name) && Number(name.split(".")[1]) <= 255)
      documents[`logic:${Number(name.split(".")[1])}`] = {
        uri: pathToFileURL(join(root, name)).href,
        source: readFileSync(join(root, name), "utf8"),
      };
  }
  return {
    profileId: input.profile.id,
    words: [...input.dictionary],
    objects: input.objects,
    ...(inventory
      ? {
          inventory,
          ...(statExists(objectPath)
            ? {
                inventoryDocument: {
                  uri: pathToFileURL(objectPath).href,
                  source: JSON.stringify(inventory, null, 2),
                },
              }
            : {}),
        }
      : {}),
    bindings: input.bindings,
    documents,
    ...(statExists(bindingPath)
      ? {
          bindingDocument: {
            uri: pathToFileURL(bindingPath).href,
            source: readFileSync(bindingPath, "utf8"),
          },
        }
      : {}),
  } satisfies LogicLanguageProject;
}

function statExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function serve(
  profile: AgiProfile,
  dictionary: ReadonlyMap<string, number>,
  options: CliOptions,
  initial: LogicLanguageProject | undefined,
): void {
  const connection = createConnection(ProposedFeatures.all);
  const version = (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;
  const standalone = () => ({
    profileId: profile.id,
    words: [...loadDictionary(options.words)],
    bindings: {},
    documents: {},
  });
  const uris = createUriSpelling();
  if (options.project) {
    const project = resolve(options.project);
    uris.folder(statSync(project).isDirectory() ? project : dirname(project));
  }
  if (options.sources) uris.folder(resolve(options.sources));
  const core = createLogicLspServer({
    version,
    project: initial ?? {
      profileId: profile.id,
      words: [...dictionary],
      bindings: {},
      documents: {},
    },
    publish: (message) => {
      void connection.sendNotification(message.method, uris.outgoing(message.params));
    },
  });
  let dynamicWatches = false;
  connection.onInitialize((params) => {
    dynamicWatches =
      params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    return core.handle({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: uris.incoming(params),
    })!.result as InitializeResult;
  });
  connection.onInitialized(() => {
    const paths = [options.project, options.words, options.sources].filter(
      (path): path is string => path !== undefined,
    );
    if (!dynamicWatches || !paths.length) return;
    const roots = [
      ...new Set(
        paths.map((path) =>
          statSync(path).isDirectory() ? realpathSync(path) : dirname(realpathSync(path)),
        ),
      ),
    ];
    void connection.client
      .register(DidChangeWatchedFilesNotification.type, {
        watchers: roots.map((root) => ({ globPattern: `${root.replaceAll("\\", "/")}/*` })),
      })
      .catch((error) =>
        connection.console.error(`Cannot register input watches: ${String(error)}`),
      );
  });
  connection.onRequest((method, params, token) => {
    const id = 1;
    if (token.isCancellationRequested)
      core.handle({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
    const response = core.handle({ jsonrpc: "2.0", id, method, params: uris.incoming(params) });
    if (response?.error) throw new ResponseError(response.error.code, response.error.message);
    return uris.outgoing(response?.result);
  });
  connection.onNotification((method, params) => {
    core.handle({ jsonrpc: "2.0", method, params: uris.incoming(params) });
  });
  connection.onDidChangeWatchedFiles(async () => {
    try {
      core.setProject((await loadProject(options)) ?? standalone());
    } catch (error) {
      connection.console.error(`Cannot reload project: ${String(error)}`);
    }
  });
  connection.listen();
}

/** Editors may name a file through a symlink; the core sees one resolved URI per file. */
function createUriSpelling() {
  const spelled = new Map<string, string>();
  const resolveUri = (uri: string): string => {
    if (!uri.startsWith("file:")) return uri;
    try {
      const path = fileURLToPath(uri);
      const real = pathToFileURL(join(realpathSync(dirname(path)), basename(path))).href;
      spelled.set(real, uri);
      return real;
    } catch {
      return uri;
    }
  };
  const map = (value: unknown, rename: (uri: string) => string): unknown => {
    if (Array.isArray(value)) return value.map((item) => map(item, rename));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        (key === "uri" || key === "targetUri") && typeof item === "string"
          ? rename(item)
          : key === "changes" && item !== null && typeof item === "object"
            ? Object.fromEntries(
                Object.entries(item).map(([uri, edits]) => [rename(uri), map(edits, rename)]),
              )
            : map(item, rename),
      ]),
    );
  };
  // Files the editor has not opened keep the folder spelling given on the command line.
  const folders: [string, string][] = [];
  const outgoing = (uri: string): string => {
    const known = spelled.get(uri);
    if (known) return known;
    const folder = folders.find(([real]) => uri.startsWith(real));
    return folder ? folder[1] + uri.slice(folder[0].length) : uri;
  };
  return {
    folder(given: string) {
      const real = `${pathToFileURL(realpathSync(given)).href}/`;
      const spelling = `${pathToFileURL(given).href}/`;
      if (real !== spelling) folders.push([real, spelling]);
    },
    incoming: <T>(value: T) => map(value, resolveUri) as T,
    outgoing: <T>(value: T) => map(value, outgoing) as T,
  };
}

async function cli(args: string[]): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCli(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stderr.write(USAGE);
    return;
  }
  if (options.extractSources) {
    if (!options.project) throw new Error("Choose --project before extracting sources.");
    const target = resolve(options.extractSources);
    if (existsSync(target))
      throw new Error("The source folder already exists. Choose a new folder.");
    const game = await readProject(resolve(options.project));
    const input = readProjectLanguageInput(game);
    const { buildWordsTok } = await import("../src/logic/words.ts");
    const { buildObjectFile } = await import("../src/authoring/inventory.ts");
    mkdirSync(target, { recursive: true });
    for (const [key, source] of Object.entries(input.sources))
      writeFileSync(join(target, `logic.${key.slice(6)}.lgc`), source, { flag: "wx" });
    writeFileSync(join(target, "bindings.json"), JSON.stringify(input.bindings, null, 2) + "\n", {
      flag: "wx",
    });
    writeFileSync(
      join(target, "WORDS.TOK"),
      buildWordsTok([...input.dictionary].map(([word, id]) => ({ word, id }))),
      { flag: "wx" },
    );
    writeFileSync(
      join(target, "OBJECT"),
      buildObjectFile(
        input.objects.map((name) => ({ name })),
        input.profile,
      ),
      { flag: "wx" },
    );
    process.stderr.write(`Extracted ${Object.keys(input.sources).length} LOGIC source(s).\n`);
    return;
  }
  if (!options.stdio) {
    process.stderr.write(`The --stdio transport is required.\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const profile = Object.hasOwn(PROFILES, options.profile)
    ? PROFILES[options.profile as ProfileId]
    : undefined;
  if (!profile) {
    process.stderr.write(
      `Unknown profile '${options.profile}'. Known: ${Object.keys(PROFILES).join(", ")}.\n`,
    );
    process.exitCode = 2;
    return;
  }
  let dictionary: ReadonlyMap<string, number>;
  try {
    dictionary = loadDictionary(options.words);
  } catch (error) {
    process.stderr.write(
      `Cannot load WORDS.TOK '${options.words}': ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  serve(profile, dictionary, options, await loadProject(options));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void cli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
