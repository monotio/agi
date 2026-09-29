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
 *
 * `applyEdits` applies several operations as ONE edit (the Studio's
 * multi-selection moves, copies and deletes several items as one undo
 * step): each operation applies to the result of the one before, and the
 * batch is refused whole when any of them is. A batch of moves rewrites
 * every member's lines in a single pass.
 */

import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";
import { compilePictureSource, PictureSourceSyntaxError } from "../picture/source.ts";
import { groupPictureElements } from "../picture/elements.ts";
import { kindOf } from "./nativeItems.ts";
import {
  groupPart,
  itemRun,
  partLine,
  PART_END_LINE,
  pictureCommandText,
  parsePictureDocument,
  PICTURE_ITEM_ID,
  pictureItemAtLine,
  PICTURE_ITEM_KINDS,
  serializePictureDocument,
  type PictureDocument,
  type PictureItem,
  type PictureItemKind,
} from "./pictureDocument.ts";
import type { PicturePlane } from "./pictureQuery.ts";
import { shapeSource, validateSimplePolygon, type Point, type SceneShape } from "./shapes.ts";
import { commandHead, registerLine, registersRead } from "./editState.ts";
import {
  commandTokens,
  copyRange,
  EditRefusal,
  insertLinePoint,
  lineVertices,
  MAX_X,
  MAX_Y,
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
  type Line,
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
      /** Add a vertex to a line/polyline/polygon/rel command line of the item. */
      readonly type: "insertPoint";
      readonly itemId: string;
      /** 1-based source line, one of the item's command lines. */
      readonly line: number;
      /** The new point's index: it goes before the point now there; the point count appends. */
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
      /**
       * Group: neighbouring items become one item, one `@item` over their
       * lines, the commands in draw order, so the bytes never change. Each
       * member's own item stays as `# part` comments for Ungroup. Refused
       * when another item or a loose command is drawn between them.
       */
      readonly type: "combineItems";
      readonly itemIds: readonly string[];
      /** The new item's id: unused, or one of the members'. */
      readonly id: string;
      readonly label: string;
    }
  | {
      /**
       * Ungroup: the item becomes separate items again, bytes unchanged.
       * A group's `# part` comments come back as the items they were when
       * they can exactly; otherwise it splits per drawing element, named as
       * inferred elements are (`el-N "Element N"`).
       */
      readonly type: "ungroupItem";
      readonly itemId: string;
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

type Move = Extract<EditOperation, { type: "moveItem" }>;

/** Move each item by its own offset in one pass: moves rewrite lines in place, never add any. */
function moveItems(ctx: Context, moves: readonly Move[]): EditResult {
  const offsets = new Map<PictureItem, Move>();
  for (const move of moves) {
    requireIntegers({ dx: move.dx, dy: move.dy });
    const item = editableItem(ctx, move.itemId);
    if (offsets.has(item)) throw new EditRefusal(`item '${item.id}' is in the batch twice`);
    refuseCopiesOf(ctx, item, "moving");
    offsets.set(item, move);
  }
  const slots = inputLines(ctx, 1, ctx.lines.length).map((line) => {
    const item = pictureItemAtLine(ctx.document, line.from!);
    const move = item && offsets.get(item);
    return move ? { ...line, text: translateLine(line.text, line.from!, move.dx, move.dy) } : line;
  });
  return finish(slots, ctx);
}

/** A side of the 160x168 surface. */
export type SurfaceEdge = "left" | "right" | "top" | "bottom";

/** How far a move may go: the allowed offset, and what stops it on each axis it was cut short. */
export interface MoveLimit {
  readonly dx: number;
  readonly dy: number;
  /** Per clamped axis (x first), the item that reaches the edge and which edge. */
  readonly stops: readonly { readonly itemId: string; readonly edge: SurfaceEdge }[];
}

/**
 * The part of dx,dy by which `itemIds` can all move together and keep on the
 * surface, per axis: each axis keeps its direction and stops where the
 * first of the items' `lineVertices` (the coordinates `moveItem` checks)
 * would reach the edge. Items the document lacks and lines without
 * coordinates set no limit; locks, copies and raw lines are left to the
 * move itself.
 */
export function limitMove(
  document: PictureDocument,
  itemIds: readonly string[],
  dx: number,
  dy: number,
): MoveLimit {
  let left: { at: number; itemId: string } | undefined;
  let right: typeof left;
  let top: typeof left;
  let bottom: typeof left;
  for (const item of document.items) {
    if (!itemIds.includes(item.id)) continue;
    for (let line = item.openLine + 1; line < item.closeLine; line++) {
      for (const [x, y] of lineVertices(document.lines[line - 1] ?? "")) {
        if (!left || x < left.at) left = { at: x, itemId: item.id };
        if (!right || x > right.at) right = { at: x, itemId: item.id };
        if (!top || y < top.at) top = { at: y, itemId: item.id };
        if (!bottom || y > bottom.at) bottom = { at: y, itemId: item.id };
      }
    }
  }
  const stops: { itemId: string; edge: SurfaceEdge }[] = [];
  const axis = (
    d: number,
    low: typeof left,
    high: typeof left,
    max: number,
    edges: readonly [SurfaceEdge, SurfaceEdge],
  ): number => {
    if (d < 0 && low && d < -low.at) {
      stops.push({ itemId: low.itemId, edge: edges[0] });
      return low.at > 0 ? -low.at : 0;
    }
    if (d > 0 && high && d > max - high.at) {
      stops.push({ itemId: high.itemId, edge: edges[1] });
      return high.at < max ? max - high.at : 0;
    }
    return d;
  };
  const x = axis(dx, left, right, MAX_X, ["left", "right"]);
  const y = axis(dy, top, bottom, MAX_Y, ["top", "bottom"]);
  return { dx: x, dy: y, stops };
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

function insertPoint(
  ctx: Context,
  op: Extract<EditOperation, { type: "insertPoint" }>,
): EditResult {
  const { line, pointIndex, x, y } = op;
  requireIntegers({ line, pointIndex, x, y });
  const item = editableItem(ctx, op.itemId);
  if (!inItem(item, line)) throw new EditRefusal(`line ${line} is not in item '${item.id}'`);
  refuseCopiesOf(ctx, item, "adding a point to");
  const slots = inputLines(ctx, 1, ctx.lines.length).map((entry) =>
    entry.from === line
      ? { ...entry, text: insertLinePoint(entry.text, line, pointIndex, x, y) }
      : entry,
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
    // An outline that crosses itself has no inside: AGI draws it, but a fill
    // or a later edit of it cannot mean anything, so it is refused here.
    if (op.shape.kind === "polygon") validateSimplePolygon(op.shape.points, "the polygon");
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

function combineItems(
  ctx: Context,
  op: Extract<EditOperation, { type: "combineItems" }>,
): EditResult {
  const ids = [...new Set(op.itemIds)];
  if (ids.length < 2) throw new EditRefusal("making one item needs at least two items");
  for (const id of ids) findItem(ctx, id);
  const { members, between, looseCommands } = itemRun(ctx.document, ids);
  const first = members[0]!;
  const last = members.at(-1)!;
  const blocker = between[0];
  if (blocker) {
    const before = members.filter((item) => item.openLine < blocker.openLine).at(-1)!;
    const after = members.find((item) => item.openLine > blocker.openLine)!;
    throw new EditRefusal(
      `'${before.id}' and '${after.id}' are not next to each other in the draw order: '${blocker.id}' is drawn between them`,
    );
  }
  const loose = looseCommands[0];
  if (loose !== undefined) {
    const before = members.filter((item) => item.closeLine < loose).at(-1)!;
    const after = members.find((item) => item.openLine > loose)!;
    throw new EditRefusal(
      `line ${loose} draws between '${before.id}' and '${after.id}' outside any item`,
    );
  }
  for (const id of ids) editableItem(ctx, id);
  if (!PICTURE_ITEM_ID.test(op.id)) {
    throw new EditRefusal(`item id '${op.id}' must match ${PICTURE_ITEM_ID.source}`);
  }
  if (ctx.document.items.some((item) => item.id === op.id && !ids.includes(item.id))) {
    throw new EditRefusal(`item id '${op.id}' is already used`);
  }
  if (op.label.trim().length === 0) throw new EditRefusal("an item needs a non-empty label");
  const kinds = new Set(members.map((item) => item.kind));
  const kind = kinds.size === 1 ? first.kind : "mixed";
  /** The members' own `@item` and `@end` lines become their `# part` comments. */
  const opens = new Map(members.map((item) => [item.openLine, item]));
  const closes = new Set(members.map((item) => item.closeLine));
  return finish(
    [
      ...inputLines(ctx, 1, first.openLine - 1),
      newLine(ctx, directive(op.id, op.label, kind, false)),
      ...inputLines(ctx, first.openLine, last.closeLine).map((line) => {
        const member = opens.get(line.from!);
        if (member) return newLine(ctx, partLine(member.id, member.label, member.kind));
        return closes.has(line.from!) ? newLine(ctx, PART_END_LINE) : line;
      }),
      newLine(ctx, "# @end"),
      ...inputLines(ctx, last.closeLine + 1, ctx.lines.length),
    ],
    ctx,
  );
}

/**
 * A group's body with its `# part` comments turned back into the items they
 * were, or null when that can't be exact: a marker out of pairs, an id
 * another item holds, or a command outside every part.
 */
function restoredParts(ctx: Context, group: PictureItem): Line[] | null {
  const taken = new Set(ctx.document.items.filter((item) => item !== group).map((item) => item.id));
  const out: Line[] = [];
  let open = false;
  let parts = 0;
  for (const line of bodyOf(ctx, group)) {
    const part = groupPart(line.text);
    if (part === "end") {
      if (!open) return null;
      open = false;
      out.push(newLine(ctx, "# @end"));
    } else if (part) {
      if (open || taken.has(part.id)) return null;
      taken.add(part.id);
      open = true;
      parts++;
      out.push(newLine(ctx, directive(part.id, part.label, part.kind, false)));
    } else {
      if (!open && pictureCommandText(line.text).length > 0) return null;
      out.push(line);
    }
  }
  return !open && parts > 0 ? out : null;
}

/**
 * The item's body split into one item per drawing element run, named as
 * `inferNativeItems` names them (`el-N`, then `el-N-2` for a later run or a
 * taken id). Lines that belong to no element stay loose; stray `# part`
 * comments are dropped.
 */
function elementParts(ctx: Context, item: PictureItem): Line[] {
  const groups = groupPictureElements(ctx.lines.join("\n"), {
    profile: ctx.profile,
    joinContinuations: true,
  });
  const taken = new Set(ctx.document.items.filter((other) => other !== item).map((o) => o.id));
  const body = bodyOf(ctx, item).filter((line) => groupPart(line.text) === undefined);
  const out: Line[] = [];
  let runs = 0;
  for (let k = 0; k < body.length;) {
    const element = groups.elementOf[body[k]!.from! - 1] ?? 0;
    if (element === 0) {
      out.push(body[k++]!);
      continue;
    }
    let end = k;
    while (end + 1 < body.length && groups.elementOf[body[end + 1]!.from! - 1] === element) end++;
    let planes = 0;
    for (let j = k; j <= end; j++) planes |= groups.planes[body[j]!.from! - 1] ?? 0;
    let part = 1;
    while (taken.has(part === 1 ? `el-${element}` : `el-${element}-${part}`)) part++;
    const id = part === 1 ? `el-${element}` : `el-${element}-${part}`;
    taken.add(id);
    runs++;
    const label = part === 1 ? `Element ${element}` : `Element ${element} part ${part}`;
    out.push(newLine(ctx, directive(id, label, kindOf(planes), false)));
    out.push(...body.slice(k, end + 1));
    out.push(newLine(ctx, "# @end"));
    k = end + 1;
  }
  if (runs < 2)
    throw new EditRefusal(`'${item.id}' is one drawing element: there is nothing to ungroup`);
  return out;
}

function ungroupItem(
  ctx: Context,
  op: Extract<EditOperation, { type: "ungroupItem" }>,
): EditResult {
  const item = editableItem(ctx, op.itemId);
  return finish(
    [
      ...inputLines(ctx, 1, item.openLine - 1),
      ...(restoredParts(ctx, item) ?? elementParts(ctx, item)),
      ...inputLines(ctx, item.closeLine + 1, ctx.lines.length),
    ],
    ctx,
  );
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
      return moveItems(ctx, [op]);
    case "setPoint":
      return setPoint(ctx, op.line, op.pointIndex, op.x, op.y);
    case "insertPoint":
      return insertPoint(ctx, op);
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
    case "combineItems":
      return combineItems(ctx, op);
    case "ungroupItem":
      return ungroupItem(ctx, op);
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
  return withContext(document, options, (ctx) => dispatch(ctx, op));
}

/**
 * Apply several edits as one: each to the result of the one before, the
 * whole batch refused (with the first refusal) when any one is. A batch of
 * moves only runs in one pass. `changedLines` are the last edit's; an
 * empty batch returns the document as it is.
 */
export function applyEdits(
  document: PictureDocument,
  ops: readonly EditOperation[],
  options?: EditOptions,
): EditResult {
  if (ops.length === 0) return { document, changedLines: [] };
  if (ops.every((op): op is Move => op.type === "moveItem"))
    return withContext(document, options, (ctx) => moveItems(ctx, ops));
  let result: EditResult = { document, changedLines: [] };
  for (const op of ops) {
    result = applyEdit(result.document, op, options);
    if ("error" in result) return result;
  }
  return result;
}

/** Parse, compile and run `run` on the document's edit context, turning refusals into errors. */
function withContext(
  document: PictureDocument,
  options: EditOptions | undefined,
  run: (ctx: Context) => EditResult,
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
    return run(ctx);
  } catch (error) {
    if (error instanceof EditRefusal) return { error: error.message };
    if (error instanceof PictureSourceSyntaxError) {
      return { error: `the source does not compile: ${error.message}` };
    }
    throw error;
  }
}
