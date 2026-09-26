/**
 * The segment machinery behind `editOperations.ts`: an edit is a list of
 * source lines (each remembering its input line) and seams, rendered with
 * `copy` ranges renumbered, each seam replaced by the state lines the lines
 * after it need, and checked to parse cleanly and compile.
 */

import type { AgiProfile } from "../runtime/profile.ts";
import { compilePictureSource, type PictureSourceSpan } from "../picture/source.ts";
import {
  isPictureDirective,
  parsePictureDocument,
  PICTURE_ITEM_ID,
  type PictureDocument,
  type PictureItem,
  type PictureItemKind,
} from "./pictureDocument.ts";
import {
  commandHead,
  drawStateBeforeLine,
  registersRead,
  restoreLines,
  type DrawState,
} from "./editState.ts";
import { copyRange, EditRefusal, withCopyRange } from "./editSource.ts";

export interface EditSuccess {
  readonly document: PictureDocument;
  /** 1-based lines of the new document that are new, rewritten or moved. */
  readonly changedLines: readonly number[];
}

/** A source line; `from` is its 1-based line in the input, absent for a new line. */
export interface Line {
  readonly text: string;
  readonly from?: number;
  readonly moved?: boolean;
}

/** A seam where the lines after it must see `expected` (up to the next `@end` for "item"). */
export interface Seam {
  readonly expected: DrawState;
  readonly scope: "item" | "document";
}

export type Slot = Line | Seam;

export const isLine = (slot: Slot): slot is Line => "text" in slot;

export interface Context {
  readonly document: PictureDocument;
  readonly lines: readonly string[];
  readonly profile: AgiProfile;
  /** "\r" when the document uses CRLF line endings. */
  readonly eol: string;
  readonly compiled: { readonly bytes: Uint8Array; readonly spans: readonly PictureSourceSpan[] };
}

/** The state the input document holds before 1-based `line`. */
export const stateBefore = (ctx: Context, line: number): DrawState =>
  drawStateBeforeLine(ctx.compiled, line, ctx.profile);

export const inputLines = (ctx: Context, first: number, last: number): Line[] =>
  ctx.lines.slice(first - 1, last).map((text, i) => ({ text, from: first + i }));

export const newLine = (ctx: Context, text: string): Line => ({ text: text + ctx.eol });

export const bodyOf = (ctx: Context, item: PictureItem): Line[] =>
  inputLines(ctx, item.openLine + 1, item.closeLine - 1);

export function directive(
  id: string,
  label: string,
  kind: PictureItemKind,
  locked: boolean,
): string {
  return `# @item ${id} ${JSON.stringify(label)} ${kind}${locked ? " locked" : ""}`;
}

export function findItem(ctx: Context, itemId: string): PictureItem {
  const item = ctx.document.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new EditRefusal(`no item '${itemId}'`);
  return item;
}

export function editableItem(ctx: Context, itemId: string): PictureItem {
  const item = findItem(ctx, itemId);
  if (item.locked) throw new EditRefusal(`item '${itemId}' is locked; unlock it first`);
  return item;
}

export function requireIntegers(values: Record<string, number>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isInteger(value)) throw new EditRefusal(`${name} must be an integer, got ${value}`);
  }
}

export function requireValue(name: string, value: number | null): void {
  if (value !== null && !(Number.isInteger(value) && value >= 0 && value <= 15)) {
    throw new EditRefusal(`${name} must be 0..15 or null, got ${value}`);
  }
}

export function requireNewItem(ctx: Context, id: string, label: string): void {
  if (!PICTURE_ITEM_ID.test(id)) {
    throw new EditRefusal(`item id '${id}' must match ${PICTURE_ITEM_ID.source}`);
  }
  if (ctx.document.items.some((item) => item.id === id)) {
    throw new EditRefusal(`item id '${id}' is already used`);
  }
  if (label.trim().length === 0) throw new EditRefusal("an item needs a non-empty label");
}

/** Refuse when a `copy` outside `item` reads its lines: the copy would follow the edit. */
export function refuseCopiesOf(ctx: Context, item: PictureItem, action: string): void {
  ctx.lines.forEach((text, i) => {
    const range = copyRange(text);
    if (!range || (item.openLine < i + 1 && i + 1 < item.closeLine)) return;
    if (item.commandLines.some((line) => range.from <= line && line <= range.to)) {
      throw new EditRefusal(
        `line ${i + 1} copies lines of item '${item.id}'; ${action} it would change that copy too. Replace the copy with the lines it expands to first`,
      );
    }
  });
}

/**
 * The new source lines, with every `copy` range renumbered to where its
 * lines went. Refuses when a range's lines were removed, split by inserted
 * lines or moved to or below the copy.
 */
function render(slots: readonly Slot[], ctx: Context): { lines: string[]; changed: number[] } {
  const entries = slots.filter(isLine);
  const lineOf = new Map<number, number>();
  entries.forEach((entry, i) => {
    if (entry.from !== undefined) lineOf.set(entry.from, i + 1);
  });
  const lines: string[] = [];
  const changed: number[] = [];
  entries.forEach((entry, i) => {
    let text = entry.text;
    const range = copyRange(text);
    if (range) {
      const start = lineOf.get(range.from);
      const span = range.to - range.from;
      let intact = start !== undefined && start + span < i + 1;
      for (let k = range.from; intact && k <= range.to; k++) {
        intact = lineOf.get(k) === start! + (k - range.from);
      }
      if (!intact) {
        throw new EditRefusal(
          `line ${i + 1} copies lines ${range.from}-${range.to}, which this edit would remove, split or move below it. Replace the copy with the lines it expands to first`,
        );
      }
      if (start !== range.from) text = withCopyRange(text, start!, start! + span);
    }
    lines.push(text);
    if (entry.from === undefined || entry.moved === true || text !== ctx.lines[entry.from - 1]) {
      changed.push(i + 1);
    }
  });
  return { lines, changed };
}

/** Replace each seam, in document order, with the state lines the lines after it need. */
function restoreSeams(slots: readonly Slot[], ctx: Context): Line[] {
  const out = [...slots];
  for (let at = out.findIndex((slot) => !isLine(slot)); at >= 0;) {
    const seam = out[at] as Seam;
    const { lines } = render(out, ctx);
    const lineNo = out.slice(0, at).filter(isLine).length + 1;
    // Only the lines above the seam: those below may not compile until it is restored.
    const compiled = compilePictureSource(lines.slice(0, lineNo - 1).join("\n"), {
      lenient: true,
      profile: ctx.profile,
    });
    const actual = drawStateBeforeLine(compiled, lineNo, ctx.profile);
    let following = lines.slice(lineNo - 1);
    if (seam.scope === "item") {
      const close = following.findIndex(isPictureDirective);
      following = following.slice(0, close < 0 ? following.length : close);
    }
    const needed = registersRead(following);
    const restore = restoreLines(actual, seam.expected, needed, ctx.profile);
    out.splice(at, 1, ...restore.map((text) => newLine(ctx, text)));
    at = out.findIndex((slot) => !isLine(slot));
  }
  return out as Line[];
}

/**
 * Refuse when a line whose bytes continue the command above it (a `raw`
 * continuation) would be separated from that command or lose it.
 */
function requireContinuations(entries: readonly Line[], ctx: Context): void {
  const { bytes, spans } = ctx.compiled;
  const lineOf = new Map<number, number>();
  entries.forEach((entry, i) => {
    if (entry.from !== undefined) lineOf.set(entry.from, i);
  });
  for (let k = 1; k < spans.length; k++) {
    const span = spans[k]!;
    if (bytes[span.start]! >= 0xf0) continue;
    const prev = spans[k - 1]!.line;
    const at = lineOf.get(span.line);
    const prevAt = lineOf.get(prev);
    if (at === undefined && prevAt === undefined) continue;
    const joined =
      at !== undefined &&
      prevAt !== undefined &&
      prevAt < at &&
      entries.slice(prevAt + 1, at).every((entry) => commandHead(entry.text) === "");
    if (!joined) {
      throw new EditRefusal(
        `line ${span.line} continues the command on line ${prev}; this edit would separate them`,
      );
    }
  }
}

export function finish(slots: readonly Slot[], ctx: Context): EditSuccess {
  const entries = restoreSeams(slots, ctx);
  requireContinuations(entries, ctx);
  const { lines, changed } = render(entries, ctx);
  const text = lines.join("\n");
  const { document, diagnostics } = parsePictureDocument(text);
  const problem = diagnostics[0];
  if (problem) throw new EditRefusal(`the edit leaves line ${problem.line}: ${problem.message}`);
  compilePictureSource(text, { lenient: true, profile: ctx.profile });
  return { document, changedLines: changed };
}

export const inItem = (item: PictureItem, line: number): boolean =>
  item.openLine < line && line < item.closeLine;
