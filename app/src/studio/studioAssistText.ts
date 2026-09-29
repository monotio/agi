/**
 * The words and masks the Studio assist panel shows: the scope chips a
 * request is held to, and what a candidate changes, counted on decoded
 * planes and pixels (never taken from the model's summary).
 */

import type { PictureItem, PictureItemKind } from "../../../src/studio/pictureDocument.ts";
import type { SpriteCel, SpriteDocument } from "../../../src/view/spriteDocument.ts";
import type { CelRef } from "../../../src/studio/sprite/spriteOperations.ts";
import type { SideEffectReport } from "../../../src/studio/sideEffects.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;

/** One chip above the Ask box: what the request may change, or what it keeps. */
export interface ScopeChip {
  readonly text: string;
  readonly lock: boolean;
  /** The whole list, when the text sums it up. */
  readonly title?: string;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "0–3", "2", "0, 2, 5": sorted numbers, runs of three or more as ranges. */
export function numberList(values: readonly number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    if (j - i >= 2) parts.push(`${sorted[i]}–${sorted[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
    i = j + 1;
  }
  return parts.join(", ");
}

/**
 * The other items a picture candidate changes, as its side effects name
 * them: "Also changes: Grass, 17,802 cells."; "Also changes: Grass and Sky,
 * 17,822 cells."; four or more items are counted.
 */
export function alsoChanges(report: SideEffectReport): string {
  const labels = report.items.map((item) => item.label);
  const who =
    labels.length > 3
      ? `${labels.length} other items`
      : labels.length === 1
        ? labels[0]!
        : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!}`;
  const cells = `${report.cells.toLocaleString("en-US")} ${report.cells === 1 ? "cell" : "cells"}`;
  return `Also changes: ${who}, ${cells}.`;
}

/** "Bench occluder"; "Bench, Bench shadow"; "Bench and 3 more". */
export function labelList(labels: readonly string[]): string {
  if (labels.length <= 2) return labels.join(", ");
  return `${labels[0]} and ${labels.length - 1} more`;
}

/**
 * Room Studio: the selected items, by name for one and "These 3 items" for
 * several (the names on its tooltip). The lens's locks are the lock chip's
 * to say (StudioLockChip.vue), the same one the lens tabs carry.
 */
export function pictureScopeChips(labels: readonly string[]): ScopeChip[] {
  if (labels.length === 0) return [];
  return [
    labels.length === 1
      ? { text: labels[0]!, lock: false }
      : { text: `These ${labels.length} items`, lock: false, title: labels.join(", ") },
  ];
}

/** Sprite Studio: the selected cels of one loop, "Cel 0 · Loop 1", and the loops kept as they are. */
export function viewScopeChips(input: {
  readonly targetCels: readonly CelRef[];
  readonly protectedLoops: readonly number[];
}): ScopeChip[] {
  const loops = [...new Set(input.targetCels.map(({ loop }) => loop))];
  const only = loops.map((loop) => {
    const cels = input.targetCels.filter((ref) => ref.loop === loop).map(({ cel }) => cel);
    return `${cels.length === 1 ? "Cel" : "Cels"} ${numberList(cels)} · Loop ${loop}`;
  });
  const kept = input.protectedLoops;
  return [
    ...only.map((text) => ({ text, lock: false })),
    ...(kept.length
      ? [
          {
            text: `${kept.length === 1 ? "Loop" : "Loops"} ${numberList(kept)} protected`,
            lock: true,
          },
        ]
      : []),
  ];
}

/** 160x168: 1 where either plane differs. */
export function changedCells(
  before: { readonly visual: Uint8Array; readonly priority: Uint8Array },
  after: { readonly visual: Uint8Array; readonly priority: Uint8Array },
): Uint8Array {
  const mask = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++)
    if (before.visual[i] !== after.visual[i] || before.priority[i] !== after.priority[i])
      mask[i] = 1;
  return mask;
}

/** The items of a picture as the summary reads them. */
interface SummaryItems {
  readonly items: readonly Pick<PictureItem, "id" | "label" | "kind" | "locked">[];
}

/**
 * What a candidate changes about the items themselves, in the Scene list's
 * words: "relabels Bench occluder as "Old bench"", "makes Bench a depth
 * item", "adds Bench shadow", "removes Sign", "changes the drawing order".
 */
function itemChanges(before: SummaryItems, after: SummaryItems): string[] {
  const changes: string[] = [];
  const kept = new Map(after.items.map((item) => [item.id, item]));
  for (const was of before.items) {
    const now = kept.get(was.id);
    if (!now) {
      changes.push(`removes ${was.label}`);
      continue;
    }
    if (now.label !== was.label) changes.push(`relabels ${was.label} as "${now.label}"`);
    if (now.kind !== was.kind) changes.push(`makes ${now.label} ${KIND_WORDS[now.kind]}`);
    if (now.locked !== was.locked) changes.push(`${now.locked ? "locks" : "unlocks"} ${now.label}`);
  }
  const known = new Set(before.items.map((item) => item.id));
  for (const item of after.items) if (!known.has(item.id)) changes.push(`adds ${item.label}`);
  const order = (items: SummaryItems["items"]) =>
    items.flatMap((item) => (known.has(item.id) && kept.has(item.id) ? [item.id] : [])).join(" ");
  if (order(before.items) !== order(after.items)) changes.push("changes the drawing order");
  return changes;
}

const KIND_WORDS: Record<PictureItemKind, string> = {
  art: "an art item",
  depth: "a depth item",
  walk: "a walk item",
  mixed: "a mixed item",
};

/**
 * What a picture candidate changes, per plane, inside `area` (the selection's
 * cells when it was asked) and outside it, so no cell is called "inside"
 * that is not: "80 depth cells inside Bridge"; "12 art cells and 80 depth
 * cells inside Bench"; "80 depth cells inside Bridge, 12 outside". With
 * `spilled` (its side effects' cells, which "Also changes" names) it counts
 * by owner instead, only the cells outside them: "Island: 108 art cells
 * change". A candidate that changes no pixel says what it changes instead,
 * read from the documents when both sides carry one: "No pixels change:
 * relabels Bench occluder as "Old bench"".
 */
export function pictureChangeSummary(
  before: {
    readonly visual: Uint8Array;
    readonly priority: Uint8Array;
    readonly document?: SummaryItems;
  },
  after: {
    readonly visual: Uint8Array;
    readonly priority: Uint8Array;
    readonly document?: SummaryItems;
  },
  where: string,
  area: Uint8Array,
  spilled: Uint8Array | null = null,
): string {
  const inside = { art: 0, depth: 0 };
  const outside = { art: 0, depth: 0 };
  if (spilled) {
    for (let i = 0; i < CELLS; i++) {
      if (spilled[i] === 1) continue;
      if (before.visual[i] !== after.visual[i]) inside.art++;
      if (before.priority[i] !== after.priority[i]) inside.depth++;
    }
    const own = [
      ...(inside.art ? [plural(inside.art, "art cell")] : []),
      ...(inside.depth ? [plural(inside.depth, "depth cell")] : []),
    ];
    const total = inside.art + inside.depth;
    return own.length
      ? `${where}: ${own.join(" and ")} ${total === 1 ? "changes" : "change"}`
      : `${where}: none of its own cells change`;
  }
  for (let i = 0; i < CELLS; i++) {
    const side = area[i] === 1 ? inside : outside;
    if (before.visual[i] !== after.visual[i]) side.art++;
    if (before.priority[i] !== after.priority[i]) side.depth++;
  }
  const words = ({ art, depth }: typeof inside) => [
    ...(art ? [plural(art, "art cell")] : []),
    ...(depth ? [plural(depth, "depth cell")] : []),
  ];
  const [within, beyond] = [words(inside), words(outside)];
  if (beyond.length === 0) {
    if (within.length) return `${within.join(" and ")} inside ${where}`;
    const notes =
      before.document && after.document ? itemChanges(before.document, after.document) : [];
    return notes.length
      ? `No pixels change: ${notes.join(", ")}`
      : "No pixels change (only the picture's notes)";
  }
  if (within.length === 0) return `${beyond.join(" and ")} outside ${where}`;
  const samePlanes = inside.art > 0 === outside.art > 0 && within.length === 1;
  const rest = samePlanes ? String(outside.art + outside.depth) : beyond.join(" and ");
  return `${within.join(" and ")} inside ${where}, ${rest} outside`;
}

/** The walkable estimate on a Walk lens candidate, and a warning when it does not move. */
export function walkableWords(walkable: { readonly before: number; readonly after: number }): {
  readonly line: string;
  readonly unchanged: string | null;
} {
  const { before, after } = walkable;
  return {
    line: `Floor (estimate): ${before} → ${plural(after, "cell")} in the selection`,
    unchanged: before === after ? "The floor stays as it was." : null,
  };
}

/** Displayed pixels of `a` and `b` that differ; null when their sizes differ. */
export function changedPixels(
  a: SpriteCel | undefined,
  b: SpriteCel | undefined,
): Uint8Array | null {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return null;
  const mask = new Uint8Array(a.width * a.height);
  for (let i = 0; i < mask.length; i++) {
    const pa = a.pixels[i] === a.transparent ? -1 : a.pixels[i];
    const pb = b.pixels[i] === b.transparent ? -1 : b.pixels[i];
    if (pa !== pb) mask[i] = 1;
  }
  return mask;
}

/** "4 pixels in loop 1, cels 0–1"; a resized cel counts all its pixels. */
export function viewChangeSummary(before: SpriteDocument, after: SpriteDocument): string {
  let pixels = 0;
  const touched = new Map<number, number[]>();
  const loops = Math.max(before.loops.length, after.loops.length);
  for (let loop = 0; loop < loops; loop++) {
    const cels = Math.max(
      before.loops[loop]?.cels.length ?? 0,
      after.loops[loop]?.cels.length ?? 0,
    );
    for (let cel = 0; cel < cels; cel++) {
      const a = before.loops[loop]?.cels[cel];
      const b = after.loops[loop]?.cels[cel];
      const mask = changedPixels(a, b);
      const count = mask
        ? mask.reduce((sum, bit) => sum + bit, 0)
        : Math.max(a ? a.width * a.height : 0, b ? b.width * b.height : 0);
      if (count === 0) continue;
      pixels += count;
      touched.set(loop, [...(touched.get(loop) ?? []), cel]);
    }
  }
  if (pixels === 0) return "No displayed pixels change";
  const where = [...touched].map(
    ([loop, cels]) => `loop ${loop}, ${cels.length === 1 ? "cel" : "cels"} ${numberList(cels)}`,
  );
  return `${plural(pixels, "pixel")} in ${where.join("; ")}`;
}
