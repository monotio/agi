/** One document store and LSP implementation for stdio and Studio workers. */
import { createProjectLogicLanguageSnapshot } from "../authoring/projectLanguage.ts";
import { compileProjectLogic } from "../authoring/projectLogic.ts";
import { PROFILES } from "../runtime/profile.ts";
import type { ProfileId } from "../runtime/profile.ts";
import { analyzeLogicSyntax, scanLogicTokens } from "./syntax.ts";
import { createLogicLanguageStructure } from "./languageStructure.ts";
import { projectBindingInfos } from "./projectNames.ts";
import { messageCodeActions, messageInlayHints } from "./messageReadability.ts";
import { OPERAND_NAMES, type NumberedOperand } from "./languageOperands.ts";
import { offsetAt, positionAt, rangeAt, SEMANTIC_LEGEND } from "./lspTypes.ts";
import type {
  LspMessage,
  LspResponse,
  LspNotification,
  Position,
  Range,
  Location,
  WorkspaceEdit,
} from "./lspTypes.ts";

export interface LogicLanguageProject {
  readonly profileId: ProfileId;
  readonly words: readonly (readonly [string, number])[];
  readonly objects?: readonly string[];
  readonly bindings: Readonly<Record<string, { readonly num: number; readonly kind?: string }>>;
  readonly documents: Readonly<
    Record<string, { readonly source: string; readonly version?: number; readonly uri?: string }>
  >;
  readonly bindingDocument?: { readonly uri: string; readonly source: string };
}
interface Document {
  uri: string;
  source: string;
  version: number | null;
}
interface Params {
  textDocument: { uri: string; languageId?: string; version: number; text: string };
  position: Position;
  context?: { includeDeclaration?: boolean; only?: string[] };
  query?: string;
  newName: string;
  name?: string;
  range?: Range;
  contentChanges: { text: string; range?: Range; rangeLength?: number }[];
  settings?: { agiLogic?: { project: LogicLanguageProject } };
  id?: string | number;
  previousResultId?: string;
  capabilities?: {
    textDocument?: { documentSymbol?: { hierarchicalDocumentSymbolSupport?: boolean } };
  };
}
const defaultProject: LogicLanguageProject = {
  profileId: "2.936",
  words: [],
  bindings: {},
  documents: {},
};

export function createLogicLspServer(
  options: {
    version?: string;
    project?: LogicLanguageProject;
    publish?: (message: LspNotification) => void;
  } = {},
) {
  let project = defaultProject;
  let revision = 0;
  let hierarchicalSymbols = true;
  const open = new Map<string, Document>();
  const closed = new Map<string, Document>();
  const cache = new Map<string, ReturnType<typeof createProjectLogicLanguageSnapshot>>();
  const cancelled = new Set<string | number>();
  let bindingDocument = { uri: "agi-project:///bindings.json", source: "{}" };
  let bindingDeclarations: Record<string, unknown> = {};

  function setProject(input: LogicLanguageProject) {
    project = {
      profileId: input.profileId,
      objects: [...(input.objects ?? [])],
      words: input.words.map(([word, id]) => [word, id]),
      bindings: Object.fromEntries(
        Object.entries(input.bindings).map(([name, binding]) => [name, { ...binding }]),
      ),
      documents: Object.fromEntries(
        Object.entries(input.documents).map(([key, doc]) => [key, { ...doc }]),
      ),
      ...(input.bindingDocument ? { bindingDocument: { ...input.bindingDocument } } : {}),
    };
    if (!Object.hasOwn(PROFILES, project.profileId))
      throw new Error("Unknown interpreter profile.");
    closed.clear();
    for (const [key, doc] of Object.entries(project.documents)) {
      const uri = doc.uri ?? `agi-project:///logic.${key.slice(6)}.lgc`;
      closed.set(uri, { uri, source: doc.source, version: doc.version ?? null });
    }
    bindingDocument = input.bindingDocument ?? {
      uri: "agi-project:///bindings.json",
      source: JSON.stringify(project.bindings, null, 2),
    };
    try {
      const parsed: unknown = JSON.parse(bindingDocument.source);
      bindingDeclarations =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      // Numeric project inputs still support navigation when a declaration preview is invalid.
      bindingDeclarations = {};
    }
    revision++;
    cache.clear();
    for (const doc of open.values()) publish(doc);
  }
  function document(uri: string) {
    return open.get(uri) ?? closed.get(uri);
  }
  function language(doc: Document) {
    let result = cache.get(doc.uri);
    if (!result) {
      result = createProjectLogicLanguageSnapshot({
        source: doc.source,
        profile: PROFILES[project.profileId],
        dictionary: new Map(project.words),
        bindings: project.bindings,
        objects: project.objects ?? [],
      });
      cache.set(doc.uri, result);
    }
    return result;
  }
  function diagnostics(doc: Document) {
    return language(doc).diagnostics.map((entry) => ({
      range: rangeAt(doc.source, entry.start, entry.end),
      severity: entry.severity === "error" ? 1 : 2,
      source: "agi-logic",
      message: entry.message,
    }));
  }
  function publish(doc: Document) {
    if (!options.publish) return;
    options.publish({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: doc.uri,
        ...(doc.version !== null ? { version: doc.version } : {}),
        diagnostics: diagnostics(doc),
      },
    });
  }
  function allDocuments() {
    return [...new Map([...closed, ...open]).values()];
  }
  function location(doc: Document, start: number, end: number): Location {
    return { uri: doc.uri, range: rangeAt(doc.source, start, end) };
  }
  function bindingLocation(name: string): Location | null {
    const expression = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`);
    const found = expression.exec(bindingDocument.source);
    return found
      ? {
          uri: bindingDocument.uri,
          range: rangeAt(bindingDocument.source, found.index + 1, found.index + name.length + 1),
        }
      : null;
  }
  function references(doc: Document, offset: number, includeDeclaration = true): Location[] {
    const operand = language(doc).operandAt(offset);
    if (operand) {
      const identities = language(doc).operands.filter((entry) => entry.start === operand.start);
      const result: Location[] = [];
      const candidates = identities.every((entry) => entry.kind === "m") ? [doc] : allDocuments();
      if (includeDeclaration)
        for (const name of new Set(identities.flatMap(operandBindings))) {
          const declaration = bindingLocation(name);
          if (declaration) result.push(declaration);
        }
      for (const candidate of candidates) {
        const seen = new Set<number>();
        for (const entry of language(candidate).operands) {
          if (
            (includeDeclaration || !entry.declaration) &&
            identities.some(
              (identity) =>
                entry.kind === identity.kind &&
                entry.num === identity.num &&
                (identity.kind !== "m" || candidate.uri === doc.uri),
            ) &&
            !seen.has(entry.start)
          ) {
            result.push(location(candidate, entry.start, entry.end));
            seen.add(entry.start);
          }
        }
      }
      return result;
    }
    const definition = language(doc).definitionAt(offset);
    if (!definition) return [];
    if (definition.kind !== "binding")
      return language(doc)
        .referencesAt(offset)
        .filter(
          (entry) =>
            includeDeclaration || entry.start !== definition.start || entry.end !== definition.end,
        )
        .map((entry) => location(doc, entry.start, entry.end));
    const result: Location[] = [];
    const declaration = bindingLocation(definition.name);
    if (includeDeclaration && declaration) result.push(declaration);
    for (const candidate of allDocuments()) {
      const snapshot = language(candidate);
      const tokens = analyzeLogicSyntax(candidate.source).tokens;
      for (const token of tokens) {
        if (
          token.type === "ident" &&
          token.text === definition.name &&
          snapshot.definitionAt(token.start)?.kind === "binding"
        )
          result.push(location(candidate, token.start, token.end));
      }
    }
    return result;
  }

  function operandBindings(operand: NumberedOperand): string[] {
    if (operand.kind === "m") return [];
    return Object.entries(project.bindings)
      .filter(([name, binding]) => {
        if (binding.num !== operand.num) return false;
        const kind = OPERAND_NAMES[operand.kind].toLowerCase();
        const declaration = bindingDeclarations[name];
        if (
          binding.kind === kind ||
          (declaration &&
            typeof declaration === "object" &&
            "num" in declaration &&
            declaration.num === binding.num &&
            "kind" in declaration &&
            declaration.kind === kind)
        )
          return true;
        return allDocuments().some((candidate) =>
          language(candidate).operands.some(
            (entry) =>
              entry.bindingName === name &&
              entry.kind === operand.kind &&
              entry.num === operand.num,
          ),
        );
      })
      .map(([name]) => name);
  }
  function rename(doc: Document, offset: number, name: string): WorkspaceEdit {
    const snapshot = language(doc);
    const operand = snapshot.operandAt(offset);
    if (operand && !operand.name)
      throw new Error(
        "Numbered operands have fixed identities. Rename a named binding or #define instead.",
      );
    const definition = snapshot.definitionAt(offset);
    if (definition?.kind !== "binding")
      return {
        documentChanges: [
          {
            textDocument: { uri: doc.uri, version: doc.version },
            edits: snapshot.renameAt(offset, name).map((edit) => ({
              range: rangeAt(doc.source, edit.start, edit.end),
              newText: edit.text,
            })),
          },
        ],
      };
    return renameBinding(definition.name, name);
  }
  function renameBinding(bindingName: string, name: string): WorkspaceEdit {
    if (!Object.hasOwn(project.bindings, bindingName)) throw new Error("Choose an existing name.");
    const tokens = scanLogicTokens(name);
    if (
      tokens.length !== 2 ||
      tokens[0]?.type !== "ident" ||
      tokens[0].text !== name ||
      /^[vfomsiwc]\d+$/.test(name)
    )
      throw new Error("The new name is not a safe source identifier.");
    if (
      name !== bindingName &&
      (Object.hasOwn(project.bindings, name) ||
        allDocuments().some((candidate) =>
          analyzeLogicSyntax(candidate.source).definitions.some((entry) => entry.name === name),
        ))
    )
      throw new Error(`The name '${name}' already has a definition.`);
    // Rename follows the selected name's ownership, not its numbered identity.
    const targets: Location[] = [];
    const declaration = bindingLocation(bindingName);
    if (declaration) targets.push(declaration);
    for (const candidate of allDocuments()) {
      const snapshot = language(candidate);
      for (const token of analyzeLogicSyntax(candidate.source).tokens) {
        if (
          token.type === "ident" &&
          token.text === bindingName &&
          snapshot.definitionAt(token.start)?.kind === "binding"
        )
          targets.push(location(candidate, token.start, token.end));
      }
    }
    if (!targets.some((target) => target.uri === bindingDocument.uri))
      throw new Error("The binding definition cannot be edited.");
    const bindings = { ...project.bindings };
    const binding = bindings[bindingName]!;
    delete bindings[bindingName];
    bindings[name] = binding;
    const changes: WorkspaceEdit["documentChanges"] = [];
    for (const uri of new Set(targets.map((target) => target.uri))) {
      const candidate = document(uri);
      const edits = targets
        .filter((target) => target.uri === uri)
        .map((target) => ({ range: target.range, newText: name }));
      if (candidate) {
        let source = candidate.source;
        for (const edit of [...edits].reverse())
          source =
            source.slice(0, offsetAt(source, edit.range.start)) +
            name +
            source.slice(offsetAt(source, edit.range.end));
        const context = {
          profile: PROFILES[project.profileId],
          dictionary: new Map(project.words),
        };
        const before = compileProjectLogic(candidate.source, {
          ...context,
          bindings: project.bindings,
        }).assembly.payload;
        const after = compileProjectLogic(source, { ...context, bindings }).assembly.payload;
        if (before.length !== after.length || before.some((byte, index) => byte !== after[index]))
          throw new Error("Rename would change compiled game behavior.");
      }
      changes.push({ textDocument: { uri, version: candidate?.version ?? null }, edits });
    }
    return { documentChanges: changes };
  }
  function bindingInfos() {
    return projectBindingInfos({
      ...project,
      documents: Object.fromEntries(
        allDocuments().map((candidate) => {
          const key =
            Object.keys(project.documents).find(
              (key) =>
                (project.documents[key]!.uri ?? `agi-project:///logic.${key.slice(6)}.lgc`) ===
                candidate.uri,
            ) ?? candidate.uri;
          return [key, { source: candidate.source, uri: candidate.uri }];
        }),
      ),
    });
  }
  function dispatch(method: string, params: Params): unknown {
    if (method === "initialize") {
      hierarchicalSymbols =
        params.capabilities?.textDocument?.documentSymbol?.hierarchicalDocumentSymbolSupport ===
        true;
      return {
        capabilities: {
          positionEncoding: "utf-16",
          textDocumentSync: { openClose: true, change: 2 },
          completionProvider: { triggerCharacters: [".", '"', "#", "("] },
          signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
          inlayHintProvider: true,
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          renameProvider: { prepareProvider: true },
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          semanticTokensProvider: { legend: SEMANTIC_LEGEND, full: true, range: true },
          documentHighlightProvider: true,
          foldingRangeProvider: true,
          codeActionProvider: { codeActionKinds: ["quickfix", "refactor.rewrite"] },
          diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
        },
        serverInfo: { name: "agi-logic-language-server", version: options.version ?? "unknown" },
      };
    }
    if (method === "shutdown") return null;
    if (method === "agi/bindings") return bindingInfos();
    if (method === "agi/renameBinding") return renameBinding(params.name ?? "", params.newName);
    if (method === "workspace/symbol")
      return [
        ...Object.keys(project.bindings).flatMap((name) => {
          const target = bindingLocation(name);
          return target ? [{ name, kind: 14, location: target }] : [];
        }),
        ...allDocuments().flatMap((doc) =>
          createLogicLanguageStructure(doc.source).symbols.map((symbol) => ({
            name: symbol.name,
            kind: symbol.kind,
            location: { uri: doc.uri, range: symbol.selectionRange },
          })),
        ),
      ].filter((symbol) => symbol.name.toLowerCase().includes((params.query ?? "").toLowerCase()));
    if (
      ![
        "textDocument/completion",
        "textDocument/signatureHelp",
        "textDocument/hover",
        "textDocument/definition",
        "textDocument/references",
        "textDocument/prepareRename",
        "textDocument/rename",
        "textDocument/documentSymbol",
        "textDocument/documentHighlight",
        "textDocument/foldingRange",
        "textDocument/semanticTokens/full",
        "textDocument/semanticTokens/range",
        "textDocument/codeAction",
        "textDocument/diagnostic",
        "agi/compile",
        "agi/bindingInfo",
        "textDocument/inlayHint",
      ].includes(method)
    )
      throw new MethodError(method);
    const doc = document(params.textDocument?.uri);
    if (!doc) return null;
    // Structure and colour use the recoverable lexer independently of checking.
    switch (method) {
      case "textDocument/semanticTokens/full":
        return createLogicLanguageStructure(doc.source).semanticTokens();
      case "textDocument/semanticTokens/range":
        return createLogicLanguageStructure(doc.source).semanticTokens(params.range);
      case "textDocument/foldingRange":
        return createLogicLanguageStructure(doc.source).folding;
      case "textDocument/documentSymbol": {
        const symbols = createLogicLanguageStructure(doc.source).symbols;
        return hierarchicalSymbols
          ? symbols
          : symbols.map((symbol) => ({
              name: symbol.name,
              kind: symbol.kind,
              location: { uri: doc.uri, range: symbol.selectionRange },
            }));
      }
    }
    const snapshot = language(doc);
    const offset = params.position ? offsetAt(doc.source, params.position) : 0;
    switch (method) {
      case "textDocument/inlayHint":
        return messageInlayHints(doc.source, params.range);
      case "agi/bindingInfo": {
        const definition = snapshot.definitionAt(offset);
        if (definition?.kind !== "binding") return null;
        return bindingInfos().find((info) => info.name === definition.name) ?? null;
      }
      case "textDocument/completion":
        return snapshot.completeAt(offset).map((item) => ({
          label: item.label,
          detail: item.detail,
          textEdit: { range: rangeAt(doc.source, item.start, item.end), newText: item.text },
        }));
      case "textDocument/signatureHelp": {
        const help = snapshot.signatureAt(offset);
        if (!help) return null;
        const parameters = help.label
          .slice(help.label.indexOf("(") + 1, help.label.lastIndexOf(")"))
          .split(",")
          .map((label) => ({ label: label.trim() }))
          .filter((p) => p.label);
        return {
          signatures: [{ label: help.label, documentation: help.documentation, parameters }],
          activeSignature: 0,
          activeParameter: Math.min(help.activeParameter, Math.max(0, parameters.length - 1)),
        };
      }
      case "textDocument/hover": {
        const operand = snapshot.operandAt(offset);
        const count = operand ? references(doc, offset, false).length : 0;
        const names = operand
          ? [
              ...new Set([
                ...operandBindings(operand),
                ...(operand.kind === "m" ? [doc] : allDocuments()).flatMap((candidate) =>
                  language(candidate).operands.flatMap((entry) =>
                    entry.kind === operand.kind && entry.num === operand.num && entry.name
                      ? [entry.name]
                      : [],
                  ),
                ),
              ]),
            ].sort()
          : [];
        const hover =
          operand && !operand.name
            ? {
                start: operand.start,
                end: operand.end,
                text: `${OPERAND_NAMES[operand.kind]} ${operand.num}${names.length ? ` (${names.join(", ")})` : ""}\n\n${count} ${count === 1 ? "use" : "uses"} ${operand.kind === "m" ? "in this LOGIC" : "across the game"}.`,
              }
            : snapshot.hoverAt(offset);
        if (!hover) return null;
        const [head, ...rest] = hover.text.split("\n\n");
        return {
          contents: {
            kind: "markdown",
            value: `\`\`\`agi\n${head}\n\`\`\`${rest.length ? `\n\n${rest.join("\n\n")}` : ""}`,
          },
          range: rangeAt(doc.source, hover.start, hover.end),
        };
      }
      case "textDocument/definition": {
        const operand = snapshot.operandAt(offset);
        if (operand && !operand.name && operand.kind !== "m") {
          const name = operandBindings(operand)[0];
          return name ? bindingLocation(name) : null;
        }
        const definition = snapshot.definitionAt(offset);
        return !definition
          ? null
          : definition.kind === "binding"
            ? bindingLocation(definition.name)
            : location(doc, definition.start, definition.end);
      }
      case "textDocument/references":
        return references(doc, offset, params.context?.includeDeclaration !== false);
      case "textDocument/prepareRename": {
        const operand = snapshot.operandAt(offset);
        if (operand && !operand.name)
          throw new Error(
            "Numbered operands have fixed identities. Rename a named binding or #define instead.",
          );
        const at = analyzeLogicSyntax(doc.source).tokens.find(
          (token) => token.start <= offset && token.end > offset,
        );
        if (!at || !snapshot.definitionAt(offset)) return null;
        try {
          rename(doc, offset, at.text);
        } catch {
          return null;
        }
        return { range: rangeAt(doc.source, at.start, at.end), placeholder: at.text };
      }
      case "textDocument/rename":
        return rename(doc, offset, params.newName);
      case "textDocument/documentHighlight":
        return references(doc, offset)
          .filter((entry) => entry.uri === doc.uri)
          .map((entry) => ({ range: entry.range, kind: 1 }));
      case "textDocument/codeAction": {
        const start = params.range ? offsetAt(doc.source, params.range.start) : 0;
        const end = params.range ? offsetAt(doc.source, params.range.end) : doc.source.length;
        const fixes = snapshot
          .quickFixes()
          .filter((fix) => fix.diagnostic.start <= end && fix.diagnostic.end >= start)
          .map((fix) => ({
            title: fix.title,
            kind: "quickfix",
            diagnostics: [
              {
                range: rangeAt(doc.source, fix.diagnostic.start, fix.diagnostic.end),
                severity: fix.diagnostic.severity === "error" ? 1 : 2,
                source: "agi-logic",
                message: fix.diagnostic.message,
              },
            ],
            edit: {
              documentChanges: [
                {
                  textDocument: { uri: doc.uri, version: doc.version },
                  edits: fix.edits.map((edit) => ({
                    range: rangeAt(doc.source, edit.start, edit.end),
                    newText: edit.text,
                  })),
                },
              ],
            },
          }));
        return [
          ...fixes,
          ...messageCodeActions(doc.source, doc.uri, doc.version, start, end),
        ].filter(
          (action) =>
            !params.context?.only ||
            params.context.only.some(
              (kind) => kind === "" || action.kind === kind || action.kind.startsWith(`${kind}.`),
            ),
        );
      }
      case "textDocument/diagnostic": {
        const resultId = `${revision}:${doc.version}`;
        return params.previousResultId === resultId
          ? { kind: "unchanged", resultId }
          : { kind: "full", resultId, items: diagnostics(doc) };
      }
      case "agi/compile":
        return {
          payload: [
            ...compileProjectLogic(doc.source, {
              profile: PROFILES[project.profileId],
              dictionary: new Map(project.words),
              bindings: project.bindings,
            }).assembly.payload,
          ],
        };
      default:
        throw new MethodError(method);
    }
  }
  function notify(method: string, params: Params) {
    if (method === "$/cancelRequest") {
      if (params.id !== undefined) cancelled.add(params.id);
      return;
    }
    if (method === "workspace/didChangeConfiguration") {
      const input = params.settings?.agiLogic?.project;
      if (input) setProject(input);
      return;
    }
    if (method === "textDocument/didOpen") {
      const item = params.textDocument;
      if (
        !item ||
        (item.languageId !== "agi-logic" && !item.uri.endsWith(".lgc")) ||
        open.has(item.uri) ||
        !Number.isSafeInteger(item.version) ||
        typeof item.text !== "string"
      )
        return;
      const doc = { uri: item.uri, source: item.text, version: item.version };
      open.set(item.uri, doc);
      revision++;
      cache.delete(item.uri);
      publish(doc);
    } else if (method === "textDocument/didChange") {
      const doc = document(params.textDocument?.uri);
      if (
        !doc ||
        !Number.isSafeInteger(params.textDocument.version) ||
        (open.has(doc.uri) && params.textDocument.version <= (doc.version ?? -1)) ||
        !Array.isArray(params.contentChanges)
      )
        return;
      let source = doc.source;
      for (const change of params.contentChanges) {
        if (!change || typeof change.text !== "string") return;
        if (change.range) {
          try {
            const start = offsetAt(source, change.range.start);
            const end = offsetAt(source, change.range.end);
            if (
              end < start ||
              JSON.stringify(positionAt(source, start)) !== JSON.stringify(change.range.start) ||
              JSON.stringify(positionAt(source, end)) !== JSON.stringify(change.range.end) ||
              (change.rangeLength !== undefined && change.rangeLength !== end - start)
            )
              return;
            source = source.slice(0, start) + change.text + source.slice(end);
          } catch {
            return;
          }
        } else source = change.text;
      }
      doc.source = source;
      doc.version = params.textDocument.version;
      revision++;
      cache.delete(doc.uri);
      publish(doc);
    } else if (method === "textDocument/didClose") {
      const uri = params.textDocument?.uri;
      if (!open.delete(uri)) return;
      cache.delete(uri);
      options.publish?.({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: [] },
      });
    }
  }
  setProject(options.project ?? defaultProject);
  return {
    setProject,
    handle(message: LspMessage): LspResponse | undefined {
      if (message.id === undefined) {
        notify(message.method, (message.params ?? {}) as Params);
        return;
      }
      const identity = { jsonrpc: "2.0" as const, id: message.id };
      if (cancelled.delete(message.id))
        return { ...identity, error: { code: -32800, message: "Request cancelled." } };
      try {
        return { ...identity, result: dispatch(message.method, (message.params ?? {}) as Params) };
      } catch (error) {
        return {
          ...identity,
          error: {
            code:
              error instanceof MethodError ? -32601 : error instanceof RangeError ? -32602 : -32803,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}
class MethodError extends Error {
  constructor(method: string) {
    super(`Unknown method '${method}'.`);
  }
}
