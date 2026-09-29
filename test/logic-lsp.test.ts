/**
 * Wire tests for the local logic language server: each case launches the real
 * CLI as a child process and talks to it through the official protocol client
 * SDK over the child's stdio pipes. Sources are synthetic and the dictionary
 * image is produced by the shared WORDS.TOK writer.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createProtocolConnection,
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
import { buildWordsTok } from "../src/logic/words.ts";

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

function start(extraArgs: string[] = [], viaNpm = false): Running {
  const [command, argv] = viaNpm
    ? ["npm", ["run", "--silent", "language-server", "--", "--stdio", ...extraArgs]]
    : [process.execPath, ["--experimental-strip-types", SERVER, "--stdio", ...extraArgs]];
  const child = spawn(command, argv, { cwd: ROOT }) as ChildProcessWithoutNullStreams;
  const stderr: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const connection = createProtocolConnection(child.stdout, child.stdin, console);
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
  const result = await server.connection.sendRequest(InitializeRequest.type, {
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
  await server.connection.sendNotification(InitializedNotification.type, {});
  return result;
}

async function shutdown(server: Running): Promise<void> {
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
    const capabilities = result.capabilities;
    assert.equal(capabilities.positionEncoding, PositionEncodingKind.UTF16);
    const sync = capabilities.textDocumentSync;
    assert.equal(typeof sync === "object" && sync !== null ? sync.openClose : false, true);
    assert.equal(
      typeof sync === "object" && sync !== null ? sync.change : sync,
      TextDocumentSyncKind.Full,
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
