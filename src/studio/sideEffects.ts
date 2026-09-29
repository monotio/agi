/**
 * The side effects of a Room Studio edit: cells of OTHER items' output that
 * change though their commands do not, as when a fill pours differently
 * around a moved outline. The creator's own edits (app/src/studio/studioLocks.ts)
 * and AI proposals (assistScope.ts) report them instead of refusing them;
 * the caller says which changed cells count (those outside the edited
 * items, or outside a proposal's licence). Each cell is put down to the
 * item whose output changed there: of the items that drew it before and
 * after, the one not edited, else the later in the draw order (it now
 * covers the cell, or no longer does). Pure and deterministic.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import type { CellBox, CompiledDocument } from "./editValidation.ts";
import type { PicturePlane } from "./pictureQuery.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;
const PLANES: readonly PicturePlane[] = ["visual", "priority"];
/** The fill command's opcode. */
const FILL_OPCODE = 0xf8;

/** The creator's planes: art (visual), depth (priority 4–15) and walk lines (priority 0–3). */
type SideEffectPlane = "art" | "depth" | "walk";

/** The creator's name for a side effect's plane. */
const SIDE_EFFECT_PLANE_WORDS: Record<SideEffectPlane, string> = {
  art: "art",
  depth: "depth",
  walk: "walk lines",
};

/** One other item's changed cells on one plane. */
interface SideEffect {
  /** The item whose output changes; null for loose steps or the blank picture. */
  readonly itemId: string | null;
  readonly label: string;
  readonly plane: SideEffectPlane;
  readonly count: number;
  readonly bbox: CellBox;
  /** Some of the cells are that item's fill: it pours differently. */
  readonly fill: boolean;
}

/** One other item that changes: its distinct cells on any plane. */
interface SideEffectItem {
  readonly itemId: string | null;
  readonly label: string;
  readonly cells: number;
  readonly fill: boolean;
}

export interface SideEffectReport {
  /** The items that change, most cells first. */
  readonly items: readonly SideEffectItem[];
  /** Per item and plane, in the items' order, then art, depth, walk. */
  readonly effects: readonly SideEffect[];
  /** Distinct cells that change, on any plane. */
  readonly cells: number;
  /** 160x168: 1 where a reported cell lies, for the canvas outline. */
  readonly mask: Uint8Array;
}

/** The label of cells drawn by commands outside every item: the Scene list's name. */
const LOOSE_LABEL = "Loose steps";
/** The label of cells no command drew. */
const BLANK_LABEL = "Blank area";

/** Per compiled byte, the index of the item its command lies in, or -1 (loose). */
function byteItems(compiled: CompiledDocument): Int32Array {
  const { items, lines } = compiled.document;
  const lineItem = new Int32Array(lines.length + 2).fill(-1);
  items.forEach((item, index) => lineItem.fill(index, item.openLine + 1, item.closeLine));
  const out = new Int32Array(compiled.bytes.length).fill(-1);
  for (const span of compiled.spans) out.fill(lineItem[span.line] ?? -1, span.start, span.end);
  return out;
}

const BLANK = -2;
const LOOSE = -1;

/**
 * Who drew cell `index` on `plane`: an item index into the document, LOOSE
 * or BLANK, and whether the command is a fill.
 */
function drawer(
  compiled: CompiledDocument,
  items: Int32Array,
  plane: PicturePlane,
  index: number,
): { item: number; fill: boolean } {
  const owner = compiled.owners[plane][index]!;
  if (owner < 0) return { item: BLANK, fill: false };
  return { item: items[owner] ?? LOOSE, fill: compiled.bytes[owner] === FILL_OPCODE };
}

interface Tally {
  count: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fill: boolean;
}

/**
 * The side effects on `cells` (per plane, 1 where a changed cell counts)
 * of an edit from `before` to `after` whose edited items are `edited`;
 * null when no counted cell changed.
 */
export function sideEffects(
  before: CompiledDocument,
  after: CompiledDocument,
  cells: Readonly<Record<PicturePlane, Uint8Array>>,
  edited: ReadonlySet<string>,
): SideEffectReport | null {
  const beforeItems = byteItems(before);
  const afterItems = byteItems(after);
  const order = new Map(after.document.items.map((item, index) => [item.id, index]));
  /** Key of each item that changes: its id, or the loose or blank label. */
  const labels = new Map<string, { itemId: string | null; label: string }>();
  const planes = new Map<string, Tally>();
  const totals = new Map<string, { cells: number; fill: boolean }>();
  const mask = new Uint8Array(CELLS);
  let total = 0;

  const identify = (compiled: CompiledDocument, item: number) => {
    if (item === BLANK) return { key: "\u0000blank", itemId: null, label: BLANK_LABEL };
    const found = item >= 0 ? compiled.document.items[item] : undefined;
    return found
      ? { key: found.id, itemId: found.id, label: found.label }
      : { key: "\u0000loose", itemId: null, label: LOOSE_LABEL };
  };

  for (let i = 0; i < CELLS; i++) {
    let seen: string | null = null;
    for (const plane of PLANES) {
      if (cells[plane][i] !== 1) continue;
      const was = drawer(before, beforeItems, plane, i);
      const now = drawer(after, afterItems, plane, i);
      const a = identify(before, was.item);
      const b = identify(after, now.item);
      // The item whose output changed: never an edited one; else whichever
      // actually drew (an item over loose steps over the blank picture);
      // else the later in the draw order.
      const takeBefore =
        (b.itemId !== null && edited.has(b.itemId)) ||
        (!(a.itemId !== null && edited.has(a.itemId)) &&
          (now.item === BLANK ||
            (now.item === LOOSE && was.item >= 0) ||
            (was.item >= 0 &&
              now.item >= 0 &&
              (order.get(a.key) ?? -1) > (order.get(b.key) ?? -1))));
      const side = takeBefore ? a : b;
      const fill = takeBefore ? was.fill : now.fill;
      labels.set(side.key, { itemId: side.itemId, label: side.label });
      const name: SideEffectPlane =
        plane === "visual"
          ? "art"
          : before.priority[i]! < 4 || after.priority[i]! < 4
            ? "walk"
            : "depth";
      const key = `${side.key}\u0000${name}`;
      const tally = planes.get(key) ?? {
        count: 0,
        x0: SCREEN_WIDTH,
        y0: SCREEN_HEIGHT,
        x1: -1,
        y1: -1,
        fill: false,
      };
      planes.set(key, tally);
      const x = i % SCREEN_WIDTH;
      const y = (i - x) / SCREEN_WIDTH;
      tally.count++;
      tally.x0 = Math.min(tally.x0, x);
      tally.y0 = Math.min(tally.y0, y);
      tally.x1 = Math.max(tally.x1, x);
      tally.y1 = Math.max(tally.y1, y);
      tally.fill ||= fill;
      const sum = totals.get(side.key) ?? { cells: 0, fill: false };
      totals.set(side.key, sum);
      sum.fill ||= fill;
      if (seen !== side.key) sum.cells++;
      seen = side.key;
      if (mask[i] === 0) total++;
      mask[i] = 1;
    }
  }
  if (total === 0) return null;
  const items = [...totals.entries()]
    .map(([key, { cells: count, fill }]) => ({ key, ...labels.get(key)!, cells: count, fill }))
    .sort((p, q) => q.cells - p.cells || (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
  const effects = items.flatMap(({ key, itemId, label }) =>
    (["art", "depth", "walk"] as const).flatMap((plane) => {
      const tally = planes.get(`${key}\u0000${plane}`);
      return tally
        ? [
            {
              itemId,
              label,
              plane,
              count: tally.count,
              bbox: { x0: tally.x0, y0: tally.y0, x1: tally.x1, y1: tally.y1 },
              fill: tally.fill,
            },
          ]
        : [];
    }),
  );
  return {
    items: items.map(({ itemId, label, cells: count, fill }) => ({
      itemId,
      label,
      cells: count,
      fill,
    })),
    effects,
    cells: total,
    mask,
  };
}

/** The report as data for a tool result: everything but the mask. */
export function sideEffectData(report: SideEffectReport) {
  return { cells: report.cells, items: report.items, effects: report.effects };
}

/**
 * The report in one plain line for the model: "Side effects: other items'
 * art changes. Grass: 17802 cells at 1,24..158,166 (its fill re-pours)."
 * Each entry names its plane when more than one changes.
 */
export function sideEffectLine(report: SideEffectReport): string {
  const planes = (["art", "depth", "walk"] as const).filter((plane) =>
    report.effects.some((effect) => effect.plane === plane),
  );
  const words = planes.map((plane) => SIDE_EFFECT_PLANE_WORDS[plane]);
  const list =
    words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")} and ${words.at(-1)!}`;
  const verb = planes.length === 1 && planes[0] !== "walk" ? "changes" : "change";
  const entries = report.effects.map(
    ({ label, plane, count, bbox, fill }) =>
      `${label}${planes.length > 1 ? ` ${SIDE_EFFECT_PLANE_WORDS[plane]}` : ""}: ${count} cell${count === 1 ? "" : "s"} at ${bbox.x0},${bbox.y0}..${bbox.x1},${bbox.y1}${fill ? " (its fill re-pours)" : ""}`,
  );
  return `Side effects: other items' ${list} ${verb}. ${entries.join("; ")}.`;
}
