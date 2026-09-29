/**
 * Local logic language server for the AGI source grammar, built on the shared
 * createLogicLanguageSnapshot service (src/logic/language.ts). This is a
 * bounded developer preview: a single stdio transport, one interpreter
 * profile and one optional WORDS.TOK dictionary frozen at process startup.
 * Restart the process to change either of those inputs.
 *
 *   npm run --silent language-server -- --stdio [--profile ID] [--words PATH]
 *
 * Standard output carries protocol messages only; run npm with --silent and
 * keep usage, warnings and errors on standard error. Documents arrive through
 * full text synchronization; the server edits nothing on disk, in a project
 * or in a running game. Open documents must use the language id "agi-logic".
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createConnection,
  DiagnosticSeverity,
  ErrorCodes,
  LSPErrorCodes,
  PositionEncodingKind,
  ProposedFeatures,
  ResponseError,
  TextDocuments,
  TextDocumentSyncKind,
  type CompletionItem,
  type Diagnostic,
  type Location,
  type ParameterInformation,
  type PublishDiagnosticsParams,
  type Range,
  type ServerCapabilities,
  type TextDocumentPositionParams,
  type TextEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createLogicLanguageSnapshot } from "../src/logic/language.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { PROFILES, type AgiProfile, type ProfileId } from "../src/runtime/profile.ts";

const LANGUAGE_ID = "agi-logic";
const DIAGNOSTIC_SOURCE = "agi-logic";

const USAGE = `AGI logic language server (developer preview).

Usage:
  npm run --silent language-server -- --stdio [--profile ID] [--words WORDS.TOK]

Options:
  --stdio             Speak the protocol over stdin/stdout (required; the only
                      transport in this preview).
  --profile ID      Interpreter profile for command vocabulary and checks.
                      Default 2.936. Known: ${Object.keys(PROFILES).join(", ")}.
  --words PATH      Optional local WORDS.TOK image; its entries feed said()
                      completion and message assembly checks.
  --help            Print this text to stderr and exit.

The profile and dictionary are read once at startup; edit either input and
restart the server to pick up changes. Documents sync as full text in UTF-16
positions, must use the language id "${LANGUAGE_ID}", and are served only from
what the client sends: the server reads no project files and writes nothing.
`;

interface CliOptions {
  readonly stdio: boolean;
  readonly help: boolean;
  readonly profile: string;
  readonly words: string | undefined;
}

type Snapshot = ReturnType<typeof createLogicLanguageSnapshot>;

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
  };
}

function loadDictionary(path: string | undefined): ReadonlyMap<string, number> {
  const dictionary = new Map<string, number>();
  if (path === undefined) return dictionary;
  const entries = parseWordsTok(new Uint8Array(readFileSync(path)));
  for (const entry of entries) dictionary.set(entry.word, entry.id);
  return dictionary;
}

function signatureParameters(label: string): ParameterInformation[] {
  const open = label.indexOf("(");
  const close = label.lastIndexOf(")");
  if (open < 0 || close <= open + 1) return [];
  return label
    .slice(open + 1, close)
    .split(",")
    .map((part) => ({ label: part.trim() }))
    .filter((parameter) => parameter.label.length > 0);
}

function serve(profile: AgiProfile, dictionary: ReadonlyMap<string, number>): void {
  const connection = createConnection(ProposedFeatures.all);
  const documents: TextDocuments<TextDocument> = new TextDocuments<TextDocument>({
    create(uri, languageId, version, text): TextDocument {
      if (
        typeof uri !== "string" ||
        typeof languageId !== "string" ||
        !Number.isSafeInteger(version) ||
        typeof text !== "string"
      )
        throw new Error("Invalid document open notification.");
      // A duplicate open cannot replace the active document or its cached source.
      return documents.get(uri) ?? TextDocument.create(uri, languageId, version, text);
    },
    update(document, changes, version): TextDocument {
      // The SDK mutates TextDocument in place. Refuse invalid/full-sync violations
      // before it writes; suppressing diagnostics afterward would still poison
      // hover, navigation and rename queries with an older source version.
      if (
        !Number.isSafeInteger(version) ||
        version <= document.version ||
        changes.some((change) => !change || typeof change.text !== "string" || "range" in change)
      )
        return document;
      return TextDocument.update(document, changes, version);
    },
  });

  const snapshots = new Map<string, { readonly version: number; readonly snapshot: Snapshot }>();
  const publishedVersions = new Map<string, number>();

  const agiDocument = (uri: string): TextDocument | undefined => {
    const document = documents.get(uri);
    return document !== undefined && document.languageId === LANGUAGE_ID ? document : undefined;
  };

  const snapshotFor = (document: TextDocument): Snapshot => {
    const cached = snapshots.get(document.uri);
    if (cached && cached.version === document.version) return cached.snapshot;
    const snapshot = createLogicLanguageSnapshot({
      source: document.getText(),
      profile,
      dictionary,
    });
    snapshots.set(document.uri, { version: document.version, snapshot });
    return snapshot;
  };

  const rangeOf = (document: TextDocument, start: number, end: number): Range => ({
    start: document.positionAt(start),
    end: document.positionAt(end),
  });

  const offsetOf = (document: TextDocument, params: TextDocumentPositionParams): number =>
    document.offsetAt(params.position);

  const fail = (error: unknown): never => {
    if (error instanceof ResponseError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof RangeError ? ErrorCodes.InvalidParams : LSPErrorCodes.RequestFailed;
    throw new ResponseError(code, message);
  };

  connection.onInitialize(
    (): { capabilities: ServerCapabilities; serverInfo: { name: string; version: string } } => ({
      capabilities: {
        positionEncoding: PositionEncodingKind.UTF16,
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Full,
        },
        completionProvider: {
          triggerCharacters: [".", '"', "#", "("],
        },
        signatureHelpProvider: {
          triggerCharacters: ["(", ","],
          retriggerCharacters: [","],
        },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: { prepareProvider: true },
      },
      serverInfo: { name: "agi-logic-language-server", version: "1.2.0-preview" },
    }),
  );

  documents.onDidChangeContent((change) => {
    const document = change.document;
    if (document.languageId !== LANGUAGE_ID) return;
    const last = publishedVersions.get(document.uri);
    if (last !== undefined && document.version <= last) return;
    const snapshot = snapshotFor(document);
    publishedVersions.set(document.uri, document.version);
    const diagnostics: Diagnostic[] = snapshot.diagnostics.map((entry) => ({
      range: rangeOf(document, entry.start, entry.end),
      severity: entry.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
      source: DIAGNOSTIC_SOURCE,
      message: entry.message,
    }));
    const params: PublishDiagnosticsParams = {
      uri: document.uri,
      diagnostics,
      version: document.version,
    };
    void connection.sendDiagnostics(params);
  });

  documents.onDidClose((change) => {
    publishedVersions.delete(change.document.uri);
    snapshots.delete(change.document.uri);
    if (change.document.languageId === LANGUAGE_ID) {
      void connection.sendDiagnostics({ uri: change.document.uri, diagnostics: [] });
    }
  });

  connection.onCompletion((params, token) => {
    const document = agiDocument(params.textDocument.uri);
    if (!document || token.isCancellationRequested) return null;
    try {
      const items = snapshotFor(document).completeAt(offsetOf(document, params));
      return items.map((item): CompletionItem => {
        const edit: TextEdit = {
          range: rangeOf(document, item.start, item.end),
          newText: item.text,
        };
        return { label: item.label, detail: item.detail, textEdit: edit };
      });
    } catch (error) {
      return fail(error);
    }
  });

  connection.onSignatureHelp((params, token) => {
    const document = agiDocument(params.textDocument.uri);
    if (!document || token.isCancellationRequested) return null;
    try {
      const signature = snapshotFor(document).signatureAt(offsetOf(document, params));
      if (!signature) return null;
      const parameters = signatureParameters(signature.label);
      return {
        signatures: [
          {
            label: signature.label,
            documentation: signature.documentation,
            parameters,
          },
        ],
        activeSignature: 0,
        activeParameter: Math.min(signature.activeParameter, Math.max(0, parameters.length - 1)),
      };
    } catch (error) {
      return fail(error);
    }
  });

  connection.onHover((params, token) => {
    const document = agiDocument(params.textDocument.uri);
    if (!document || token.isCancellationRequested) return null;
    try {
      const hover = snapshotFor(document).hoverAt(offsetOf(document, params));
      if (!hover) return null;
      const [head, ...rest] = hover.text.split("\n\n");
      const value = `\`\`\`agi\n${head}\n\`\`\`${rest.length ? `\n\n${rest.join("\n\n")}` : ""}`;
      return {
        contents: { kind: "markdown", value },
        range: rangeOf(document, hover.start, hover.end),
      };
    } catch (error) {
      return fail(error);
    }
  });

  connection.onDefinition((params, token) => {
    const document = agiDocument(params.textDocument.uri);
    if (!document || token.isCancellationRequested) return null;
    try {
      const definition = snapshotFor(document).definitionAt(offsetOf(document, params));
      if (!definition) return null;
      const location: Location = {
        uri: document.uri,
        range: rangeOf(document, definition.start, definition.end),
      };
      return location;
    } catch (error) {
      return fail(error);
    }
  });

  connection.onReferences((params, token) => {
    const document = agiDocument(params.textDocument.uri);
    if (!document || token.isCancellationRequested) return null;
    try {
      const snapshot = snapshotFor(document);
      const offset = offsetOf(document, params);
      const definition = snapshot.definitionAt(offset);
      if (!definition) return null;
      return snapshot
        .referencesAt(offset)
        .filter(
          (entry) =>
            params.context.includeDeclaration !== false ||
            entry.start !== definition.start ||
            entry.end !== definition.end,
        )
        .map((entry): Location => ({
          uri: document.uri,
          range: rangeOf(document, entry.start, entry.end),
        }));
    } catch (error) {
      return fail(error);
    }
  });

  connection.onPrepareRename((params, token) => {
    const document = agiDocument(params.textDocument.uri);
    if (!document || token.isCancellationRequested) return null;
    try {
      const snapshot = snapshotFor(document);
      const offset = offsetOf(document, params);
      const range = snapshot
        .referencesAt(offset)
        .find((entry) => entry.start <= offset && offset < entry.end);
      if (!range) return null;
      const placeholder = document.getText(rangeOf(document, range.start, range.end));
      // Probe with the current name: compiles cleanly and proves the token is
      // renameable before the client offers the interaction.
      snapshot.renameAt(offset, placeholder);
      return { range: rangeOf(document, range.start, range.end), placeholder };
    } catch {
      return null;
    }
  });

  connection.onRenameRequest((params, token) => {
    const document = agiDocument(params.textDocument.uri);
    if (!document || token.isCancellationRequested) return null;
    try {
      const version = document.version;
      const edits = snapshotFor(document).renameAt(offsetOf(document, params), params.newName);
      // The service answers same-document offsets only, so every edit lands on
      // this URI; the captured version lets the client reject stale requests.
      return {
        documentChanges: [
          {
            textDocument: { uri: document.uri, version },
            edits: edits.map((edit): TextEdit => ({
              range: rangeOf(document, edit.start, edit.end),
              newText: edit.text,
            })),
          },
        ],
      };
    } catch (error) {
      return fail(error);
    }
  });

  documents.listen(connection);
  connection.listen();
}

function cli(args: string[]): void {
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
  process.stderr.write(
    `agi-logic language server preview: profile ${profile.id}, ${dictionary.size} dictionary word(s); restart to change auxiliary inputs.\n`,
  );
  serve(profile, dictionary);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
