/**
 * The words and masks the Studio assist panel shows: the scope chips a
 * request is held to, and what a candidate changes, counted on decoded
 * planes and pixels (never taken from the model's summary).
 */

import type { PicturePlane } from "../../../src/studio/pictureQuery.ts";
import type { SpriteCel, SpriteDocument } from "../../../src/studio/sprite/spriteDocument.ts";
import type { CelRef } from "../../../src/studio/sprite/spriteOperations.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;

/** One chip above the Ask box: what the request may change, or what it may not. */
export interface ScopeChip {
  readonly text: string;
  readonly lock: boolean;
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

/** "Bench occluder"; "Bench, Bench shadow"; "Bench and 3 more". */
export function labelList(labels: readonly string[]): string {
  if (labels.length <= 2) return labels.join(", ");
  return `${labels[0]} and ${labels.length - 1} more`;
}

/** Room Studio: the selected items, the locked planes and the Walk lens depth rule. */
export function pictureScopeChips(input: {
  readonly labels: readonly string[];
  readonly lockedPlanes: readonly PicturePlane[];
  readonly depthValuesLocked: boolean;
}): ScopeChip[] {
  return [
    { text: `Only: ${labelList(input.labels)}`, lock: false },
    ...(input.lockedPlanes.includes("visual") ? [{ text: "Art is locked", lock: true }] : []),
    ...(input.lockedPlanes.includes("priority") ? [{ text: "Depth is locked", lock: true }] : []),
    ...(input.depthValuesLocked ? [{ text: "Depth values locked (Walk view)", lock: true }] : []),
  ];
}

/** Sprite Studio: the selected cels of one loop and the loops kept as they are. */
export function viewScopeChips(input: {
  readonly targetCels: readonly CelRef[];
  readonly protectedLoops: readonly number[];
}): ScopeChip[] {
  const loops = [...new Set(input.targetCels.map(({ loop }) => loop))];
  const only = loops.map((loop) => {
    const cels = input.targetCels.filter((ref) => ref.loop === loop).map(({ cel }) => cel);
    return `loop ${loop}, ${cels.length === 1 ? "cel" : "cels"} ${numberList(cels)}`;
  });
  const kept = input.protectedLoops;
  return [
    { text: `Only ${only.join("; ")}`, lock: false },
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

/** "80 depth cells inside Bridge"; "12 art cells and 80 depth cells inside Bench". */
export function pictureChangeSummary(
  before: { readonly visual: Uint8Array; readonly priority: Uint8Array },
  after: { readonly visual: Uint8Array; readonly priority: Uint8Array },
  where: string,
): string {
  let art = 0;
  let depth = 0;
  for (let i = 0; i < CELLS; i++) {
    if (before.visual[i] !== after.visual[i]) art++;
    if (before.priority[i] !== after.priority[i]) depth++;
  }
  const parts = [
    ...(art ? [plural(art, "art cell")] : []),
    ...(depth ? [plural(depth, "depth cell")] : []),
  ];
  return parts.length
    ? `${parts.join(" and ")} inside ${where}`
    : "No pixels change (only the picture's notes)";
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
