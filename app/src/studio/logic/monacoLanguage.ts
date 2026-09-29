/**
 * Monaco adapter for AGI logic source in Logic Studio. Loads lazily with the
 * Studio bundle; nothing here runs on the Play boot path. Language answers come
 * from the shared analysis worker through LogicAnalysisClient: this module only
 * adapts shapes, lifetimes and cancellation. It never parses or compiles
 * source, never edits a document beyond the author's own typing, and never
 * writes project state.
 *
 * editor.api alone registers no commands or widgets; the contributions below
 * are exactly the features this workspace uses. editor.main would additionally
 * pull every bundled language registration and its worker client.
 */
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError.js";
import "monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js";
import "monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js";
import "monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

import type { LogicAnalysisClient } from "./analysisClient.ts";
import type { LogicAnalysisOperations, LogicAnalysisQuery } from "./analysisProtocol.ts";

export { monaco };

/** Language identifier hosts pass to `monaco.editor.createModel`. */
export const LOGIC_LANGUAGE_ID = "agi-logic";

const MARKER_OWNER = "agi-logic";

// The generic editor worker exists for Monaco's own services (find in files,
// word distance, diff). Language answers run on the analysis worker instead.
// A host-provided environment wins if it configured one before import.
globalThis.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
  ...globalThis.MonacoEnvironment,
};

monaco.languages.register({ id: LOGIC_LANGUAGE_ID });

/**
 * Presentation-only coloring: the same surface the strict lexer accepts
 * (// comments, #define/#message, quoted strings with escapes, identifiers,
 * registers and punctuation). It never resolves names or implies that
 * highlighted text compiles; diagnostics come from the analysis worker.
 */
monaco.languages.setMonarchTokensProvider(LOGIC_LANGUAGE_ID, {
  tokenizer: {
    root: [
      [/\/\/.*/, "comment"],
      [/#(?:define|message)\b/, "keyword.directive"],
      // The strict lexer skips an unrecognized # directive to end of line.
      [/#.*/, "comment"],
      [/"/, { token: "string.quote", next: "@string" }],
      [/\b(?:if|else|return|goto)\b/, "keyword"],
      [/\b[vfoms]\d{1,3}\b/, "variable"],
      [/\d+/, "number"],
      [/[a-zA-Z_.][a-zA-Z0-9_.]*(?=\()/, "function"],
      [/[a-zA-Z_.][a-zA-Z0-9_.]*/, "identifier"],
      [/[{}();,:]/, "delimiter"],
      [/==|!=|<=|>=|&&|\|\||[<>=!]/, "operator"],
    ],
    string: [
      [/\\x[0-9a-fA-F]{2}/, "string.escape"],
      [/\\./, "string.escape"],
      [/[^\\"]+/, "string"],
      [/"/, { token: "string.quote", next: "@pop" }],
      // An unterminated literal ends with the line; never color onward.
      [/$/, "string", "@pop"],
    ],
  },
});

monaco.languages.setLanguageConfiguration(LOGIC_LANGUAGE_ID, {
  comments: { lineComment: "//" },
  brackets: [
    ["{", "}"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
  // Dotted command names (move.obj) and registers (f42) select as one word.
  wordPattern: /[a-zA-Z0-9_.]+/,
  onEnterRules: [
    {
      beforeText: /{[^}]*$/,
      afterText: /^\s*}/,
      action: { indentAction: monaco.languages.IndentAction.IndentOutdent },
    },
    {
      beforeText: /{[^}]*$/,
      action: { indentAction: monaco.languages.IndentAction.Indent },
    },
  ],
});

interface ModelRegistration {
  readonly model: monaco.editor.ITextModel;
  readonly client: LogicAnalysisClient;
  readonly documentKey: string;
  disposed: boolean;
  dispose(): void;
}

/**
 * One registration per model URI. Providers below are registered once per
 * language for every workspace, so they multiplex through this map and answer
 * only for a live registered model — foreign models get empty results.
 */
const registrations = new Map<string, ModelRegistration>();

function activeRegistration(model: monaco.editor.ITextModel): ModelRegistration | undefined {
  const registration = registrations.get(model.uri.toString());
  if (!registration || registration.disposed || registration.model !== model || model.isDisposed())
    return undefined;
  return registration;
}

/**
 * The registration is still the answerable one. Registration identity is the
 * generation check: a re-registered URI carries a different object.
 */
function stillCurrent(registration: ModelRegistration): boolean {
  return activeRegistration(registration.model) === registration;
}

async function queryWorker<Q extends LogicAnalysisQuery>(
  registration: ModelRegistration,
  query: Q,
  token: monaco.CancellationToken,
): Promise<LogicAnalysisOperations[Q["method"]] | undefined> {
  const controller = new AbortController();
  const cancellation = token.onCancellationRequested(() => controller.abort());
  try {
    return await registration.client.request(registration.documentKey, query, controller.signal);
  } catch {
    // Superseded snapshot, cancelled request or a restarting worker all mean
    // the same thing to an interactive provider: no authoritative answer.
    return undefined;
  } finally {
    cancellation.dispose();
  }
}

interface LiveQuery {
  readonly registration: ModelRegistration;
  readonly versionId: number;
}

function openQuery(
  model: monaco.editor.ITextModel,
  token: monaco.CancellationToken,
): LiveQuery | undefined {
  const registration = activeRegistration(model);
  if (!registration || token.isCancellationRequested) return undefined;
  return { registration, versionId: model.getVersionId() };
}

function queryIsLive(
  session: LiveQuery,
  model: monaco.editor.ITextModel,
  token: monaco.CancellationToken,
): boolean {
  return (
    stillCurrent(session.registration) &&
    model.getVersionId() === session.versionId &&
    !token.isCancellationRequested
  );
}

/** UTF-16 authored offset ⇄ model position conversions stay inside the model. */
function authoredRange(model: monaco.editor.ITextModel, start: number, end: number): monaco.Range {
  const length = model.getValueLength();
  const from = model.getPositionAt(Math.max(0, Math.min(start, length)));
  const to = model.getPositionAt(Math.max(0, Math.min(end, length)));
  return new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column);
}

function completionKind(detail: string): monaco.languages.CompletionItemKind {
  const kind = monaco.languages.CompletionItemKind;
  if (detail === "Local definition") return kind.Variable;
  if (detail.startsWith("Word group")) return kind.Value;
  if (detail.includes("(")) return kind.Function;
  return kind.Keyword;
}

/**
 * Parameter spans inside a `name(p1, p2, ...)` signature label, so the active
 * argument can be highlighted without a second operand table.
 */
function signatureParameters(label: string): [number, number][] {
  const open = label.indexOf("(");
  const close = label.lastIndexOf(")");
  if (open < 0 || close <= open + 1) return [];
  const parameters: [number, number][] = [];
  let at = open + 1;
  for (const part of label.slice(open + 1, close).split(",")) {
    const start = at + part.length - part.trimStart().length;
    const trimmed = part.trim().length;
    if (trimmed > 0) parameters.push([start, start + trimmed]);
    at += part.length + 1;
  }
  return parameters;
}

monaco.languages.registerCompletionItemProvider(LOGIC_LANGUAGE_ID, {
  triggerCharacters: ['"', "#", "."],
  async provideCompletionItems(model, position, _context, token) {
    const session = openQuery(model, token);
    if (!session) return { suggestions: [] };
    const items = await queryWorker(
      session.registration,
      { method: "completeAt", offset: model.getOffsetAt(position) },
      token,
    );
    if (!items || !queryIsLive(session, model, token)) return { suggestions: [] };
    return {
      incomplete: true,
      suggestions: items.map((item) => ({
        label: item.label,
        detail: item.detail,
        kind: completionKind(item.detail),
        insertText: item.text,
        // The text inside the item's range (for example `"o`) is a prefix of
        // the replacement (`"open"`); filtering by the label alone would hide
        // quoted vocabulary entries.
        filterText: item.text,
        range: authoredRange(model, item.start, item.end),
      })),
    };
  },
});

monaco.languages.registerSignatureHelpProvider(LOGIC_LANGUAGE_ID, {
  signatureHelpTriggerCharacters: ["(", ","],
  async provideSignatureHelp(model, position, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    const help = await queryWorker(
      session.registration,
      { method: "signatureAt", offset: model.getOffsetAt(position) },
      token,
    );
    if (!help || !queryIsLive(session, model, token)) return null;
    const parameters = signatureParameters(help.label);
    return {
      value: {
        signatures: [
          {
            label: help.label,
            parameters: parameters.map((label) => ({ label })),
            documentation: { value: help.documentation },
          },
        ],
        activeSignature: 0,
        activeParameter: Math.min(help.activeParameter, Math.max(0, parameters.length - 1)),
      },
      dispose() {},
    };
  },
});

monaco.languages.registerHoverProvider(LOGIC_LANGUAGE_ID, {
  async provideHover(model, position, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    const hover = await queryWorker(
      session.registration,
      { method: "hoverAt", offset: model.getOffsetAt(position) },
      token,
    );
    if (!hover || !queryIsLive(session, model, token)) return null;
    return {
      range: authoredRange(model, hover.start, hover.end),
      contents: [{ value: hover.text, isTrusted: false }],
    };
  },
});

monaco.languages.registerDefinitionProvider(LOGIC_LANGUAGE_ID, {
  async provideDefinition(model, position, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    const definition = await queryWorker(
      session.registration,
      { method: "definitionAt", offset: model.getOffsetAt(position) },
      token,
    );
    if (!definition || !queryIsLive(session, model, token)) return null;
    // A project binding resolves to a generated prelude define; its owning
    // location is not authored source, so no source range is invented here.
    if (definition.kind === "binding") return null;
    return { uri: model.uri, range: authoredRange(model, definition.start, definition.end) };
  },
});

monaco.languages.registerReferenceProvider(LOGIC_LANGUAGE_ID, {
  async provideReferences(model, position, _context, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    const references = await queryWorker(
      session.registration,
      { method: "referencesAt", offset: model.getOffsetAt(position) },
      token,
    );
    if (!references || !queryIsLive(session, model, token)) return null;
    return references.map((range) => ({
      uri: model.uri,
      range: authoredRange(model, range.start, range.end),
    }));
  },
});

monaco.languages.registerDocumentHighlightProvider(LOGIC_LANGUAGE_ID, {
  async provideDocumentHighlights(model, position, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    const references = await queryWorker(
      session.registration,
      { method: "referencesAt", offset: model.getOffsetAt(position) },
      token,
    );
    if (!references || !queryIsLive(session, model, token)) return null;
    return references.map((range) => ({
      range: authoredRange(model, range.start, range.end),
    }));
  },
});

export interface LogicModelHandle {
  /**
   * Ask the shared analysis worker for this document's authored diagnostics
   * and apply them as markers. Call after updating the client's project
   * snapshot to the model's text. Resolves when the attempt settles; a
   * superseded or stale reply changes nothing, so a failed or replaced
   * refresh leaves the previous markers for the next refresh to replace.
   */
  refreshDiagnostics(): Promise<void>;
  /**
   * Stop serving this model and clear only this registration's markers.
   * Other workspaces' registrations and the shared providers stay live.
   */
  dispose(): void;
}

/**
 * Serve one live editor model through a workspace's analysis client. Hosts
 * create models only for visible/open documents and keep the client snapshot
 * current (setProject after each text change) before refreshDiagnostics.
 * Registering a second model for the same URI retires the earlier handle.
 */
export function registerLogicModel(
  model: monaco.editor.ITextModel,
  options: { readonly client: LogicAnalysisClient; readonly documentKey: string },
): LogicModelHandle {
  if (model.isDisposed()) throw new Error("Cannot register a disposed logic model.");
  const uri = model.uri.toString();
  registrations.get(uri)?.dispose();
  const registration: ModelRegistration = {
    model,
    client: options.client,
    documentKey: options.documentKey,
    disposed: false,
    dispose,
  };
  registrations.set(uri, registration);
  const modelDisposal = model.onWillDispose(dispose);

  async function refreshDiagnostics(): Promise<void> {
    if (activeRegistration(model) !== registration) return;
    const versionId = model.getVersionId();
    let result: LogicAnalysisOperations["diagnostics"];
    try {
      result = await options.client.request(options.documentKey, { method: "diagnostics" });
    } catch {
      // The consulted snapshot was replaced, the workspace closed or the
      // worker restarted; the host's next refresh carries the newer state.
      return;
    }
    if (!stillCurrent(registration) || model.getVersionId() !== versionId) return;
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      result.diagnostics.map((entry) => {
        const range = authoredRange(model, entry.start, entry.end);
        return {
          severity:
            entry.severity === "error"
              ? monaco.MarkerSeverity.Error
              : monaco.MarkerSeverity.Warning,
          message: entry.message,
          source: MARKER_OWNER,
          startLineNumber: range.startLineNumber,
          startColumn: range.startColumn,
          endLineNumber: range.endLineNumber,
          endColumn: range.endColumn,
        };
      }),
    );
  }

  function dispose(): void {
    if (registration.disposed) return;
    registration.disposed = true;
    modelDisposal.dispose();
    if (registrations.get(uri) === registration) {
      registrations.delete(uri);
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    }
  }

  return { refreshDiagnostics, dispose };
}
