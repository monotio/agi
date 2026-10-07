import { projectLabelContext } from "../../shell/projectLabelContext.ts";
import { documentLabel, numberedLabel } from "../../../../src/logic/numberedLabels.ts";
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
import "monaco-editor/editor/contrib/format/browser/formatActions.js";
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

import { createAnalysisSchedule } from "./analysisSchedule.ts";
import type { LogicAnalysisClient } from "./analysisClient.ts";
import type {
  LogicDebugState,
  LogicDebugValue,
  LspOperations,
  Range,
  WorkspaceEdit,
} from "../../../../src/logic/lspTypes.ts";
import { SEMANTIC_LEGEND } from "../../../../src/logic/lspTypes.ts";

import { MenuId, MenuRegistry } from "monaco-editor/platform/actions/common/actions.js";

import { ContextKeyExpr } from "monaco-editor/platform/contextkey/common/contextkey.js";

export { monaco };

const LOGIC_CONTEXT_MENU = new MenuId("agi.logicContext");

/** Keep menu presentation local to LOGIC; Monaco's keyboard commands remain registered. */
export function registerLogicContextMenu(
  editor: monaco.editor.IStandaloneCodeEditor,
  findReferences: () => Promise<void>,
): monaco.IDisposable {
  const menu = LOGIC_CONTEXT_MENU;
  // Monaco 0.57 exposes this getter to its context-menu contribution, but omits
  // it from the standalone construction options and public editor interface.
  Object.defineProperty(editor, "contextMenuId", { value: menu });
  const action = editor.addAction({
    id: "agi.findReferences",
    label: "Find references",
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
    run: findReferences,
  });
  const items = [
    ["editor.action.revealDefinition", "Go to definition", "1_navigation", 1],
    [`${editor.getId()}:agi.findReferences`, "Find references", "1_navigation", 2],
    ["editor.action.rename", "Rename…", "1_navigation", 3],
    ["editor.action.formatDocument", "Format document", "1_navigation", 4],
    ["editor.action.clipboardCutAction", "Cut", "9_clipboard", 1],
    ["editor.action.clipboardCopyAction", "Copy", "9_clipboard", 2],
    ["editor.action.clipboardPasteAction", "Paste", "9_clipboard", 3],
  ] as const;
  const entries = items.map(([id, title, group, order]) =>
    MenuRegistry.appendMenuItem(menu, {
      command: { id, title },
      group,
      order,
      when: ContextKeyExpr.equals("editorId", editor.getId()),
    }),
  );
  return {
    dispose() {
      for (const entry of entries) entry.dispose();
      action.dispose();
    },
  };
}

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
monaco.languages.setMonarchTokensProvider(LOGIC_LANGUAGE_ID, {
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/#(?:define|message)\b/, "keyword"],
      [/#.*$/, "comment"],
      [/"(?:[^"\\]|\\.)*\\?$/, "string"],
      [/"/, { token: "string.quote", next: "@string" }],
      [/\b(?:if|else|return|goto)\b/, "keyword"],
      [/\b[vfoismc]\d+\b/, "variable"],
      [/\b\d+\b/, "number"],
      [/[a-zA-Z_][\w.]*(?=\s*\()/, "type.identifier"],
      [/[a-zA-Z_][\w.]*/, "variable"],
      [/[{}()]/, "@brackets"],
      [/[=!<>+*&|-]+/, "operator"],
      [/[;,:]/, "delimiter"],
      [/\s+/, "white"],
    ],
    string: [
      [/\\(?:[\\"nrt]|x[0-9a-fA-F]{2})/, "string.escape"],
      [/[^"\\]+/, "string"],
      [/"/, { token: "string.quote", next: "@pop" }],
      [/\\./, "string.escape"],
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
  indentationRules: {
    increaseIndentPattern: /^((?!\/\/).)*\{\s*(?:\/\/.*)?$/,
    decreaseIndentPattern: /^\s*\}/,
  },
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

export interface PausedLogicState extends LogicDebugState {
  readonly epoch: number;
  readonly stopId: number;
}
interface DebugValueOptions {
  readonly debugState?: (() => PausedLogicState | undefined) | undefined;
  readonly onDebugValue?:
    | ((
        value: LogicDebugValue,
        state: PausedLogicState,
        position: monaco.IPosition,
      ) => Promise<void>)
    | undefined;
}
interface ModelRegistration {
  readonly model: monaco.editor.ITextModel;
  readonly client: LogicAnalysisClient;
  readonly documentKey: string;
  readonly debugState: DebugValueOptions["debugState"];
  readonly onDebugValue: DebugValueOptions["onDebugValue"];
  debugRevision: number;
  readonly applyProjectEdit: ((edit: WorkspaceEdit, label: string) => Promise<void>) | undefined;
  readonly onBinding: ((info: BindingInfo, action: "open" | "rename") => void) | undefined;
  readonly onResource: ((key: string) => void) | undefined;
  readonly onFormat: (() => void) | undefined;
  readonly bindingTargets: Map<string, BindingInfo>;
  readonly previews: Map<string, monaco.editor.ITextModel>;
  waitForAnalysis(): Promise<void>;
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
  const labels = projectLabelContext({
    bindings: registration.client.documentSource("agi-project:///bindings.json") ?? "{}",
  });
  if (uri === registration.model.uri.toString()) return registration.model.uri;
  const resource = /^agi-resource:\/\/\/(logic|picture|view|sound)\/(\d+)$/.exec(uri);
  const source =
    registration.client.documentSource(uri) ??
    (resource ? numberedLabel(resource[1]!, Number(resource[2]), labels, "row") : undefined);
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
        path: resource ? `/resource${target.path}` : `/${target.path.split("/").at(-1)}`,
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
  readonly debugRevision: number;
}

function openQuery(
  model: monaco.editor.ITextModel,
  token: monaco.CancellationToken,
): LiveQuery | undefined {
  const registration = activeRegistration(model);
  if (!registration || token.isCancellationRequested) return undefined;
  return {
    registration,
    versionId: model.getVersionId(),
    debugRevision: registration.debugRevision,
  };
}

function queryIsLive(
  session: LiveQuery,
  model: monaco.editor.ITextModel,
  token: monaco.CancellationToken,
): boolean {
  return (
    stillCurrent(session.registration) &&
    model.getVersionId() === session.versionId &&
    session.registration.debugRevision === session.debugRevision &&
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
        ...(item.sortText ? { sortText: item.sortText } : {}),
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
monaco.editor.registerCommand(
  "agi.nameOperand",
  (_accessor, modelId: string, position: monaco.IPosition) => {
    const registration = [...registrations.values()].find((entry) => entry.model.id === modelId);
    if (!registration || !stillCurrent(registration)) return;
    const editor = monaco.editor
      .getEditors()
      .find((editor) => editor.getModel() === registration.model);
    editor?.setPosition(position);
    editor?.focus();
    editor?.trigger("agi-logic", "editor.action.rename", {});
  },
);
monaco.editor.registerCommand(
  "agi.debugValue",
  async (
    _accessor,
    modelId: string,
    epoch: number,
    stopId: number,
    value: LogicDebugValue,
    position: monaco.IPosition,
  ) => {
    const registration = [...registrations.values()].find((entry) => entry.model.id === modelId);
    const state = registration?.debugState?.();
    if (
      !registration ||
      !stillCurrent(registration) ||
      !state ||
      state.epoch !== epoch ||
      state.stopId !== stopId
    )
      return;
    await registration.onDebugValue?.(value, state, position);
  },
);
monaco.languages.registerHoverProvider(LOGIC_LANGUAGE_ID, {
  async provideHover(model, position, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    const hover = await queryWorker(
      session.registration,
      "textDocument/hover",
      { position: protocolPosition(position), debugState: session.registration.debugState?.() },
      token,
    );
    if (!hover || !queryIsLive(session, model, token)) return null;
    const paused = session.registration.debugState?.();
    let markdown = hover.contents.value;
    if (hover.debugValue && paused && session.registration.onDebugValue) {
      const command = `command:agi.debugValue?${encodeURIComponent(JSON.stringify([model.id, paused.epoch, paused.stopId, hover.debugValue, position]))}`;
      markdown = markdown.replace(
        /^```agi\n([^\n]+) = ([^\n]+)\n```/,
        (_match, label: string, value: string) => `\`${label}\` [= ${value}](${command})`,
      );
    }
    const contents: monaco.IMarkdownString[] = [
      {
        value: markdown.replace(
          "Rename… F2",
          `[Rename…](command:agi.nameOperand?${encodeURIComponent(JSON.stringify([model.id, position]))}) F2`,
        ),
        isTrusted: { enabledCommands: ["agi.nameOperand", "agi.debugValue"] },
      },
    ];
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
        contents.push({
          value: `[Open](${link("open")})`,
          isTrusted: { enabledCommands: ["agi.binding"] },
        });
      }
    }
    return {
      range: editorRange(hover.range),
      contents,
    };
  },
});
monaco.languages.registerDefinitionProvider(LOGIC_LANGUAGE_ID, {
  async provideDefinition(model, position, token) {
    const session = openQuery(model, token);
    if (!session) return null;
    const definition = await queryWorker(
      session.registration,
      "textDocument/definition",
      { position: protocolPosition(position) },
      token,
    );
    if (!definition || !queryIsLive(session, model, token)) return null;
    if (
      session.registration.onBinding &&
      !Array.isArray(definition) &&
      definition.uri === "agi-project:///bindings.json"
    ) {
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
        const labels = projectLabelContext({
          bindings:
            session.registration.client.documentSource("agi-project:///bindings.json") ?? "{}",
        });
        const text =
          `${numberedLabel(info.kind, info.num, { name: info.name }, "row")}\n` +
          info.uses
            .map(
              (use) =>
                `${use.role} · ${documentLabel(use.key, labels)} · line ${use.range.start.line + 1}\n${use.text}`,
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
    const locations = Array.isArray(definition) ? definition : [definition];
    return locations.map((entry) => ({
      uri: locationUri(session.registration, entry.uri),
      range: editorRange(entry.range),
    }));
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
monaco.languages.registerDocumentFormattingEditProvider(LOGIC_LANGUAGE_ID, {
  async provideDocumentFormattingEdits(model, options, token) {
    const session = openQuery(model, token);
    if (!session) return [];
    const edits = await queryWorker(
      session.registration,
      "textDocument/formatting",
      { options },
      token,
    );
    if (!edits || !queryIsLive(session, model, token)) return [];
    if (edits.length) session.registration.onFormat?.();
    return edits.map((edit) => ({ range: editorRange(edit.range), text: edit.newText }));
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
    let rejectReason = "Choose an unused name and fix the source errors.";
    const edit = await queryWorker(
      session.registration,
      "textDocument/rename",
      { position: protocolPosition(position), newName },
      token,
      (message) => {
        rejectReason = message;
      },
    );
    if (!edit || !queryIsLive(session, model, token)) return { edits: [], rejectReason };
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
monaco.editor.registerCommand(
  "agi.applyProjectQuickFix",
  async (_accessor, apply: () => Promise<void>) => apply(),
);
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
        actions: actions.map((action) => {
          const apply = session.registration.applyProjectEdit;
          if (
            apply &&
            action.edit.documentChanges.some(
              (change) => change.textDocument.uri !== model.uri.toString(),
            )
          )
            return {
              title: action.title,
              kind: action.kind,
              command: {
                id: "agi.applyProjectQuickFix",
                title: action.title,
                arguments: [
                  async () => {
                    if (
                      !stillCurrent(session.registration) ||
                      model.getVersionId() !== session.versionId
                    )
                      throw new Error("The source changed. Open Quick Fix again.");
                    await session.registration.waitForAnalysis();
                    const current = await session.registration.client.request(
                      session.registration.documentKey,
                      "textDocument/codeAction",
                      { range: protocolRange(range) },
                    );
                    if (
                      !stillCurrent(session.registration) ||
                      model.getVersionId() !== session.versionId ||
                      !current.some(
                        (fix) =>
                          fix.title === action.title &&
                          JSON.stringify(fix.edit) === JSON.stringify(action.edit),
                      )
                    )
                      throw new Error("The project changed. Open Quick Fix again.");
                    await apply(action.edit, action.title);
                  },
                ],
              },
            };
          return {
            title: action.title,
            kind: action.kind,
            edit: workspaceEdit(action.edit),
          };
        }),
        dispose() {},
      };
    },
  },
  { providedCodeActionKinds: ["quickfix", "refactor.rewrite"] },
);
const inlayListeners = new Set<() => void>();
monaco.languages.registerInlayHintsProvider(LOGIC_LANGUAGE_ID, {
  onDidChangeInlayHints(listener) {
    inlayListeners.add(listener);
    return {
      dispose() {
        inlayListeners.delete(listener);
      },
    };
  },
  async provideInlayHints(model, range, token) {
    for (;;) {
      const session = openQuery(model, token);
      if (!session) return null;
      const hints = await queryWorker(
        session.registration,
        "textDocument/inlayHint",
        { range: protocolRange(range), debugState: session.registration.debugState?.() },
        token,
      );
      // Monaco subscribes to provider updates after the first answer. A pause
      // arriving during that request must be reflected in the answer itself.
      if (
        stillCurrent(session.registration) &&
        model.getVersionId() === session.versionId &&
        !token.isCancellationRequested &&
        session.registration.debugRevision !== session.debugRevision
      )
        continue;
      if (!hints || !queryIsLive(session, model, token)) return null;
      return {
        hints: hints.map((hint) => ({
          ...hint,
          position: new monaco.Position(hint.position.line + 1, hint.position.character + 1),
        })),
        dispose() {},
      };
    }
  },
});
const semanticListeners = new Set<() => void>();
function cancelledTokens(): never {
  const error = new Error("Canceled");
  error.name = "Canceled";
  throw error;
}
monaco.languages.registerDocumentSemanticTokensProvider(LOGIC_LANGUAGE_ID, {
  onDidChange(listener) {
    semanticListeners.add(listener);
    return {
      dispose: () => {
        semanticListeners.delete(listener);
      },
    };
  },
  getLegend: () => SEMANTIC_LEGEND,
  async provideDocumentSemanticTokens(model, _lastResultId, token) {
    const session = openQuery(model, token);
    if (!session) return cancelledTokens();
    await session.registration.waitForAnalysis();
    if (!queryIsLive(session, model, token)) return cancelledTokens();
    const tokens = await queryWorker(
      session.registration,
      "textDocument/semanticTokens/full",
      {},
      token,
    );
    if (!tokens || !queryIsLive(session, model, token)) return cancelledTokens();
    return { data: new Uint32Array(tokens.data) };
  },
  releaseDocumentSemanticTokens() {},
});

export interface LogicModelHandle {
  refreshDebug(): void;
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
 * current through changeDocument while typing and setProject for saved context.
 * Registering a second model for the same URI retires the earlier handle.
 */
export function registerLogicModel(
  model: monaco.editor.ITextModel,
  options: DebugValueOptions & {
    readonly client: LogicAnalysisClient;
    readonly documentKey: string;
    readonly onBinding?: (info: BindingInfo, action: "open" | "rename") => void;
    readonly onResource?: (key: string) => void;
    readonly onFormat?: () => void;
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
    debugState: options.debugState,
    onDebugValue: options.onDebugValue,
    debugRevision: 0,
    applyProjectEdit: options.applyProjectEdit,
    onBinding: options.onBinding,
    onResource: options.onResource,
    onFormat: options.onFormat,
    previews: new Map(),
    bindingTargets: new Map(),
    waitForAnalysis: () => analysisSchedule.settled(),
    disposed: false,
    dispose,
  };
  const analysisSchedule = createAnalysisSchedule(() => {
    for (const listener of semanticListeners) listener();
    for (const listener of inlayListeners) listener();
    void refreshDiagnostics();
  });
  const unsubscribe = options.client.onDidChange(() => {
    // The client invalidates changed inputs. Marker updates preserve matching
    // language queries; only refreshDebug changes their debugger generation.
    analysisSchedule.schedule();
  });
  registrations.set(uri, registration);
  const modelDisposal = model.onWillDispose(dispose);
  const opener = monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource) {
      if (source?.getModel() === model && registration.onResource) {
        const target = /^agi-resource:\/\/\/(logic|picture|view|sound)\/(\d+)$/.exec(
          resource.toString(),
        );
        if (target) {
          registration.onResource(`${target[1]}:${target[2]}`);
          return true;
        }
        if (
          resource.toString() === "agi-project:///OBJECT.json" ||
          registration.previews.get("agi-project:///OBJECT.json")?.uri.toString() ===
            resource.toString()
        ) {
          registration.onResource("inventory");
          return true;
        }
        const entry = [...registration.previews].find(
          ([, preview]) => preview.uri.toString() === resource.toString(),
        );
        const previewTarget =
          entry && /^agi-resource:\/\/\/(logic|picture|view|sound)\/(\d+)$/.exec(entry[0]);
        if (previewTarget) {
          registration.onResource(`${previewTarget[1]}:${previewTarget[2]}`);
          return true;
        }
      }
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
    unsubscribe();
    analysisSchedule.dispose();
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

  return {
    refreshDiagnostics,
    dispose,
    refreshDebug() {
      registration.debugRevision++;
      for (const listener of inlayListeners) listener();
    },
  };
}
