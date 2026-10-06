import type { BindingInfo } from "./projectNames.ts";

/** Structural LSP 3.17 types used by the transport-free LOGIC server. */
export const SEMANTIC_LEGEND = {
  tokenTypes: ["keyword", "function", "variable", "number", "string", "operator", "comment"],
  tokenModifiers: [],
};

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Location {
  uri: string;
  range: Range;
}
interface TextEdit {
  range: Range;
  newText: string;
}
interface Diagnostic {
  range: Range;
  severity: number;
  source: string;
  message: string;
}
export interface WorkspaceEdit {
  documentChanges: { textDocument: { uri: string; version: number | null }; edits: TextEdit[] }[];
}
export interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
}
interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
}
interface CompletionItem {
  label: string;
  detail: string;
  textEdit: TextEdit;
}
interface SignatureHelp {
  signatures: { label: string; documentation: string; parameters: { label: string }[] }[];
  activeSignature: number;
  activeParameter: number;
}
interface Hover {
  contents: { kind: "markdown"; value: string };
  range: Range;
}
interface DocumentHighlight {
  range: Range;
  kind: number;
}
export interface FoldingRange {
  startLine: number;
  endLine: number;
  kind: string;
}
export interface SemanticTokens {
  data: number[];
}
interface CodeAction {
  title: string;
  kind: "quickfix" | "refactor.rewrite";
  diagnostics: Diagnostic[];
  edit: WorkspaceEdit;
}
interface DiagnosticReport {
  kind: "full";
  resultId: string;
  items: Diagnostic[];
}
export interface LspOperations {
  "agi/bindings": BindingInfo[];
  "agi/renameBinding": WorkspaceEdit;
  "agi/bindingInfo": BindingInfo | null;
  "textDocument/inlayHint": { position: Position; label: string; paddingLeft: boolean }[];
  "textDocument/completion": CompletionItem[] | null;
  "textDocument/signatureHelp": SignatureHelp | null;
  "textDocument/hover": Hover | null;
  "textDocument/definition": Location | Location[] | null;
  "textDocument/references": Location[] | null;
  "textDocument/prepareRename": { range: Range; placeholder: string } | null;
  "textDocument/rename": WorkspaceEdit | null;
  "textDocument/documentSymbol": DocumentSymbol[] | SymbolInformation[];
  "workspace/symbol": SymbolInformation[];
  "textDocument/documentHighlight": DocumentHighlight[];
  "textDocument/foldingRange": FoldingRange[];
  "textDocument/semanticTokens/full": SemanticTokens;
  "textDocument/semanticTokens/range": SemanticTokens;
  "textDocument/codeAction": CodeAction[];
  "textDocument/diagnostic": DiagnosticReport;
  "agi/compile": { payload: number[] };
}
export interface LspMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}
export interface LspResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}
export interface LspNotification {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
}

/** Build line starts once; subsequent positions search the line-offset table. */
export function createTextCoordinates(source: string) {
  const starts = [0];
  const ends: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "\r" && source[i] !== "\n") continue;
    ends.push(i);
    if (source[i] === "\r" && source[i + 1] === "\n") i++;
    starts.push(i + 1);
  }
  ends.push(source.length);
  function positionAt(offset: number): Position {
    offset = Math.max(0, Math.min(source.length, offset));
    // Both offsets inside a CRLF transition describe the next line's start.
    if (source[offset - 1] === "\r" && source[offset] === "\n") offset++;
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle;
    }
    return { line: low, character: offset - starts[low]! };
  }
  function offsetAt(position: Position): number {
    if (
      !Number.isSafeInteger(position.line) ||
      !Number.isSafeInteger(position.character) ||
      position.line < 0 ||
      position.character < 0
    )
      throw new RangeError("Invalid UTF-16 position.");
    const start = starts[position.line] ?? source.length;
    return Math.min(ends[position.line] ?? source.length, start + position.character);
  }
  function rangeAt(start: number, end: number): Range {
    return { start: positionAt(start), end: positionAt(end) };
  }
  return { positionAt, offsetAt, rangeAt };
}

// Bound retention to the most recently consulted document. Structure queries
// hold their own coordinates while visiting many tokens in that document.
let lastSource: string | undefined;
let lastCoordinates: ReturnType<typeof createTextCoordinates> | undefined;
function coordinates(source: string) {
  if (source !== lastSource || !lastCoordinates) {
    lastSource = source;
    lastCoordinates = createTextCoordinates(source);
  }
  return lastCoordinates;
}
/** UTF-16 code units, including CRLF, as required by LSP's default encoding. */
export function positionAt(source: string, offset: number): Position {
  return coordinates(source).positionAt(offset);
}
export function offsetAt(source: string, position: Position): number {
  return coordinates(source).offsetAt(position);
}
export function rangeAt(source: string, start: number, end: number): Range {
  return coordinates(source).rangeAt(start, end);
}
