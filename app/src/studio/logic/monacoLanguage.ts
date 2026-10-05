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
import type { BindingInfo } from "../../../../src/logic/projectNames.ts";
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
import "monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js";
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
import "monaco-editor/editor/contrib/rename/browser/rename.js";
import "monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js";
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

import type { LogicAnalysisClient } from "./analysisClient.ts";
import type { LspOperations, Range, WorkspaceEdit } from "../../../../src/logic/lspTypes.ts";
import { SEMANTIC_LEGEND } from "../../../../src/logic/lspTypes.ts";

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
  readonly applyProjectEdit: ((edit: WorkspaceEdit, label: string) => Promise<void>) | undefined;
  readonly onBinding: ((info: BindingInfo, action: "open" | "rename") => void) | undefined;
  readonly bindingTargets: Map<string, BindingInfo>;
  readonly previews: Map<string, monaco.editor.ITextModel>;
  disposed: boolean;
  dispose(): void;
}

/**
 * One registration per model URI. Providers below are registered once per
 * language for every workspace, so they multiplex through this map and answer
 * only for a live registered model — foreign models get empty results.
 */
const registrations = new Map<string, ModelRegistration>();

// Standalone Monaco resolves location previews from models rather than files.
// Load only the sources a navigation request actually returns.
monaco.editor.onDidCreateEditor((editor) => {
  // Monaco measures text itself; CSS inheritance alone leaves its OS default.
  editor.updateOptions({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
  });
  void document.fonts.ready.then(() => monaco.editor.remeasureFonts());
  const changes = editor.onDidChangeModel(() => {
    if (editor.getModel()?.uri.scheme === "agi-preview") editor.updateOptions({ readOnly: true });
  });
  editor.onDidDispose(() => changes.dispose());
});

function locationUri(registration: ModelRegistration, uri: string): monaco.Uri {
  if (uri === registration.model.uri.toString()) return registration.model.uri;
  const source = registration.client.documentSource(uri);
  if (source === undefined) return monaco.Uri.parse(uri);
  let preview = registration.previews.get(uri);
  if (!preview) {
    const target = monaco.Uri.parse(uri);
    preview = monaco.editor.createModel(
      source,
      "plaintext",
      monaco.Uri.from({
        scheme: "agi-preview",
        authority: encodeURIComponent(registration.model.uri.toString()),
        path: `/${target.path.split("/").at(-1)}`,
      }),
    );
    registration.previews.set(uri, preview);
  } else if (preview.getValue() !== source) preview.setValue(source);
  return preview.uri;
}

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

async function queryWorker<K extends keyof LspOperations>(
  registration: ModelRegistration,
  method: K,
  params: Record<string, unknown>,
  token: monaco.CancellationToken,
  onError?: (message: string) => void,
): Promise<LspOperations[K] | undefined> {
  const controller = new AbortController();
  const cancellation = token.onCancellationRequested(() => controller.abort());
  try {
    return await registration.client.request(
      registration.documentKey,
      method,
      params,
      controller.signal,
    );
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error));
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

function editorRange(range: Range): monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  );
}
function protocolPosition(position: monaco.Position) {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}
function protocolRange(range: monaco.IRange): Range {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}
function workspaceEdit(edit: WorkspaceEdit): monaco.languages.WorkspaceEdit {
  return {
    edits: edit.documentChanges.flatMap((change) =>
      change.edits.map((entry) => ({
        resource: monaco.Uri.parse(change.textDocument.uri),
        versionId: monaco.editor
          .getModel(monaco.Uri.parse(change.textDocument.uri))
          ?.getVersionId(),
        textEdit: { range: editorRange(entry.range), text: entry.newText },
      })),
    ),
  };
}
function completionKind(detail: string): monaco.languages.CompletionItemKind {
  const kind = monaco.languages.CompletionItemKind;
  if (detail === "Local definition") return kind.Variable;
  if (detail.startsWith("Word group")) return kind.Value;
  if (detail.includes("(")) return kind.Function;
  return kind.Keyword;
}

monaco.languages.registerCompletionItemProvider(LOGIC_LANGUAGE_ID, {
  triggerCharacters: ['"', "#", ".", "("],
  async provideCompletionItems(model, position, _context, token) {
    const session = openQuery(model, token);
    if (!session) return { suggestions: [] };
    const items = await queryWorker(
      session.registration,
      "textDocument/completion",
      { position: protocolPosition(position) },
      token,
    );
    if (!items || !queryIsLive(session, model, token)) return { suggestions: [] };
    return {
      incomplete: true,
      suggestions: items.map((item) => ({
        label: item.label,
        detail: item.detail,
        kind: completionKind(item.detail),
        insertText: item.textEdit.newText,
        filterText: item.textEdit.newText,
        range: editorRange(item.textEdit.range),
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
      "textDocument/signatureHelp",
      { position: protocolPosition(position) },
      token,
    );
    if (!help || !queryIsLive(session, model, token)) return null;
    return {
      value: {
        ...help,
        signatures: help.signatures.map((signature) => ({
          ...signature,
          documentation: { value: signature.documentation },
        })),
      },
      dispose() {},
    };
  },
});
monaco.editor.registerCommand(
  "agi.binding",
  (_accessor, modelId: string, action: "open" | "rename", info: BindingInfo) => {
    const registration = [...registrations.values()].find((entry) => entry.model.id === modelId);
    if (registration && stillCurrent(registration)) registration.onBinding?.(info, action);
  },
);
monaco.languages.registerHoverProvider(LOGIC_LANGUAGE_ID, {
  async provideHover(model, position, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    if (session.registration.onBinding) {
      const info = await queryWorker(
        session.registration,
        "agi/bindingInfo",
        { position: protocolPosition(position) },
        token,
      );
      if (!queryIsLive(session, model, token)) return null;
      if (info) {
        const link = (action: "open" | "rename") =>
          `command:agi.binding?${encodeURIComponent(JSON.stringify([model.id, action, info]))}`;
        return {
          contents: [
            {
              value: `${info.name} · ${info.kind.toUpperCase()} ${info.num} · used in ${info.uses.length} ${info.uses.length === 1 ? "place" : "places"}\n\n[Open](${link("open")}) · [Rename](${link("rename")})`,
              isTrusted: { enabledCommands: ["agi.binding"] },
            },
          ],
        };
      }
    }
    const hover = await queryWorker(
      session.registration,
      "textDocument/hover",
      { position: protocolPosition(position) },
      token,
    );
    if (!hover || !queryIsLive(session, model, token)) return null;
    return {
      range: editorRange(hover.range),
      contents: [{ value: hover.contents.value, isTrusted: false }],
    };
  },
});
monaco.languages.registerDefinitionProvider(LOGIC_LANGUAGE_ID, {
  async provideDefinition(model, position, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    if (session.registration.onBinding) {
      const info = await queryWorker(
        session.registration,
        "agi/bindingInfo",
        { position: protocolPosition(position) },
        token,
      );
      if (!queryIsLive(session, model, token)) return null;
      if (info) {
        const uri = monaco.Uri.from({
          scheme: "agi-binding",
          authority: encodeURIComponent(model.uri.toString()),
          path: `/${info.name}`,
        });
        let preview = session.registration.previews.get(uri.toString());
        const text =
          `${info.name} · ${info.kind.toUpperCase()} ${info.num}\n` +
          info.uses
            .map(
              (use) =>
                `${use.role} · ${use.key.replace(":", " ").toUpperCase()} · line ${use.range.start.line + 1}\n${use.text}`,
            )
            .join("\n");
        if (!preview) {
          preview = monaco.editor.createModel(text, "plaintext", uri);
          session.registration.previews.set(uri.toString(), preview);
        } else if (preview.getValue() !== text) preview.setValue(text);
        session.registration.bindingTargets.set(uri.toString(), info);
        return { uri, range: new monaco.Range(1, 1, 1, info.name.length + 1) };
      }
    }
    const definition = await queryWorker(
      session.registration,
      "textDocument/definition",
      { position: protocolPosition(position) },
      token,
    );
    if (!definition || !queryIsLive(session, model, token)) return null;
    if (session.registration.onBinding && definition.uri === "agi-project:///bindings.json")
      return null;
    return {
      uri: locationUri(session.registration, definition.uri),
      range: editorRange(definition.range),
    };
  },
});
monaco.languages.registerReferenceProvider(LOGIC_LANGUAGE_ID, {
  async provideReferences(model, position, context, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    const references = await queryWorker(
      session.registration,
      "textDocument/references",
      { position: protocolPosition(position), context },
      token,
    );
    if (!references || !queryIsLive(session, model, token)) return null;
    return references
      .filter(
        (entry) => !session.registration.onBinding || entry.uri !== "agi-project:///bindings.json",
      )
      .map((entry) => ({
        uri: locationUri(session.registration, entry.uri),
        range: editorRange(entry.range),
      }));
  },
});
monaco.languages.registerDocumentHighlightProvider(LOGIC_LANGUAGE_ID, {
  async provideDocumentHighlights(model, position, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    const highlights = await queryWorker(
      session.registration,
      "textDocument/documentHighlight",
      { position: protocolPosition(position) },
      token,
    );
    if (!highlights || !queryIsLive(session, model, token)) return null;
    return highlights.map((entry) => ({ range: editorRange(entry.range), kind: entry.kind }));
  },
});
monaco.languages.registerRenameProvider(LOGIC_LANGUAGE_ID, {
  async resolveRenameLocation(model, position, token) {
    const session = openQuery(model, token);
    if (!session)
      return {
        range: new monaco.Range(1, 1, 1, 1),
        text: "",
        rejectReason: "Choose a defined name.",
      };
    let rejectReason = "Fix the source errors, then rename the name.";
    const prepared = await queryWorker(
      session.registration,
      "textDocument/prepareRename",
      { position: protocolPosition(position) },
      token,
      (message) => {
        rejectReason = message;
      },
    );
    if (!prepared || !queryIsLive(session, model, token))
      return {
        range: new monaco.Range(1, 1, 1, 1),
        text: "",
        rejectReason,
      };
    return { range: editorRange(prepared.range), text: prepared.placeholder };
  },
  async provideRenameEdits(model, position, newName, token) {
    const session = openQuery(model, token);
    if (!session) return { edits: [] };
    const edit = await queryWorker(
      session.registration,
      "textDocument/rename",
      { position: protocolPosition(position), newName },
      token,
    );
    if (!edit || !queryIsLive(session, model, token))
      return { edits: [], rejectReason: "Choose an unused name and fix the source errors." };
    if (
      session.registration.applyProjectEdit &&
      edit.documentChanges.some((change) => change.textDocument.uri !== model.uri.toString())
    ) {
      try {
        await session.registration.applyProjectEdit(edit, `Rename ${newName}`);
        return { edits: [] };
      } catch (cause) {
        return { edits: [], rejectReason: cause instanceof Error ? cause.message : String(cause) };
      }
    }
    return workspaceEdit(edit);
  },
});
monaco.languages.registerDocumentSymbolProvider(LOGIC_LANGUAGE_ID, {
  async provideDocumentSymbols(model, token) {
    const session = openQuery(model, token);
    if (!session) return [];
    const symbols = await queryWorker(
      session.registration,
      "textDocument/documentSymbol",
      {},
      token,
    );
    if (!symbols || !queryIsLive(session, model, token)) return [];
    return symbols.map((symbol) => ({
      name: symbol.name,
      detail: "",
      kind: symbol.kind - 1,
      tags: [],
      range: editorRange("range" in symbol ? symbol.range : symbol.location.range),
      selectionRange: editorRange(
        "selectionRange" in symbol ? symbol.selectionRange : symbol.location.range,
      ),
    }));
  },
});
monaco.languages.registerFoldingRangeProvider(LOGIC_LANGUAGE_ID, {
  async provideFoldingRanges(model, _context, token) {
    const session = openQuery(model, token);
    if (!session) return [];
    const ranges = await queryWorker(session.registration, "textDocument/foldingRange", {}, token);
    if (!ranges || !queryIsLive(session, model, token)) return [];
    return ranges.map((range) => ({
      start: range.startLine + 1,
      end: range.endLine + 1,
      kind: monaco.languages.FoldingRangeKind.Region,
    }));
  },
});
monaco.languages.registerCodeActionProvider(
  LOGIC_LANGUAGE_ID,
  {
    async provideCodeActions(model, range, context, token) {
      const session = openQuery(model, token);
      if (!session) return { actions: [], dispose() {} };
      const actions = await queryWorker(
        session.registration,
        "textDocument/codeAction",
        {
          range: protocolRange(range),
          context: { ...(context.only ? { only: [context.only] } : {}) },
        },
        token,
      );
      if (!actions || !queryIsLive(session, model, token)) return { actions: [], dispose() {} };
      return {
        actions: actions.map((action) => ({
          title: action.title,
          kind: action.kind,
          edit: workspaceEdit(action.edit),
        })),
        dispose() {},
      };
    },
  },
  { providedCodeActionKinds: ["quickfix", "refactor.rewrite"] },
);
monaco.languages.registerInlayHintsProvider(LOGIC_LANGUAGE_ID, {
  async provideInlayHints(model, range, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    const hints = await queryWorker(
      session.registration,
      "textDocument/inlayHint",
      { range: protocolRange(range) },
      token,
    );
    if (!hints || !queryIsLive(session, model, token)) return null;
    return {
      hints: hints.map((hint) => ({
        ...hint,
        position: new monaco.Position(hint.position.line + 1, hint.position.character + 1),
      })),
      dispose() {},
    };
  },
});
monaco.languages.registerDocumentSemanticTokensProvider(LOGIC_LANGUAGE_ID, {
  getLegend: () => SEMANTIC_LEGEND,
  async provideDocumentSemanticTokens(model, _lastResultId, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    const tokens = await queryWorker(
      session.registration,
      "textDocument/semanticTokens/full",
      {},
      token,
    );
    if (!tokens || !queryIsLive(session, model, token)) return null;
    return { data: new Uint32Array(tokens.data) };
  },
  releaseDocumentSemanticTokens() {},
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
  options: {
    readonly client: LogicAnalysisClient;
    readonly documentKey: string;
    readonly onBinding?: (info: BindingInfo, action: "open" | "rename") => void;
    readonly applyProjectEdit?: (edit: WorkspaceEdit, label: string) => Promise<void>;
  },
): LogicModelHandle {
  if (model.isDisposed()) throw new Error("Cannot register a disposed logic model.");
  const uri = model.uri.toString();
  options.client.setDocumentUri(options.documentKey, uri);
  registrations.get(uri)?.dispose();
  const registration: ModelRegistration = {
    model,
    client: options.client,
    documentKey: options.documentKey,
    applyProjectEdit: options.applyProjectEdit,
    onBinding: options.onBinding,
    previews: new Map(),
    bindingTargets: new Map(),
    disposed: false,
    dispose,
  };
  registrations.set(uri, registration);
  const modelDisposal = model.onWillDispose(dispose);
  const opener = monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource) {
      const binding = registration.bindingTargets.get(resource.toString());
      if (source?.getModel() === model && binding && registration.onBinding) {
        registration.onBinding(binding, "open");
        return true;
      }
      if (
        source?.getModel() !== model ||
        ![...registration.previews.values()].some(
          (preview) => preview.uri.toString() === resource.toString(),
        )
      )
        return false;
      source.trigger("agi-logic", "editor.action.peekDefinition", {});
      return true;
    },
  });
  const previewInvalidation = model.onDidChangeContent(() => {
    if (!registration.previews.size) return;
    for (const editor of monaco.editor.getEditors()) {
      if (editor.getModel() !== model) continue;
      editor
        .getContribution<
          monaco.editor.IEditorContribution & { closeWidget(focusEditor: boolean): void }
        >("editor.contrib.referencesController")
        ?.closeWidget(editor.hasWidgetFocus());
    }
    for (const preview of registration.previews.values()) preview.dispose();
    registration.previews.clear();
    registration.bindingTargets.clear();
  });

  async function refreshDiagnostics(): Promise<void> {
    if (activeRegistration(model) !== registration) return;
    const versionId = model.getVersionId();
    let result: LspOperations["textDocument/diagnostic"];
    try {
      result = await options.client.request(options.documentKey, "textDocument/diagnostic");
    } catch {
      // The consulted snapshot was replaced, the workspace closed or the
      // worker restarted; the host's next refresh carries the newer state.
      return;
    }
    if (!stillCurrent(registration) || model.getVersionId() !== versionId) return;
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      result.items.map((entry) => {
        const range = editorRange(entry.range);
        return {
          severity:
            entry.severity === 1 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
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
    opener.dispose();
    previewInvalidation.dispose();
    for (const preview of registration.previews.values()) preview.dispose();
    registration.previews.clear();
    registration.bindingTargets.clear();
    if (registrations.get(uri) === registration) {
      registrations.delete(uri);
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    }
  }

  return { refreshDiagnostics, dispose };
}
