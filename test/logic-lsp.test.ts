/**
 * Wire tests for the local logic language server: each case launches the real
 * CLI as a child process and talks to it through the official protocol client
 * SDK over the child's stdio pipes. Sources are synthetic and the dictionary
 * image is produced by the shared WORDS.TOK writer.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { test } from "node:test";
import {
  createProtocolConnection,
  CancellationTokenSource,
  CompletionRequest,
  DefinitionRequest,
  DiagnosticSeverity,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  MarkupKind,
  PositionEncodingKind,
  PrepareRenameRequest,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  RenameRequest,
  ShutdownRequest,
  SignatureHelpRequest,
  TextDocumentSyncKind,
  type CompletionItem,
  type Diagnostic,
  type Hover,
  type InitializeResult,
  type Location,
  type PrepareRenameResult,
  type ProtocolConnection,
  type PublishDiagnosticsParams,
  type SignatureHelp,
  type WorkspaceEdit,
} from "vscode-languageserver-protocol/node";
import { requireProjectId } from "../src/gameIdentity.ts";
import type { LspMessage, LspResponse, LspNotification, Range } from "../src/logic/lspTypes.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { buildTutorial } from "../games/adventure-department/game.ts";
import { buildProjectZip } from "../app/src/archive/projectArchive.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = fileURLToPath(new URL("../scripts/agi-language-server.ts", import.meta.url));
const LANGUAGE_ID = "agi-logic";

interface Running {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: ProtocolConnection;
  readonly diagnostics: PublishDiagnosticsParams[];
  readonly stderr: string[];
  readonly exited: Promise<number | null>;
}

function start(
  extraArgs: string[] = [],
  viaNpm = false,
  output?: (stdin: ChildProcessWithoutNullStreams["stdin"]) => NodeJS.WritableStream,
): Running {
  const [command, argv] = viaNpm
    ? ["npm", ["run", "--silent", "language-server", "--", "--stdio", ...extraArgs]]
    : [process.execPath, ["--experimental-strip-types", SERVER, "--stdio", ...extraArgs]];
  const child = spawn(command, argv, { cwd: ROOT }) as ChildProcessWithoutNullStreams;
  const stderr: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const connection = createProtocolConnection(
    child.stdout,
    output?.(child.stdin) ?? child.stdin,
    console,
  );
  const diagnostics: PublishDiagnosticsParams[] = [];
  connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
    diagnostics.push(params);
  });
  connection.listen();
  const exited = new Promise<number | null>((resolvePromise) => {
    child.once("exit", (code) => resolvePromise(code));
  });
  return { child, connection, diagnostics, stderr, exited };
}

async function initialize(server: Running): Promise<InitializeResult> {
  const request = server.connection.sendRequest(InitializeRequest.type, {
    processId: null,
    clientInfo: { name: "logic-lsp-wire-test" },
    rootUri: null,
    workspaceFolders: null,
    capabilities: {
      general: { positionEncodings: [PositionEncodingKind.UTF16] },
      textDocument: {
        publishDiagnostics: {},
        hover: { contentFormat: [MarkupKind.Markdown, MarkupKind.PlainText] },
        completion: { completionItem: {} },
        signatureHelp: {},
        rename: { prepareSupport: true },
      },
    },
  });
  const result = await Promise.race([
    request,
    server.exited.then((code) => {
      throw new Error(`server exited ${code}: ${server.stderr.join("")}`);
    }),
  ]);
  await server.connection.sendNotification(InitializedNotification.type, {});
  return result;
}

async function shutdown(server: Running): Promise<void> {
  if (server.child.exitCode !== null) {
    server.connection.dispose();
    return;
  }
  await server.connection.sendRequest(ShutdownRequest.type);
  await server.connection.sendNotification(ExitNotification.type);
  const code = await server.exited;
  assert.equal(code, 0, `server exited ${code}; stderr: ${server.stderr.join("")}`);
}

async function waitFor<T>(label: string, pick: () => T | undefined, server?: Running): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const hit = pick();
    if (hit !== undefined) return hit;
    if (server && server.child.exitCode !== null) {
      throw new Error(
        `server exited early (${server.child.exitCode}) waiting for ${label}; stderr: ${server.stderr.join("")}`,
      );
    }
    if (Date.now() > deadline) {
      const seen = server
        ? `; published: ${JSON.stringify(server.diagnostics)}; stderr: ${server.stderr.join("")}`
        : "";
      throw new Error(`timed out waiting for ${label}${seen}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function published(
  server: Running,
  uri: string,
  predicate: (params: PublishDiagnosticsParams) => boolean,
): PublishDiagnosticsParams | undefined {
  return server.diagnostics.find((params) => params.uri === uri && predicate(params));
}

async function open(server: Running, uri: string, text: string, version: number): Promise<void> {
  await server.connection.sendNotification(DidOpenTextDocumentNotification.type, {
    textDocument: { uri, languageId: LANGUAGE_ID, version, text },
  });
}

async function change(server: Running, uri: string, text: string, version: number): Promise<void> {
  await server.connection.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
}

async function close(server: Running, uri: string): Promise<void> {
  await server.connection.sendNotification(DidCloseTextDocumentNotification.type, {
    textDocument: { uri },
  });
}

const positionAt = (text: string, offset: number) => {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length - 1, character: before[before.length - 1]!.length };
};

const diagnosticMessage = (entry: Diagnostic): string =>
  typeof entry.message === "string" ? entry.message : entry.message.value;

test("numbered operands navigate across a two-LOGIC v2 project without becoming rename targets", async () => {
  const { createContainer } = await import("../src/container/container.ts");
  const { assembleLogic } = await import("../src/logic/assembler.ts");
  const { PROFILES } = await import("../src/runtime/profile.ts");
  const dir = mkdtempSync(join(tmpdir(), "agi-lsp-operands-"));
  const container = createContainer();
  const sources = [
    '#define local 0\n#message 12 "First"\ndraw.pic(v0); increment(local); increment(room_pic);\nset(f5); draw(o3); get(i7); set.string(s2, m12);\nif (said(w100) && controller(c4)) { print(m12); }\nset.key(0, 0, 4); assignn(v1, 0); new.room(0);\nprint("v0 f5"); // v0\nreturn;',
    '#define other 0\n#message 12 "Second"\nload.pic(v0); increment(other);\nreset(f5); erase(o3); drop(7); set.string(2, m12);\nif (said(100) && controller(4)) { print(m12); }\nreturn;',
  ];
  for (const num of [0, 1]) {
    container.putResource(
      "logic",
      num,
      assembleLogic("return;", {
        profile: PROFILES["2.936"],
        dictionary: new Map(),
      }).payload,
    );
    writeFileSync(join(dir, `logic.${num}.lgc`), sources[num]!);
  }
  for (const [name, bytes] of container.files) writeFileSync(join(dir, name), bytes);
  writeFileSync(join(dir, "AGIDATA.OVL"), "Version 2.936");
  writeFileSync(join(dir, "WORDS.TOK"), buildWordsTok([{ word: "look", id: 100 }]));
  writeFileSync(
    join(dir, "bindings.json"),
    JSON.stringify({ room_pic: { kind: "variable", num: 0 } }),
  );
  const server = start(["--project", dir]);
  const uri = pathToFileURL(join(dir, "logic.0.lgc")).href;
  const second = pathToFileURL(join(dir, "logic.1.lgc")).href;
  const source = sources[0]!;
  const at = (text: string) => ({
    textDocument: { uri },
    position: positionAt(source, source.indexOf(text)),
  });
  const refs = async (text: string, includeDeclaration = false) =>
    (await server.connection.sendRequest(ReferencesRequest.type, {
      ...at(text),
      context: { includeDeclaration },
    })) as Location[];
  try {
    await initialize(server);
    await open(server, uri, source, 1);
    const variables = await refs("v0");
    assert.equal(variables.length, 5);
    assert.deepEqual(new Set(variables.map((r) => r.uri)), new Set([uri, second]));
    assert.deepEqual(await refs("local);"), variables);
    assert.deepEqual(await refs("room_pic);"), variables);
    assert.equal((await refs("v0", true)).length, 8);
    for (const [operand, count] of [
      ["f5", 2],
      ["o3", 2],
      ["i7", 2],
      ["s2", 2],
      ["w100", 2],
      ["c4", 3],
    ] as const)
      assert.equal((await refs(operand)).length, count, operand);
    const messages = await refs("m12", true);
    assert.equal(messages.length, 3);
    assert.ok(messages.every((r) => r.uri === uri));
    const declaration = await server.connection.sendRequest(DefinitionRequest.type, at("m12"));
    assert.deepEqual(declaration, {
      uri,
      range: { start: { line: 1, character: 9 }, end: { line: 1, character: 11 } },
    });
    assert.deepEqual(await refs('12 "First"', true), messages);
    const binding = await server.connection.sendRequest(DefinitionRequest.type, at("v0"));
    assert.equal((binding as Location).uri, pathToFileURL(join(dir, "bindings.json")).href);
    assert.equal(await server.connection.sendRequest(DefinitionRequest.type, at("f5")), null);
    assert.deepEqual(await refs("0);\nprint"), []);
    const highlights = (await server.connection.sendRequest(
      "textDocument/documentHighlight",
      at("v0"),
    )) as { range: Range }[];
    assert.equal(highlights.length, 4);
    const hover = await server.connection.sendRequest(HoverRequest.type, at("v0"));
    assert.match(JSON.stringify(hover), /Variable 0/);
    assert.match(JSON.stringify(hover), /room_pic/);
    assert.match(JSON.stringify(hover), /local/);
    assert.match(JSON.stringify(hover), /5 uses/);
    await assert.rejects(
      server.connection.sendRequest(PrepareRenameRequest.type, at("v0")),
      /Numbered operands.*named binding/,
    );
    await assert.rejects(
      server.connection.sendRequest(RenameRequest.type, { ...at("v0"), newName: "picture" }),
      /Numbered operands/,
    );
    const renamed = await server.connection.sendRequest(RenameRequest.type, {
      ...at("local);"),
      newName: "scratch",
    });
    assert.equal(renamed?.documentChanges?.length, 1);
    assert.equal((renamed?.documentChanges?.[0] as { edits: unknown[] }).edits.length, 2);
    const shared = await server.connection.sendRequest(RenameRequest.type, {
      ...at("room_pic);"),
      newName: "picture",
    });
    assert.equal(shared?.documentChanges?.length, 2);
    const diagnostics = (await server.connection.sendRequest("textDocument/diagnostic", {
      textDocument: { uri },
    })) as { items: unknown[] };
    assert.deepEqual(diagnostics.items, []);
    await change(server, uri, source.replace("draw.pic(v0)", "draw.pic(v2)"), 2);
    assert.equal((await refs("room_pic);")).length, 4);
    await close(server, uri);
    assert.equal((await refs("room_pic);")).length, 5);
    // Browser snapshots can carry numeric bindings with their typed JSON document.
    const bindingUri = pathToFileURL(join(dir, "bindings.json")).href;
    await server.connection.sendNotification("workspace/didChangeConfiguration", {
      settings: {
        agiLogic: {
          project: {
            profileId: "2.936",
            words: [],
            bindings: { room_pic: { num: 0 }, unused: { num: 1 } },
            documents: { "logic:0": { uri, source } },
            bindingDocument: {
              uri: bindingUri,
              source: JSON.stringify({
                room_pic: { kind: "variable", num: 0 },
                unused: { kind: "variable", num: 1 },
              }),
            },
          },
        },
      },
    });
    const unused = await server.connection.sendRequest(DefinitionRequest.type, at("v1"));
    assert.equal((unused as Location | null)?.uri, bindingUri);
    assert.match(
      JSON.stringify(await server.connection.sendRequest(HoverRequest.type, at("v1"))),
      /unused/,
    );
  } finally {
    await shutdown(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a project reached through a symlink keeps one identity per LOGIC file", async () => {
  const { createContainer } = await import("../src/container/container.ts");
  const { assembleLogic } = await import("../src/logic/assembler.ts");
  const { PROFILES } = await import("../src/runtime/profile.ts");
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "agi-lsp-link-")));
  const dir = join(parent, "game");
  const link = join(parent, "linked");
  const container = createContainer();
  const sources = ["draw.pic(v0);\nreturn;", "load.pic(v0);\nreturn;"];
  mkdirSync(dir);
  for (const num of [0, 1]) {
    const payload = assembleLogic("return;", { profile: PROFILES["2.936"], dictionary: new Map() });
    container.putResource("logic", num, payload.payload);
    writeFileSync(join(dir, `logic.${num}.lgc`), sources[num]!);
  }
  for (const [name, bytes] of container.files) writeFileSync(join(dir, name), bytes);
  writeFileSync(join(dir, "AGIDATA.OVL"), "Version 2.936");
  writeFileSync(join(dir, "WORDS.TOK"), buildWordsTok([{ word: "look", id: 100 }]));
  symlinkSync(dir, link, "dir");
  // Editors report the resolved path of the file they open.
  const server = start(["--project", link, "--sources", link]);
  const uri = pathToFileURL(join(dir, "logic.0.lgc")).href;
  try {
    await initialize(server);
    await open(server, uri, sources[0]!, 1);
    const refs = (await server.connection.sendRequest(ReferencesRequest.type, {
      textDocument: { uri },
      position: positionAt(sources[0]!, sources[0]!.indexOf("v0")),
      context: { includeDeclaration: false },
    })) as Location[];
    assert.deepEqual(
      refs.map((r) => r.uri).sort(),
      // The open file keeps the editor's spelling; others keep the configured folder.
      [uri, pathToFileURL(join(link, "logic.1.lgc")).href].sort(),
    );
  } finally {
    await shutdown(server);
    rmSync(parent, { recursive: true, force: true });
  }
});

test("CLI reports usage on stderr for --help and rejects unknown profiles", () => {
  const help = spawnSync(process.execPath, ["--experimental-strip-types", SERVER, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.equal(help.stdout, "");
  assert.match(help.stderr, /--stdio/);
  assert.match(help.stderr, /--profile/);
  const bad = spawnSync(
    process.execPath,
    ["--experimental-strip-types", SERVER, "--stdio", "--profile", "9.999"],
    { encoding: "utf8" },
  );
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /profile/i);
  const missingWords = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      SERVER,
      "--stdio",
      "--words",
      join(mkdtempSync(join(tmpdir(), "agi-lsp-missing-")), "WORDS.TOK"),
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(missingWords.status, 0);
  assert.match(missingWords.stderr, /WORDS\.TOK/);
});

test("initialize advertises only the implemented capabilities over the npm entry point", async () => {
  const server = start([], true);
  try {
    const result = await initialize(server);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    assert.equal(result.serverInfo?.version, pkg.version);
    const capabilities = result.capabilities;
    assert.equal(capabilities.positionEncoding, PositionEncodingKind.UTF16);
    const sync = capabilities.textDocumentSync;
    assert.equal(typeof sync === "object" && sync !== null ? sync.openClose : false, true);
    assert.equal(
      typeof sync === "object" && sync !== null ? sync.change : sync,
      TextDocumentSyncKind.Incremental,
    );
    assert.ok(capabilities.completionProvider, "completion capability missing");
    assert.ok(
      capabilities.signatureHelpProvider?.triggerCharacters?.includes("("),
      "signature trigger '(' missing",
    );
    assert.equal(capabilities.hoverProvider, true);
    assert.equal(capabilities.definitionProvider, true);
    assert.equal(capabilities.referencesProvider, true);
    assert.equal(
      typeof capabilities.renameProvider === "object" && capabilities.renameProvider !== null
        ? capabilities.renameProvider.prepareProvider
        : false,
      true,
    );
    assert.equal(capabilities.documentFormattingProvider, undefined);
    assert.equal(capabilities.workspace, undefined);
  } finally {
    await shutdown(server);
  }
});

test("didOpen publishes versioned semantic diagnostics and full changes update them", async () => {
  const server = start();
  const uri = "file:///diagnostics.agilogic";
  try {
    await initialize(server);
    await open(server, uri, "not.a.command();\nreturn;", 1);
    const first = await waitFor(
      "diagnostics for version 1",
      () => published(server, uri, (p) => p.version === 1 && p.diagnostics.length > 0),
      server,
    );
    assert.ok(
      first.diagnostics.some(
        (entry: Diagnostic) =>
          entry.severity === DiagnosticSeverity.Error &&
          /unknown action/.test(diagnosticMessage(entry)),
      ),
    );
    assert.equal(first.diagnostics[0]!.range.start.line, 0);
    assert.equal(first.diagnostics[0]!.range.start.character, 0);

    await change(server, uri, "return;", 2);
    const cleared = await waitFor(
      "empty diagnostics for version 2",
      () => published(server, uri, (p) => p.version === 2 && p.diagnostics.length === 0),
      server,
    );
    assert.equal(cleared.version, 2);

    await change(server, uri, "bogus(1);\nreturn;", 3);
    const third = await waitFor(
      "diagnostics for version 3",
      () => published(server, uri, (p) => p.version === 3 && p.diagnostics.length > 0),
      server,
    );
    assert.match(diagnosticMessage(third.diagnostics[0]!), /unknown action/);
  } finally {
    await shutdown(server);
  }
});

test("incomplete said() call offers signature help and dictionary completions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agi-lsp-words-"));
  const wordsPath = join(dir, "WORDS.TOK");
  writeFileSync(
    wordsPath,
    buildWordsTok([
      { word: "door", id: 101 },
      { word: "open", id: 100 },
    ]),
  );
  const server = start(["--words", wordsPath]);
  try {
    const uri = "file:///said.agilogic";
    await initialize(server);
    const text = 'if (said("open", ';
    await open(server, uri, text, 1);
    await waitFor(
      "didOpen diagnostics",
      () => published(server, uri, (p) => p.version === 1),
      server,
    );
    const end = positionAt(text, text.length);

    const help = await server.connection.sendRequest(SignatureHelpRequest.type, {
      textDocument: { uri },
      position: end,
    });
    assert.equal((help as SignatureHelp | null)?.signatures[0]?.label, "said(word, ...)");
    assert.equal((help as SignatureHelp | null)?.activeParameter, 1);

    const items = (await server.connection.sendRequest(CompletionRequest.type, {
      textDocument: { uri },
      position: end,
    })) as CompletionItem[] | { items: CompletionItem[] } | null;
    const list = Array.isArray(items) ? items : (items?.items ?? []);
    const openWord = list.find((item) => item.label === "open");
    assert.ok(openWord, "dictionary word 'open' missing from completion");
    assert.match(openWord.detail ?? "", /100/);
    const edit = openWord.textEdit;
    assert.ok(edit && "range" in edit, "completion should carry a text edit");
    assert.equal(edit.newText, '"open"');
    assert.deepEqual(edit.range, { start: end, end });
    assert.ok(
      list.some((item) => item.label === "door"),
      "dictionary word 'door' missing",
    );
  } finally {
    await shutdown(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hover, local definition, references and prepareRename resolve shared tokens", async () => {
  const server = start();
  const uri = "file:///navigate.agilogic";
  try {
    await initialize(server);
    const text = '#define door 41\nset(door); print("door"); // door\nreturn;';
    await open(server, uri, text, 1);
    await waitFor(
      "didOpen diagnostics",
      () => published(server, uri, (p) => p.version === 1),
      server,
    );

    const use = text.indexOf("set(door") + 4;
    const hover = (await server.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: positionAt(text, use),
    })) as Hover | null;
    const contents = hover?.contents;
    const markup =
      contents && typeof contents === "object" && "kind" in contents ? contents.value : "";
    assert.match(markup, /#define door 41/);
    assert.deepEqual(hover?.range, {
      start: positionAt(text, use),
      end: positionAt(text, use + 4),
    });

    const definition = (await server.connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position: positionAt(text, use),
    })) as Location[] | Location | null;
    const target = Array.isArray(definition) ? definition[0] : definition;
    assert.equal(target?.uri, uri);
    assert.deepEqual(target?.range, {
      start: positionAt(text, 8),
      end: positionAt(text, 12),
    });

    const references = (await server.connection.sendRequest(ReferencesRequest.type, {
      textDocument: { uri },
      position: positionAt(text, use),
      context: { includeDeclaration: true },
    })) as Location[] | null;
    assert.equal(references?.length, 2);
    assert.ok(
      references!.every((location) => location.uri === uri),
      "references must stay inside the open document",
    );

    const prepared = (await server.connection.sendRequest(PrepareRenameRequest.type, {
      textDocument: { uri },
      position: positionAt(text, use),
    })) as PrepareRenameResult | null;
    assert.ok(prepared && "placeholder" in prepared, "prepareRename should return a placeholder");
    assert.equal(prepared.placeholder, "door");
    assert.deepEqual(prepared.range, {
      start: positionAt(text, use),
      end: positionAt(text, use + 4),
    });
  } finally {
    await shutdown(server);
  }
});

test("rename returns versioned edits for the open document without applying them", async () => {
  const server = start();
  const uri = "file:///rename.agilogic";
  try {
    await initialize(server);
    const text = "#define door 41\nset(door);\nreturn;";
    await open(server, uri, text, 7);
    await waitFor(
      "didOpen diagnostics",
      () => published(server, uri, (p) => p.version === 7),
      server,
    );
    const use = text.indexOf("set(door") + 4;
    const edit = (await server.connection.sendRequest(RenameRequest.type, {
      textDocument: { uri },
      position: positionAt(text, use),
      newName: "gate",
    })) as WorkspaceEdit | null;
    assert.ok(edit?.documentChanges, "rename should answer documentChanges");
    const changes = edit.documentChanges;
    assert.equal(changes.length, 1);
    const documentEdit = changes[0]!;
    assert.ok("textDocument" in documentEdit, "expected a document edit");
    assert.equal(documentEdit.textDocument.uri, uri);
    assert.equal(documentEdit.textDocument.version, 7);
    assert.equal(documentEdit.edits.length, 2);
    assert.ok(
      documentEdit.edits.every((entry) => "newText" in entry && entry.newText === "gate"),
      "every edit should insert the new name",
    );

    const again = (await server.connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position: positionAt(text, use),
    })) as Location[] | Location | null;
    const target = Array.isArray(again) ? again[0] : again;
    assert.deepEqual(
      target?.range,
      { start: positionAt(text, 8), end: positionAt(text, 12) },
      "rename must leave the open document untouched",
    );
    assert.equal(
      server.diagnostics.filter((p) => p.uri === uri).length,
      1,
      "rename should not republish diagnostics",
    );

    const conflict = await server.connection
      .sendRequest(RenameRequest.type, {
        textDocument: { uri },
        position: positionAt(text, use),
        newName: "f4",
      })
      .then(
        () => "resolved",
        (error: { code?: number }) => `rejected:${error.code ?? "?"}`,
      );
    assert.match(conflict, /^rejected:/);
  } finally {
    await shutdown(server);
  }
});

test("positions count UTF-16 code units across astral characters", async () => {
  const server = start();
  const uri = "file:///astral.agilogic";
  try {
    await initialize(server);
    const text = 'print("\u{1f600}") xyz();\nreturn;';
    await open(server, uri, text, 1);
    const params = await waitFor(
      "astral-line diagnostics",
      () => published(server, uri, (p) => p.version === 1 && p.diagnostics.length > 0),
      server,
    );
    const diagnostic = params.diagnostics.find((entry) =>
      /expected ;/.test(diagnosticMessage(entry)),
    )!;
    // 'print("😀") ' is 12 UTF-16 code units; the emoji contributes two.
    assert.deepEqual(diagnostic.range.start, { line: 0, character: 12 });
    assert.deepEqual(diagnostic.range.end, { line: 0, character: 15 });
  } finally {
    await shutdown(server);
  }
});

test("close clears diagnostics, stale versions are ignored, reopen restarts cleanly", async () => {
  const server = start();
  const uri = "file:///lifecycle.agilogic";
  try {
    await initialize(server);
    await open(server, uri, "not.a.command();", 4);
    await waitFor(
      "version 4 diagnostics",
      () => published(server, uri, (p) => p.version === 4 && p.diagnostics.length > 0),
      server,
    );
    await close(server, uri);
    await waitFor(
      "close clearing diagnostics",
      () =>
        server.diagnostics.find(
          (p) => p.uri === uri && p.diagnostics.length === 0 && p.version !== 4,
        ) ?? published(server, uri, (p) => p.diagnostics.length === 0 && p.version === undefined),
      server,
    );
    // A change for a closed document is a protocol violation; the server must
    // stay alive and silent rather than publish for it.
    await change(server, uri, "return;", 5);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    assert.equal(
      server.diagnostics.filter((p) => p.uri === uri && p.version === 5).length,
      0,
      "closed document must not receive diagnostics",
    );

    await open(server, uri, "return;", 1);
    await waitFor(
      "reopened diagnostics",
      () => published(server, uri, (p) => p.version === 1 && p.diagnostics.length === 0),
      server,
    );

    // An out-of-order older version must not publish over the current one.
    await change(server, uri, "not.a.command();", 0).catch(() => undefined);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    assert.equal(
      server.diagnostics.filter((p) => p.uri === uri && p.version === 0).length,
      0,
      "stale version must not publish diagnostics",
    );
    await change(server, uri, "return;", 2);
    await waitFor(
      "post-stale diagnostics",
      () => published(server, uri, (p) => p.version === 2),
      server,
    );
  } finally {
    await shutdown(server);
  }
});

test("non-AGI documents stay silent and unknown methods are rejected", async () => {
  const server = start();
  try {
    await initialize(server);
    const uri = "file:///plain.txt";
    await server.connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: "plaintext", version: 1, text: "not.a.command();" },
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    assert.equal(
      server.diagnostics.filter((p) => p.uri === uri).length,
      0,
      "non-AGI document must not receive diagnostics",
    );
    const hover = await server.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: 0, character: 0 },
    });
    assert.equal(hover, null);

    const rejected = await server.connection.sendRequest("agi/unknownMethod", { probe: true }).then(
      () => "resolved",
      (error: { code?: number }) => `rejected:${error.code ?? "?"}`,
    );
    assert.equal(rejected, "rejected:-32601");
  } finally {
    await shutdown(server);
  }
});

test("stale and malformed updates cannot change the document used for hover or rename", async () => {
  const server = start();
  const uri = "file:///guarded.agilogic";
  const initial = "#define door 41\nset(door); return;";
  const other = "#define door 99\nset(door); return;";
  try {
    await initialize(server);
    await open(server, uri, initial, 10);
    const changes = [
      { textDocument: { uri, version: 9 }, contentChanges: [{ text: other }] },
      { textDocument: { uri, version: 10 }, contentChanges: [{ text: other }] },
      { textDocument: { uri, version: 11.5 }, contentChanges: [{ text: other }] },
      { textDocument: { uri, version: 11 }, contentChanges: [{ text: 99 }] },
      {
        textDocument: { uri, version: 11 },
        contentChanges: [
          {
            text: other,
            range: { start: { line: 0, character: 0 }, end: { line: 1, character: 19 } },
          },
        ],
      },
    ];
    for (const update of changes) {
      await server.connection.sendNotification("textDocument/didChange", update);
      const hover = await server.connection.sendRequest(HoverRequest.type, {
        textDocument: { uri },
        position: { line: 1, character: 5 },
      });
      assert.match(
        JSON.stringify(hover),
        /door 41/,
        `refused update must preserve source: ${JSON.stringify(update)}`,
      );
      const rename = await server.connection.sendRequest(RenameRequest.type, {
        textDocument: { uri },
        position: { line: 1, character: 5 },
        newName: "gate",
      });
      assert.match(JSON.stringify(rename), /"version":10/);
    }
    await open(server, uri, other, 11);
    const duplicate = await server.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: 1, character: 5 },
    });
    assert.match(JSON.stringify(duplicate), /door 41/);
    await change(server, uri, other, 11);
    const updated = await server.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: 1, character: 5 },
    });
    assert.match(JSON.stringify(updated), /door 99/);
    await close(server, uri);
    await open(server, uri, "#define door 7\nset(door); return;", 1);
    const reopened = await server.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: 1, character: 5 },
    });
    assert.match(JSON.stringify(reopened), /door 7/);
  } finally {
    await shutdown(server);
  }
});

test("variadic signature help keeps the active parameter within its advertised slots", async () => {
  const server = start();
  const uri = "file:///variadic.agilogic";
  const source = 'if (said("one", "two", ';
  try {
    await initialize(server);
    await open(server, uri, source, 1);
    const signature = await server.connection.sendRequest(SignatureHelpRequest.type, {
      textDocument: { uri },
      position: positionAt(source, source.length),
    });
    assert.equal(signature?.activeParameter, 1);
    assert.equal(signature?.signatures[0]?.parameters?.[1]?.label, "...");
  } finally {
    await shutdown(server);
  }
});

test("project archives resolve names and watched WORDS and bindings updates refresh diagnostics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agi-lsp-project-"));
  const archive = join(dir, "game.zip");
  const tutorial = buildTutorial();
  writeFileSync(
    archive,
    await buildProjectZip({
      ...tutorial,
      projectId: requireProjectId("synthetic"),
      authoredAt: "2000-01-01T00:00:00Z",
      authoringState: tutorial.project?.authoringState,
    }),
  );
  writeFileSync(join(dir, "bindings.json"), JSON.stringify({ door: { kind: "flag", num: 41 } }));
  const server = start(["--project", archive]);
  const uri = pathToFileURL(join(dir, "logic.1.lgc")).href;
  try {
    await initialize(server);
    await open(server, uri, "set(door); return;", 1);
    const first = await waitFor(
      "project bindings",
      () => published(server, uri, (p) => p.version === 1),
      server,
    );
    assert.deepEqual(first.diagnostics, []);
    const hover = await server.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: 0, character: 5 },
    });
    assert.match(JSON.stringify(hover), /door 41/);
    writeFileSync(join(dir, "bindings.json"), "{}");
    await server.connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToFileURL(join(dir, "bindings.json")).href, type: 2 }],
    });
    await waitFor(
      "watched binding removal",
      () =>
        server.diagnostics.find(
          (p) => p.uri === uri && p.diagnostics.some((d) => /door/.test(diagnosticMessage(d))),
        ),
      server,
    );
  } finally {
    await shutdown(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project navigation and rename cover closed logics while local names stay scoped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agi-lsp-navigation-"));
  const tutorial = buildTutorial();
  const archive = join(dir, "game.zip");
  writeFileSync(
    archive,
    await buildProjectZip({
      ...tutorial,
      projectId: requireProjectId("synthetic"),
      authoredAt: "2000-01-01T00:00:00Z",
      authoringState: tutorial.project?.authoringState,
    }),
  );
  writeFileSync(join(dir, "bindings.json"), '{\n  "door": {"kind":"flag","num":41}\n}');
  const source = "#define local 42\nset(door); set(local);\ngoto done;\ndone:\nreturn;";
  writeFileSync(join(dir, "logic.1.lgc"), source);
  writeFileSync(join(dir, "logic.2.lgc"), 'set(door); print("door"); // door\nreturn;');
  const uri = pathToFileURL(join(dir, "logic.1.lgc")).href;
  const server = start(["--project", archive]);
  try {
    await initialize(server);
    await open(server, uri, source, 5);
    const position = positionAt(source, source.indexOf("set(door") + 4);
    const definition = await server.connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position,
    });
    assert.match(JSON.stringify(definition), /bindings\.json/);
    const references = await server.connection.sendRequest(ReferencesRequest.type, {
      textDocument: { uri },
      position,
      context: { includeDeclaration: false },
    });
    assert.equal(references?.length, 2);
    assert.ok(references?.some((r) => r.uri.endsWith("logic.2.lgc")));
    const edit = await server.connection.sendRequest(RenameRequest.type, {
      textDocument: { uri },
      position,
      newName: "gate",
    });
    assert.equal(edit?.documentChanges?.length, 3);
    assert.match(JSON.stringify(edit), /"version":5/);
    assert.match(JSON.stringify(edit), /bindings\.json/);
    const symbols = (await server.connection.sendRequest("workspace/symbol", {
      query: "door",
    })) as { name: string }[];
    assert.ok(symbols.some((s) => s.name === "door"));
    const documentSymbols = (await server.connection.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    })) as { name: string }[];
    assert.deepEqual(
      documentSymbols.map((s) => s.name),
      ["local", "done"],
    );
    const local = await server.connection.sendRequest(ReferencesRequest.type, {
      textDocument: { uri },
      position: positionAt(source, source.indexOf("set(local") + 4),
      context: { includeDeclaration: true },
    });
    assert.equal(local?.length, 2);
    assert.ok(local?.every((r) => r.uri === uri));
    await assert.rejects(
      server.connection.sendRequest(RenameRequest.type, {
        textDocument: { uri },
        position,
        newName: "local",
      }),
      /definition|collision|already/,
    );
  } finally {
    await shutdown(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lexer semantic tokens, highlights and folding use UTF-16 ranges", async () => {
  const server = start();
  const uri = "file:///structure.lgc";
  const source =
    '#define door 41\n#message 1 "Hello"\nif (isset(door)) {\n  print("😀 // string"); // comment\n  set(door);\n}\nreturn;';
  try {
    const capabilities = (await initialize(server)).capabilities;
    assert.ok(capabilities.semanticTokensProvider);
    assert.equal(capabilities.documentHighlightProvider, true);
    assert.equal(capabilities.foldingRangeProvider, true);
    await open(server, uri, source, 1);
    const tokens = (await server.connection.sendRequest("textDocument/semanticTokens/full", {
      textDocument: { uri },
    })) as { data: number[] };
    const decoded: { line: number; character: number; length: number; type: number }[] = [];
    let line = 0,
      character = 0;
    for (let i = 0; i < tokens.data.length; i += 5) {
      const delta = tokens.data[i]!;
      line += delta;
      character = delta ? tokens.data[i + 1]! : character + tokens.data[i + 1]!;
      decoded.push({ line, character, length: tokens.data[i + 2]!, type: tokens.data[i + 3]! });
    }
    assert.ok(
      decoded.some((t) => t.line === 3 && t.character === 8 && t.length === 14 && t.type === 4),
      "string token includes the astral UTF-16 pair and slashes",
    );
    assert.ok(
      decoded.some((t) => t.line === 3 && t.character === 25 && t.type === 6),
      "comment comes from a lexer gap",
    );
    const ranged = (await server.connection.sendRequest("textDocument/semanticTokens/range", {
      textDocument: { uri },
      range: { start: { line: 4, character: 0 }, end: { line: 5, character: 0 } },
    })) as { data: number[] };
    assert.equal(ranged.data[0], 4);
    const highlights = (await server.connection.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 4, character: 6 },
    })) as { range: Range }[];
    assert.equal(highlights.length, 3);
    const folds = await server.connection.sendRequest("textDocument/foldingRange", {
      textDocument: { uri },
    });
    assert.deepEqual(folds, [{ startLine: 2, endLine: 4, kind: "region" }]);
    const symbols = (await server.connection.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    })) as { name: string }[];
    assert.deepEqual(
      symbols.map((s) => s.name),
      ["door", "Message 1"],
    );
  } finally {
    await shutdown(server);
  }
});

test("code actions define missing names and repair syntax using compiler diagnostics", async () => {
  const server = start();
  const uri = "file:///fixes.lgc";
  try {
    await initialize(server);
    await open(server, uri, "set(door); return;", 1);
    const first = await waitFor(
      "missing name",
      () => published(server, uri, (p) => p.version === 1),
      server,
    );
    const actions = (await server.connection.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range: first.diagnostics[0]!.range,
      context: { diagnostics: first.diagnostics },
    })) as { title: string; edit: WorkspaceEdit }[];
    assert.ok(actions.some((a) => a.title === "Define door as 0"));
    const edit = actions.find((a) => a.title === "Define door as 0")!.edit.documentChanges![0]!;
    assert.ok("textDocument" in edit);
    assert.equal(edit.textDocument.version, 1);
    assert.deepEqual(edit.edits, [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "#define door 0\n",
      },
    ]);
    await change(server, uri, "#define door 0\nset(door); return;", 2);
    assert.deepEqual(
      (await waitFor("fixed name", () => published(server, uri, (p) => p.version === 2), server))
        .diagnostics,
      [],
    );
    await change(server, uri, 'print("Hello")\nreturn;', 3);
    const missing = await waitFor(
      "missing semicolon",
      () => published(server, uri, (p) => p.version === 3),
      server,
    );
    const repairs = (await server.connection.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range: missing.diagnostics[0]!.range,
      context: { diagnostics: missing.diagnostics },
    })) as { title: string; edit: WorkspaceEdit }[];
    assert.ok(repairs.some((a) => a.title === "Insert semicolon"));
    const filtered = await server.connection.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range: missing.diagnostics[0]!.range,
      context: { diagnostics: missing.diagnostics, only: ["refactor"] },
    });
    assert.deepEqual(filtered, []);
  } finally {
    await shutdown(server);
  }
});

test("incremental changes apply sequential UTF-16 edits and pull diagnostics match push", async () => {
  const server = start();
  const uri = "file:///incremental.lgc";
  try {
    const initialized = await initialize(server);
    assert.equal(
      typeof initialized.capabilities.textDocumentSync === "object" &&
        initialized.capabilities.textDocumentSync.change,
      TextDocumentSyncKind.Incremental,
    );
    assert.ok(initialized.capabilities.diagnosticProvider);
    assert.equal(
      initialized.serverInfo?.version,
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
    );
    await open(server, uri, "// 😀\r\nset(door); return;", 1);
    const first = await waitFor(
      "initial push",
      () => published(server, uri, (p) => p.version === 1),
      server,
    );
    const pull = (await server.connection.sendRequest("textDocument/diagnostic", {
      textDocument: { uri },
    })) as { kind: string; items: Diagnostic[]; resultId: string };
    assert.deepEqual(pull.items, first.diagnostics);
    await server.connection.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: 2 },
      contentChanges: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          text: "#define door 41\r\n",
        },
        {
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } },
          text: "door",
        },
      ],
    });
    const next = await waitFor(
      "incremental push",
      () => published(server, uri, (p) => p.version === 2),
      server,
    );
    assert.deepEqual(next.diagnostics, []);
    const updated = (await server.connection.sendRequest("textDocument/diagnostic", {
      textDocument: { uri },
    })) as { items: Diagnostic[]; resultId: string };
    assert.deepEqual(updated.items, []);
    assert.notEqual(updated.resultId, pull.resultId);
    const unchanged = await server.connection.sendRequest("textDocument/diagnostic", {
      textDocument: { uri },
      previousResultId: updated.resultId,
    });
    assert.deepEqual(unchanged, { kind: "unchanged", resultId: updated.resultId });
  } finally {
    await shutdown(server);
  }
});

test("stdio and browser worker ports answer the same LSP sequence", async () => {
  const { attachLogicLanguageServer } = await import("../app/src/studio/logic/analysisService.ts");
  const replies: LspResponse[] = [];
  const port = {
    onmessage: null as ((event: { data: LspMessage }) => void) | null,
    postMessage: (reply: LspResponse | LspNotification) => {
      if ("id" in reply) replies.push(reply);
    },
  };
  attachLogicLanguageServer(port, {
    version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  });
  const server = start();
  const uri = "file:///parity.lgc";
  const source = "#define door 41\nif (isset(door)) {\n  set(door);\n}\nreturn;";
  try {
    const initialized = await initialize(server);
    port.onmessage!({ data: { jsonrpc: "2.0", id: -1, method: "initialize", params: {} } });
    assert.deepEqual(replies.at(-1)?.result, initialized);
    await open(server, uri, source, 1);
    port.onmessage!({
      data: {
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: LANGUAGE_ID, version: 1, text: source } },
      },
    });
    const methods = [
      "textDocument/completion",
      "textDocument/signatureHelp",
      "textDocument/hover",
      "textDocument/definition",
      "textDocument/references",
      "textDocument/prepareRename",
      "textDocument/rename",
      "textDocument/documentSymbol",
      "workspace/symbol",
      "textDocument/documentHighlight",
      "textDocument/foldingRange",
      "textDocument/semanticTokens/full",
      "textDocument/semanticTokens/range",
      "textDocument/codeAction",
      "textDocument/diagnostic",
      "agi/compile",
    ];
    for (const [id, method] of methods.entries()) {
      const params = {
        textDocument: { uri },
        position: { line: 2, character: 7 },
        newName: "gate",
        query: "door",
        context: { includeDeclaration: true, diagnostics: [] },
        range: { start: { line: 2, character: 0 }, end: { line: 3, character: 0 } },
      };
      const cli = await server.connection.sendRequest(method, params);
      port.onmessage!({ data: { jsonrpc: "2.0", id, method, params } });
      const reply = replies.at(-1)!;
      assert.equal(reply.error, undefined, method);
      assert.deepEqual(reply.result, cli, method);
    }
  } finally {
    await shutdown(server);
  }
});

test("clone bin runs through npx and keeps help off stdout", () => {
  const bin = Object.keys(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).bin)[0]!;
  assert.equal(bin, "agi-language-server");
  const result = spawnSync("npx", ["--no-install", bin, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--project/);
});

test("tutorial compilation through the server matches the app compiler and shipped bytes", async () => {
  const { readProjectLanguageInput } = await import("../src/authoring/projectLanguageInput.ts");
  const { compileProjectLogic } = await import("../src/authoring/projectLogic.ts");
  const { openContainer } = await import("../src/container/container.ts");
  const tutorial = buildTutorial();
  const input = readProjectLanguageInput(tutorial);
  const dir = mkdtempSync(join(tmpdir(), "agi-lsp-compile-"));
  const archive = join(dir, "tutorial.zip");
  writeFileSync(
    archive,
    await buildProjectZip({
      ...tutorial,
      projectId: requireProjectId("synthetic"),
      authoredAt: "2000-01-01T00:00:00Z",
      authoringState: tutorial.project?.authoringState,
    }),
  );
  const server = start(["--project", archive]);
  try {
    await initialize(server);
    const container = openContainer(new Map(Object.entries(tutorial.files)), {
      profile: input.profile,
    });
    for (const [key, source] of Object.entries(input.sources)) {
      const uri = pathToFileURL(join(dir, `logic.${key.slice(6)}.lgc`)).href;
      await open(server, uri, source, 1);
      const pushed = await waitFor(
        `tutorial ${key}`,
        () => published(server, uri, (p) => p.version === 1),
        server,
      );
      const { createProjectLogicLanguageSnapshot } =
        await import("../src/authoring/projectLanguage.ts");
      const { rangeAt } = await import("../src/logic/lspTypes.ts");
      const expected = createProjectLogicLanguageSnapshot({ ...input, source }).diagnostics.map(
        (entry) => ({
          range: rangeAt(source, entry.start, entry.end),
          message: entry.message,
          severity: entry.severity === "error" ? 1 : 2,
          source: LANGUAGE_ID,
        }),
      );
      assert.deepEqual(pushed.diagnostics, expected, key);
      assert.ok(
        pushed.diagnostics.every((entry) => entry.severity !== 1),
        key,
      );
      const compiled = (await server.connection.sendRequest("agi/compile", {
        textDocument: { uri },
      })) as { payload: number[] };
      const app = compileProjectLogic(source, input).assembly.payload;
      assert.deepEqual(compiled.payload, [...app], key);
      assert.deepEqual(
        compiled.payload,
        [...container.getResource("logic", Number(key.slice(6)))!],
        key,
      );
    }
  } finally {
    await shutdown(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const kind of ["v2-split", "v3-combined"] as const)
  test(`${kind} game inputs detect profiles and watch WORDS and OBJECT`, async () => {
    const { createContainer, openContainer } = await import("../src/container/container.ts");
    const { assembleLogic } = await import("../src/logic/assembler.ts");
    const { buildObjectFile } = await import("../src/authoring/inventory.ts");
    const { PROFILES } = await import("../src/runtime/profile.ts");
    const profile = PROFILES[kind === "v2-split" ? "2.936" : "3.002.149"];
    const container =
      kind === "v2-split"
        ? createContainer()
        : openContainer(
            new Map([
              [
                "DEMODIR",
                Uint8Array.from([
                  8, 0, 11, 0, 14, 0, 17, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
                  255,
                ]),
              ],
              ["DEMOVOL.0", new Uint8Array()],
            ]),
            { profile },
          );
    container.putResource(
      "logic",
      0,
      assembleLogic("return;", { profile, dictionary: new Map() }).payload,
    );
    const dir = mkdtempSync(join(tmpdir(), "agi-lsp-native-"));
    for (const [name, bytes] of container.files) writeFileSync(join(dir, name), bytes);
    writeFileSync(join(dir, "AGIDATA.OVL"), `Version ${profile.id}`);
    writeFileSync(join(dir, "WORDS.TOK"), buildWordsTok([{ word: "open", id: 100 }]));
    writeFileSync(join(dir, "OBJECT"), buildObjectFile([{ name: "key" }], profile));
    const server = start(["--project", dir]);
    const uri = pathToFileURL(join(dir, "logic.0.lgc")).href;
    try {
      await initialize(server);
      await open(server, uri, "get(", 1);
      const items = (await server.connection.sendRequest(CompletionRequest.type, {
        textDocument: { uri },
        position: { line: 0, character: 4 },
      })) as CompletionItem[];
      assert.ok(
        items.some(
          (item) =>
            item.label === "key" &&
            item.textEdit &&
            "newText" in item.textEdit &&
            item.textEdit.newText === "o0",
        ),
      );
      writeFileSync(join(dir, "OBJECT"), buildObjectFile([{ name: "coin" }], profile));
      writeFileSync(join(dir, "WORDS.TOK"), buildWordsTok([{ word: "close", id: 101 }]));
      await server.connection.sendNotification("workspace/didChangeWatchedFiles", {
        changes: ["OBJECT", "WORDS.TOK"].map((name) => ({
          uri: pathToFileURL(join(dir, name)).href,
          type: 2,
        })),
      });
      await waitFor(
        "reload publish",
        () => (server.diagnostics.filter((p) => p.uri === uri).length >= 2 ? true : undefined),
        server,
      );
      const updated = (await server.connection.sendRequest(CompletionRequest.type, {
        textDocument: { uri },
        position: { line: 0, character: 4 },
      })) as CompletionItem[];
      assert.ok(updated.some((item) => item.label === "coin"));
      assert.ok(!updated.some((item) => item.label === "key"));
      await change(server, uri, 'if (said("', 2);
      const words = (await server.connection.sendRequest(CompletionRequest.type, {
        textDocument: { uri },
        position: { line: 0, character: 10 },
      })) as CompletionItem[];
      assert.ok(words.some((item) => item.label === "close"));
      assert.ok(!words.some((item) => item.label === "open"));
      const help = await server.connection.sendRequest(HoverRequest.type, {
        textDocument: { uri },
        position: { line: 0, character: 4 },
      });
      assert.match(JSON.stringify(help), /said/);
    } finally {
      await shutdown(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("extracting project sources creates navigable .lgc files and refuses overwrites", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agi-lsp-extract-"));
  const archive = join(dir, "tutorial.zip");
  const output = join(dir, "sources");
  writeFileSync(
    archive,
    await buildProjectZip({
      ...buildTutorial(),
      authoringState: buildTutorial().project?.authoringState,
      projectId: requireProjectId("synthetic"),
      authoredAt: "2000-01-01T00:00:00Z",
    }),
  );
  try {
    const run = () =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", SERVER, "--project", archive, "--extract-sources", output],
        { encoding: "utf8" },
      );
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(readFileSync(join(output, "logic.0.lgc"), "utf8"), /return;/);
    assert.deepEqual(
      JSON.parse(readFileSync(join(output, "bindings.json"), "utf8")),
      buildTutorial().project?.authoringState?.["authoring"] &&
        (buildTutorial().project!.authoringState!["authoring"] as { bindings: unknown }).bindings,
    );
    writeFileSync(join(output, "logic.0.lgc"), "my edits");
    const second = run();
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /exists/);
    assert.equal(readFileSync(join(output, "logic.0.lgc"), "utf8"), "my edits");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(".lgc files attach through generic clients with another host language id", async () => {
  const server = start();
  const uri = "file:///generic.lgc";
  try {
    await initialize(server);
    await server.connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: "plaintext", version: 1, text: "unknown(); return;" },
    });
    const diagnostics = await waitFor(
      "extension diagnostics",
      () => published(server, uri, (p) => p.version === 1),
      server,
    );
    assert.match(diagnosticMessage(diagnostics.diagnostics[0]!), /unknown action/);
  } finally {
    await shutdown(server);
  }
});

test("official client cancellation rejects a queued request and leaves documents usable", async () => {
  let buffering = false;
  const chunks: Buffer[] = [];
  let cancellationWritten!: () => void;
  const written = new Promise<void>((resolve) => {
    cancellationWritten = resolve;
  });
  const server = start(
    [],
    false,
    (stdin) =>
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          if (!buffering) {
            stdin.write(chunk, done);
            return;
          }
          chunks.push(Buffer.from(chunk));
          if (Buffer.concat(chunks).includes('"method":"$/cancelRequest"')) cancellationWritten();
          done();
        },
      }),
  );
  const uri = "file:///cancel.lgc";
  try {
    await initialize(server);
    await open(server, uri, "#define door 41\nset(door); return;", 1);
    // Deliver the official client's request and cancellation in one packet so
    // the request is still queued when the server reads the cancellation.
    buffering = true;
    const cancellation = new CancellationTokenSource();
    const request = server.connection.sendRequest(
      HoverRequest.type,
      { textDocument: { uri }, position: { line: 1, character: 5 } },
      cancellation.token,
    );
    cancellation.cancel();
    await written;
    buffering = false;
    server.child.stdin.write(Buffer.concat(chunks));
    await assert.rejects(request, (error: { code?: number }) => error.code === -32800);
    cancellation.dispose();
    const hover = await server.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line: 1, character: 5 },
    });
    assert.match(JSON.stringify(hover), /door 41/);
  } finally {
    await shutdown(server);
  }
});

test("clients can register project watches and receive flat document symbols", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agi-lsp-watches-"));
  const words = join(dir, "WORDS.TOK");
  writeFileSync(words, buildWordsTok([]));
  const server = start(["--words", words]);
  const registrations: unknown[] = [];
  server.connection.onRequest("client/registerCapability", (params) => {
    registrations.push(params);
    return null;
  });
  try {
    const result = await server.connection.sendRequest(InitializeRequest.type, {
      processId: null,
      rootUri: null,
      capabilities: {
        workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
        textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: false } },
      },
    });
    assert.equal(result.capabilities.documentSymbolProvider, true);
    await server.connection.sendNotification(InitializedNotification.type, {});
    await waitFor("watch registration", () => registrations[0], server);
    assert.match(JSON.stringify(registrations), /didChangeWatchedFiles/);
    const uri = "file:///flat.lgc";
    await open(server, uri, "#define door 41\nset(door); return;", 1);
    const symbols = (await server.connection.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    })) as { name: string; location: Location }[];
    assert.equal(symbols[0]?.location.uri, uri);
  } finally {
    await shutdown(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
