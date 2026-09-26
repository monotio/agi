/**
 * Room Studio edit operations: the one kernel through which the UI and the
 * agent change a picture document. Each operation rewrites source lines,
 * never the input, and the result must re-parse without diagnostics and
 * compile before it is returned.
 *
 * State restoration around segments: an operation that removes, inserts,
 * moves or recolours a block of lines leaves every other command line
 * drawing with the registers (visual, priority, pen) it had before. At each
 * seam the edit opens, the registers the following lines read before setting
 * them are compared with the state those lines saw in the original document,
 * and a `vis`/`pri`/`pen` line is inserted for each one that differs: inside
 * the edited item before its `@end`, or loose where a removed item stood. A
 * moved or duplicated item likewise gets, right after its `@item`, the state
 * its own lines inherited at their original place.
 */

import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";
import { compilePictureSource, PictureSourceSyntaxError } from "../picture/source.ts";
import {
  parsePictureDocument,
  pictureItemAtLine,
  PICTURE_ITEM_KINDS,
  serializePictureDocument,
  type PictureDocument,
  type PictureItemKind,
} from "./pictureDocument.ts";
import type { PicturePlane } from "./pictureQuery.ts";
import { shapeSource, type Point, type SceneShape } from "./shapes.ts";
import { commandHead, registerLine, registersRead } from "./editState.ts";
import {
  commandTokens,
  copyRange,
  EditRefusal,
  onSurface,
  rawIncludes,
  replaceTokens,
  setLinePoint,
  translateLine,
} from "./editSource.ts";
import {
  bodyOf,
  directive,
  editableItem,
  findItem,
  finish,
  inItem,
  inputLines,
  newLine,
  refuseCopiesOf,
  requireIntegers,
  requireNewItem,
  requireValue,
  stateBefore,
  type Context,
  type EditSuccess,
  type Slot,
} from "./editSegments.ts";

export type EditOperation =
  | { readonly type: "moveItem"; readonly itemId: string; readonly dx: number; readonly dy: number }
  | {
      readonly type: "setPoint";
      /** 1-based source line. */
      readonly line: number;
      readonly pointIndex: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "setItemColor";
      readonly itemId: string;
      readonly plane: PicturePlane;
      /** 0..15, or null to turn the plane off for the item. */
      readonly value: number | null;
    }
  | { readonly type: "deleteItem"; readonly itemId: string }
  | {
      readonly type: "duplicateItem";
      readonly itemId: string;
      readonly dx: number;
      readonly dy: number;
      readonly newId: string;
      readonly newLabel: string;
    }
  | { readonly type: "reorderItem"; readonly itemId: string; readonly toIndex: number }
  | {
      readonly type: "insertShape";
      /** Insert before this 1-based line (lines.length + 1 appends); never inside an item. */
      readonly atLine: number;
      readonly shape: SceneShape;
      readonly id: string;
      readonly label: string;
      readonly kind: PictureItemKind;
    }
  | {
      readonly type: "insertFill";
      readonly atLine: number;
      readonly x: number;
      readonly y: number;
      readonly visual: number | null;
      readonly priority: number | null;
      readonly id: string;
      readonly label: string;
    }
  | {
      readonly type: "insertPlot";
      readonly atLine: number;
      readonly pen: { readonly radius: number; readonly stipple: boolean };
      readonly points: readonly Point[];
      /** The stipple pattern seed 0..239; required with a stipple pen, refused without. */
      readonly seed?: number;
      readonly visual: number | null;
      readonly priority: number | null;
      readonly id: string;
      readonly label: string;
    }
  | {
      readonly type: "setItemMeta";
      readonly itemId: string;
      readonly label?: string;
      readonly kind?: PictureItemKind;
      readonly locked?: boolean;
    };

export type EditResult = EditSuccess | { readonly error: string };

export interface EditOptions {
  /** Command vocabulary for compiling; defaults to AGI 2.936. */
  readonly profile?: AgiProfile;
}

function moveItem(ctx: Context, itemId: string, dx: number, dy: number): EditResult {
  requireIntegers({ dx, dy });
  const item = editableItem(ctx, itemId);
  refuseCopiesOf(ctx, item, "moving");
  const slots = inputLines(ctx, 1, ctx.lines.length).map((line) =>
    inItem(item, line.from!)
      ? { ...line, text: translateLine(line.text, line.from!, dx, dy) }
      : line,
  );
  return finish(slots, ctx);
}

function setPoint(ctx: Context, line: number, index: number, x: number, y: number): EditResult {
  requireIntegers({ line, pointIndex: index, x, y });
  if (line < 1 || line > ctx.lines.length) throw new EditRefusal(`no line ${line}`);
  const item = pictureItemAtLine(ctx.document, line);
  if (item?.locked) throw new EditRefusal(`line ${line} belongs to locked item '${item.id}'`);
  const slots = inputLines(ctx, 1, ctx.lines.length).map((entry) =>
    entry.from === line ? { ...entry, text: setLinePoint(entry.text, line, index, x, y) } : entry,
  );
  return finish(slots, ctx);
}

const PLANE_HEADS: Record<PicturePlane, readonly string[]> = {
  visual: ["vis", "visual"],
  priority: ["pri", "priority"],
};
const PLANE_COMMANDS: Record<PicturePlane, readonly number[]> = {
  visual: [0xf0, 0xf1],
  priority: [0xf2, 0xf3],
};

function setItemColor(
  ctx: Context,
  itemId: string,
  plane: PicturePlane,
  value: number | null,
): EditResult {
  requireValue(plane, value);
  const item = editableItem(ctx, itemId);
  refuseCopiesOf(ctx, item, "recolouring");
  const heads = PLANE_HEADS[plane];
  const body = bodyOf(ctx, item).map((line) => {
    if (rawIncludes(line.text, PLANE_COMMANDS[plane])) {
      throw new EditRefusal(
        `line ${line.from} sets the ${plane} state in raw bytes, which cannot be rewritten`,
      );
    }
    const range = copyRange(line.text);
    if (
      range &&
      ctx.lines.slice(range.from - 1, range.to).some((t) => heads.includes(commandHead(t)))
    ) {
      throw new EditRefusal(
        `line ${line.from} copies ${plane} state lines, which cannot be rewritten here; replace the copy with the lines it expands to first`,
      );
    }
    if (!heads.includes(commandHead(line.text))) return line;
    const head = commandTokens(line.text)[0]!;
    return {
      ...line,
      text: replaceTokens(line.text, [head, value === null ? "off" : String(value)]),
    };
  });
  const start = stateBefore(ctx, item.openLine);
  const inherits = registersRead(body.map((line) => line.text))[plane] && start[plane] !== value;
  const explicit = registerLine(plane, { ...start, [plane]: value }, ctx.profile);
  const slots: Slot[] = [
    ...inputLines(ctx, 1, item.openLine),
    ...(inherits ? [newLine(ctx, explicit)] : []),
    ...body,
    { expected: stateBefore(ctx, item.closeLine), scope: "document" },
    ...inputLines(ctx, item.closeLine, ctx.lines.length),
  ];
  return finish(slots, ctx);
}

function deleteItem(ctx: Context, itemId: string): EditResult {
  const item = editableItem(ctx, itemId);
  return finish(
    [
      ...inputLines(ctx, 1, item.openLine - 1),
      { expected: stateBefore(ctx, item.closeLine), scope: "document" },
      ...inputLines(ctx, item.closeLine + 1, ctx.lines.length),
    ],
    ctx,
  );
}

function duplicateItem(
  ctx: Context,
  op: Extract<EditOperation, { type: "duplicateItem" }>,
): EditResult {
  requireIntegers({ dx: op.dx, dy: op.dy });
  const item = findItem(ctx, op.itemId);
  requireNewItem(ctx, op.newId, op.newLabel);
  const body = bodyOf(ctx, item).map(({ text, from }) => ({
    text: translateLine(text, from!, op.dx, op.dy),
  }));
  return finish(
    [
      ...inputLines(ctx, 1, item.closeLine),
      newLine(ctx, directive(op.newId, op.newLabel, item.kind, false)),
      { expected: stateBefore(ctx, item.openLine), scope: "item" },
      ...body,
      { expected: stateBefore(ctx, item.closeLine), scope: "document" },
      newLine(ctx, "# @end"),
      ...inputLines(ctx, item.closeLine + 1, ctx.lines.length),
    ],
    ctx,
  );
}

function reorderItem(ctx: Context, itemId: string, toIndex: number): EditResult {
  const item = editableItem(ctx, itemId);
  const { items } = ctx.document;
  requireIntegers({ toIndex });
  if (toIndex < 0 || toIndex >= items.length) {
    throw new EditRefusal(`toIndex ${toIndex} is outside 0..${items.length - 1}`);
  }
  if (items.indexOf(item) === toIndex) return { document: ctx.document, changedLines: [] };
  const rest = items.filter((candidate) => candidate !== item);
  /** The input line the moved item is inserted before: right after its new predecessor. */
  const before = toIndex === 0 ? rest[0]!.openLine : rest[toIndex - 1]!.closeLine + 1;
  const [open, ...inner] = inputLines(ctx, item.openLine, item.closeLine).map((line) => ({
    ...line,
    moved: true,
  }));
  const close = inner.pop()!;
  const block: Slot[] = [
    open!,
    { expected: stateBefore(ctx, item.openLine), scope: "item" },
    ...inner,
    { expected: stateBefore(ctx, before), scope: "document" },
    close,
  ];
  const slots: Slot[] = [];
  for (let line = 1; line <= ctx.lines.length + 1; line++) {
    if (line === before) slots.push(...block);
    if (line === item.openLine) {
      slots.push({ expected: stateBefore(ctx, item.closeLine), scope: "document" });
    }
    if (line > ctx.lines.length || (line >= item.openLine && line <= item.closeLine)) continue;
    slots.push(...inputLines(ctx, line, line));
  }
  return finish(slots, ctx);
}

/** Insert a new item holding `body` before input line `atLine`, restoring state after it. */
function insertItem(
  ctx: Context,
  atLine: number,
  item: { id: string; label: string; kind: PictureItemKind },
  body: readonly string[],
): EditResult {
  requireIntegers({ atLine });
  if (atLine < 1 || atLine > ctx.lines.length + 1) {
    throw new EditRefusal(`atLine ${atLine} is outside 1..${ctx.lines.length + 1}`);
  }
  const host = ctx.document.items.find((i) => i.openLine < atLine && atLine <= i.closeLine);
  if (host) {
    throw new EditRefusal(
      `line ${atLine} is inside item '${host.id}'; insert before its @item or after its @end`,
    );
  }
  requireNewItem(ctx, item.id, item.label);
  if (!PICTURE_ITEM_KINDS.includes(item.kind)) throw new EditRefusal(`unknown kind '${item.kind}'`);
  try {
    compilePictureSource(body.join("\n"), { profile: ctx.profile });
  } catch (error) {
    if (error instanceof PictureSourceSyntaxError) {
      throw new EditRefusal(`the new item does not compile: ${error.message}`);
    }
    throw error;
  }
  return finish(
    [
      ...inputLines(ctx, 1, atLine - 1),
      newLine(ctx, directive(item.id, item.label, item.kind, false)),
      ...body.map((text) => newLine(ctx, text)),
      { expected: stateBefore(ctx, atLine), scope: "document" },
      newLine(ctx, "# @end"),
      ...inputLines(ctx, atLine, ctx.lines.length),
    ],
    ctx,
  );
}

/** The kind of an item drawing with `visual`/`priority`: priority 0..3 is walk control. */
function kindFor(visual: number | null, priority: number | null): PictureItemKind {
  if (priority === null) return "art";
  if (visual !== null) return "mixed";
  return priority < 4 ? "walk" : "depth";
}

function stateHeader(visual: number | null, priority: number | null): string[] {
  requireValue("visual", visual);
  requireValue("priority", priority);
  if (visual === null && priority === null) {
    throw new EditRefusal("the new item draws on neither plane");
  }
  return [
    visual === null ? "vis off" : `vis ${visual}`,
    priority === null ? "pri off" : `pri ${priority}`,
  ];
}

function insertShape(
  ctx: Context,
  op: Extract<EditOperation, { type: "insertShape" }>,
): EditResult {
  let body: string[];
  try {
    body = shapeSource(op.shape);
  } catch (error) {
    throw new EditRefusal(`the shape cannot be drawn: ${(error as Error).message}`);
  }
  return insertItem(ctx, op.atLine, op, body);
}

function insertFill(ctx: Context, op: Extract<EditOperation, { type: "insertFill" }>): EditResult {
  if (!onSurface(op.x, op.y)) throw new EditRefusal(`seed ${op.x},${op.y} is off the surface`);
  const body = [...stateHeader(op.visual, op.priority), `fill ${op.x},${op.y}`];
  return insertItem(ctx, op.atLine, { ...op, kind: kindFor(op.visual, op.priority) }, body);
}

function insertPlot(ctx: Context, op: Extract<EditOperation, { type: "insertPlot" }>): EditResult {
  const { profile } = ctx;
  if (profile.pictureMaxCommand < 0xfa || profile.patternProfile === "point-2.411") {
    throw new EditRefusal(`profile ${profile.id} has no brush pen`);
  }
  const { radius, stipple } = op.pen;
  if (!Number.isInteger(radius) || radius < 0 || radius > 7) {
    throw new EditRefusal(`pen radius must be 0..7, got ${radius}`);
  }
  if (op.points.length === 0) throw new EditRefusal("a plot needs at least one point");
  const bad = op.points.find(({ x, y }) => !onSurface(x, y));
  if (bad) throw new EditRefusal(`plot point ${bad.x},${bad.y} is off the surface`);
  if (stipple !== (op.seed !== undefined)) {
    throw new EditRefusal("a stipple pen needs a seed, and only a stipple pen takes one");
  }
  if (op.seed !== undefined && !(Number.isInteger(op.seed) && op.seed >= 0 && op.seed <= 0xef)) {
    throw new EditRefusal(`seed must be 0..239, got ${op.seed}`);
  }
  const points = op.points.map(({ x, y }) => `${x},${y}`).join(" ");
  const body = [
    ...stateHeader(op.visual, op.priority),
    `pen ${radius}${stipple ? " stipple" : ""}`,
    `plot ${op.seed === undefined ? "" : `${op.seed} `}${points}`,
  ];
  return insertItem(ctx, op.atLine, { ...op, kind: kindFor(op.visual, op.priority) }, body);
}

function setItemMeta(
  ctx: Context,
  op: Extract<EditOperation, { type: "setItemMeta" }>,
): EditResult {
  const item = findItem(ctx, op.itemId);
  const label = op.label ?? item.label;
  const kind = op.kind ?? item.kind;
  if (label.trim().length === 0) throw new EditRefusal("an item needs a non-empty label");
  if (!PICTURE_ITEM_KINDS.includes(kind)) throw new EditRefusal(`unknown kind '${kind}'`);
  const old = ctx.lines[item.openLine - 1]!;
  const text =
    directive(item.id, label, kind, op.locked ?? item.locked) + (old.endsWith("\r") ? "\r" : "");
  const slots = inputLines(ctx, 1, ctx.lines.length).map((line) =>
    line.from === item.openLine ? { ...line, text } : line,
  );
  return finish(slots, ctx);
}

function dispatch(ctx: Context, op: EditOperation): EditResult {
  switch (op.type) {
    case "moveItem":
      return moveItem(ctx, op.itemId, op.dx, op.dy);
    case "setPoint":
      return setPoint(ctx, op.line, op.pointIndex, op.x, op.y);
    case "setItemColor":
      return setItemColor(ctx, op.itemId, op.plane, op.value);
    case "deleteItem":
      return deleteItem(ctx, op.itemId);
    case "duplicateItem":
      return duplicateItem(ctx, op);
    case "reorderItem":
      return reorderItem(ctx, op.itemId, op.toIndex);
    case "insertShape":
      return insertShape(ctx, op);
    case "insertFill":
      return insertFill(ctx, op);
    case "insertPlot":
      return insertPlot(ctx, op);
    case "setItemMeta":
      return setItemMeta(ctx, op);
  }
}

/**
 * Apply one edit. The input is never mutated; the result is a freshly parsed
 * document, or `{ error }` when the edit is refused or its source would not
 * parse cleanly and compile. The input must itself parse without diagnostics.
 */
export function applyEdit(
  document: PictureDocument,
  op: EditOperation,
  options?: EditOptions,
): EditResult {
  const profile = options?.profile ?? DEFAULT_V2_PROFILE;
  const source = serializePictureDocument(document);
  const parsed = parsePictureDocument(source);
  const problem = parsed.diagnostics[0];
  if (problem) {
    return { error: `fix line ${problem.line} before editing: ${problem.message}` };
  }
  try {
    const compiled = compilePictureSource(source, { lenient: true, profile });
    const eol = parsed.document.lines.some((line) => line.endsWith("\r")) ? "\r" : "";
    const ctx: Context = {
      document: parsed.document,
      lines: parsed.document.lines,
      profile,
      eol,
      compiled,
    };
    return dispatch(ctx, op);
  } catch (error) {
    if (error instanceof EditRefusal) return { error: error.message };
    if (error instanceof PictureSourceSyntaxError) {
      return { error: `the source does not compile: ${error.message}` };
    }
    throw error;
  }
}
