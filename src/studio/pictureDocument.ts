/**
 * Room Studio picture document: picture source text whose objects are
 * structured comments, so annotations never change the compiled bytes.
 *
 *   # @item <id> "<label>" [art|depth|walk|mixed] [locked]   opens an item
 *   # @end                                                   closes it
 *
 * Items are flat and cover consecutive source lines; lines outside items are
 * loose. A malformed directive is reported and otherwise read as a plain
 * comment, as is the `@end` of a rejected `@item`.
 *
 * Several items become one ("Make one item") only as a run of neighbours:
 * one `@item` over their lines, so the commands keep their draw order and
 * the bytes never change. Items drawn between them, or loose commands, would
 * have to move in the draw order (changing the picture) or join without
 * being chosen, so `itemRun` names them and the edit refuses (see the
 * `combineItems` operation in editOperations.ts).
 */

export type PictureItemKind = "art" | "depth" | "walk" | "mixed";

export const PICTURE_ITEM_KINDS: readonly PictureItemKind[] = ["art", "depth", "walk", "mixed"];

export interface PictureItem {
  readonly id: string;
  readonly label: string;
  readonly kind: PictureItemKind;
  readonly locked: boolean;
  /** 1-based line of the `@item` directive. */
  readonly openLine: number;
  /** 1-based line of the `@end`; one past the last line when unterminated. */
  readonly closeLine: number;
  /** 1-based lines strictly between open and close that hold a command. */
  readonly commandLines: readonly number[];
}

export interface PictureDocument {
  /** The source lines verbatim (split on "\n"; a "\r" stays on its line). */
  readonly lines: readonly string[];
  readonly items: readonly PictureItem[];
}

export type StudioDiagnosticCode =
  | "bad-directive"
  | "bad-id"
  | "bad-label"
  | "duplicate-id"
  | "nested-item"
  | "unmatched-end"
  | "unterminated-item";

export interface StudioDiagnostic {
  /** 1-based source line. */
  readonly line: number;
  readonly code: StudioDiagnosticCode;
  readonly message: string;
  /** The item or rule id the diagnostic names, when it names one. */
  readonly id?: string;
}

export const PICTURE_ITEM_ID = /^[a-z][a-z0-9_-]{0,31}$/;

const DIRECTIVE = /^#\s*@(item|end)(?=\s|$)(.*)$/;
const LABEL = /^"(?:[^"\\]|\\.)*"/;

/** The line with its comment and surrounding whitespace removed. */
export function pictureCommandText(line: string): string {
  const hash = line.indexOf("#");
  return (hash >= 0 ? line.slice(0, hash) : line).trim();
}

type Directive =
  | { type: "end"; error?: string }
  | { type: "item"; id: string; label: string; kind: PictureItemKind; locked: boolean }
  | { type: "item"; error: string; code: StudioDiagnosticCode };

/** Whether the line is an `@item`/`@end` directive, well-formed or not. */
export function isPictureDirective(line: string): boolean {
  return DIRECTIVE.test(line.trim());
}

/** Parse a directive line, or undefined for a line that is not one. */
function readDirective(line: string): Directive | undefined {
  const match = DIRECTIVE.exec(line.trim());
  if (!match) return undefined;
  const rest = match[2]!.trim();
  if (match[1] === "end") {
    return rest.length === 0 ? { type: "end" } : { type: "end", error: `unexpected '${rest}'` };
  }
  const [id = ""] = rest.split(/\s+/);
  if (!PICTURE_ITEM_ID.test(id)) {
    return {
      type: "item",
      code: "bad-id",
      error: `item id '${id}' must match ${PICTURE_ITEM_ID.source}`,
    };
  }
  const tail = rest.slice(id.length).trimStart();
  const quoted = LABEL.exec(tail);
  let label: unknown;
  try {
    label = quoted ? JSON.parse(quoted[0]) : undefined;
  } catch {
    label = undefined;
  }
  if (typeof label !== "string" || label.trim().length === 0) {
    return {
      type: "item",
      code: "bad-label",
      error: `item '${id}' needs a non-empty double-quoted label`,
    };
  }
  const flags = tail.slice(quoted![0].length).trim();
  const words = flags.length > 0 ? flags.split(/\s+/) : [];
  let kind: PictureItemKind = "mixed";
  if (words.length > 0 && (PICTURE_ITEM_KINDS as readonly string[]).includes(words[0]!)) {
    kind = words.shift() as PictureItemKind;
  }
  const locked = words[0] === "locked";
  if (locked) words.shift();
  if (words.length > 0) {
    return {
      type: "item",
      code: "bad-directive",
      error: `item '${id}': unexpected '${words.join(" ")}' (expected ${PICTURE_ITEM_KINDS.join("|")} then 'locked')`,
    };
  }
  return { type: "item", id, label, kind, locked };
}

/** Parse picture source into its items. Never throws; bad directives become diagnostics. */
export function parsePictureDocument(source: string): {
  document: PictureDocument;
  diagnostics: StudioDiagnostic[];
} {
  const lines = source.split("\n");
  const items: PictureItem[] = [];
  const diagnostics: StudioDiagnostic[] = [];
  const seen = new Set<string>();
  let open: Omit<PictureItem, "closeLine" | "commandLines"> | null = null;
  let commandLines: number[] = [];
  /** A rejected `@item` swallows the next `@end` so one mistake gives one diagnostic. */
  let rejectedOpen = false;
  const report = (line: number, code: StudioDiagnosticCode, message: string, id?: string): void => {
    diagnostics.push(id === undefined ? { line, code, message } : { line, code, message, id });
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]!;
    const directive = readDirective(line);
    if (directive?.type === "item") {
      if (open !== null) {
        report(lineNo, "nested-item", `items do not nest; '${open.id}' is still open`, open.id);
      } else if ("error" in directive) {
        report(lineNo, directive.code, directive.error);
        rejectedOpen = true;
      } else if (seen.has(directive.id)) {
        report(lineNo, "duplicate-id", `item id '${directive.id}' is already used`, directive.id);
        rejectedOpen = true;
      } else {
        seen.add(directive.id);
        const { id, label, kind, locked } = directive;
        open = { id, label, kind, locked, openLine: lineNo };
        rejectedOpen = false;
      }
      continue;
    }
    if (directive?.type === "end") {
      if (directive.error !== undefined) {
        report(lineNo, "bad-directive", `@end: ${directive.error}`);
      } else if (open !== null) {
        items.push({ ...open, closeLine: lineNo, commandLines });
        open = null;
        commandLines = [];
      } else if (rejectedOpen) {
        rejectedOpen = false;
      } else {
        report(lineNo, "unmatched-end", "@end without an open item");
      }
      continue;
    }
    if (open !== null && pictureCommandText(line).length > 0) commandLines.push(lineNo);
  }
  if (open !== null) {
    const { id, openLine } = open;
    report(
      openLine,
      "unterminated-item",
      `item '${id}' has no @end; it closes at the end of the file`,
      id,
    );
    items.push({ ...open, closeLine: lines.length + 1, commandLines });
  }
  return { document: { lines, items }, diagnostics };
}

/** The document's source text; the exact original text when nothing was edited. */
export function serializePictureDocument(document: PictureDocument): string {
  return document.lines.join("\n");
}

/** The item whose body holds 1-based `line`, if any. */
export function pictureItemAtLine(
  document: PictureDocument,
  line: number,
): PictureItem | undefined {
  return document.items.find((item) => item.openLine < line && line < item.closeLine);
}

/** Where items to be made one lie in the draw order, and what breaks their run. */
export interface ItemRun {
  /** The members in draw order. */
  readonly members: readonly PictureItem[];
  /** Items drawn between the first and last member that are not members. */
  readonly between: readonly PictureItem[];
  /** 1-based loose lines holding a command between the first and last member. */
  readonly looseCommands: readonly number[];
}

/**
 * The run from the first to the last of `ids` in draw order, and what lies
 * between them that is not one of them. Ids the document lacks are skipped.
 */
export function itemRun(document: PictureDocument, ids: readonly string[]): ItemRun {
  const chosen = new Set(ids);
  const members = document.items.filter((item) => chosen.has(item.id));
  const first = members[0];
  const last = members.at(-1);
  if (!first || !last) return { members, between: [], looseCommands: [] };
  const between = document.items.filter(
    (item) =>
      !chosen.has(item.id) && item.openLine > first.openLine && item.openLine < last.openLine,
  );
  const looseCommands: number[] = [];
  for (let line = first.closeLine + 1; line < last.openLine; line++) {
    const text = document.lines[line - 1] ?? "";
    if (!pictureItemAtLine(document, line) && !isPictureDirective(text))
      if (pictureCommandText(text).length > 0) looseCommands.push(line);
  }
  return { members, between, looseCommands };
}
