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
  kind: "quickfix";
  diagnostics: Diagnostic[];
  edit: WorkspaceEdit;
}
interface DiagnosticReport {
  kind: "full";
  resultId: string;
  items: Diagnostic[];
}
export interface LspOperations {
  "textDocument/completion": CompletionItem[] | null;
  "textDocument/signatureHelp": SignatureHelp | null;
  "textDocument/hover": Hover | null;
  "textDocument/definition": Location | null;
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

/** UTF-16 code units, including CRLF, as required by LSP's default encoding. */
export function positionAt(source: string, offset: number): Position {
  offset = Math.max(0, Math.min(source.length, offset));
  let line = 0;
  let start = 0;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\r" || source[i] === "\n") {
      if (source[i] === "\r" && source[i + 1] === "\n" && i + 1 < offset) i++;
      line++;
      start = i + 1;
    }
  }
  return { line, character: offset - start };
}
export function offsetAt(source: string, position: Position): number {
  if (
    !Number.isSafeInteger(position.line) ||
    !Number.isSafeInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  )
    throw new RangeError("Invalid UTF-16 position.");
  let start = 0;
  let line = 0;
  while (line < position.line && start < source.length) {
    const ch = source[start++];
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && source[start] === "\n") start++;
      line++;
    }
  }
  let end = start;
  while (end < source.length && source[end] !== "\r" && source[end] !== "\n") end++;
  return Math.min(end, start + position.character);
}
export function rangeAt(source: string, start: number, end: number): Range {
  return { start: positionAt(source, start), end: positionAt(source, end) };
}
