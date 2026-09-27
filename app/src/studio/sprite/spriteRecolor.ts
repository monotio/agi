/**
 * The recolour tool's arithmetic, pure: the kernel's `recolor` edit for one
 * colour to another over this cel, this loop or the whole view, the cels it
 * reaches, how many displayed pixels change, and the loops validation lets
 * it change (validateSpriteEdit's `targetLoops`). The reach follows the
 * kernel's copy-on-write (spriteOperations.ts): a recolour of one loop of a
 * linked group makes that loop a separate copy, unless edits propagate to
 * the group ("Edit loop N instead"), and a whole-view recolour changes every
 * linked loop alike.
 */

import type { SpriteDocument } from "../../../../src/studio/sprite/spriteDocument.ts";
import type { CelRef, SpriteEdit } from "../../../../src/studio/sprite/spriteOperations.ts";
import { aliasGroup } from "./spriteView.ts";

export type RecolorScope = "cel" | "loop" | "view";
export type RecolorEdit = Extract<SpriteEdit, { type: "recolor" }>;

/** The kernel edit recolouring `from` to `to` over `scope`, seen from the edited cel `at`. */
export function recolorEdit(
  scope: RecolorScope,
  at: CelRef,
  from: number,
  to: number,
  propagate: boolean,
): RecolorEdit {
  const edit = { type: "recolor", from, to, ...(propagate ? { propagate: true } : {}) } as const;
  if (scope === "view") return { ...edit, scope: "view" };
  if (scope === "loop") return { ...edit, scope: "loop", loop: at.loop };
  return { ...edit, scope: [{ loop: at.loop, cel: at.cel }] };
}

/** The displayed cels the edit reaches, loop then cel order. */
function recolorCels(document: SpriteDocument, edit: RecolorEdit): CelRef[] {
  const reached = new Set<string>();
  const out: CelRef[] = [];
  const add = (loop: number, cel: number): void => {
    if (!document.loops[loop]?.cels[cel] || reached.has(`${loop}:${cel}`)) return;
    reached.add(`${loop}:${cel}`);
    out.push({ loop, cel });
  };
  const spread = (loop: number): number[] =>
    edit.propagate === true ? aliasGroup(document, loop) : [loop];
  if (edit.scope === "view")
    document.loops.forEach((entry, loop) => entry.cels.forEach((_, cel) => add(loop, cel)));
  else if (edit.scope === "loop") {
    for (const loop of spread(edit.loop ?? 0))
      document.loops[loop]?.cels.forEach((_, cel) => add(loop, cel));
  } else for (const ref of edit.scope) for (const loop of spread(ref.loop)) add(loop, ref.cel);
  return out.sort((a, b) => a.loop - b.loop || a.cel - b.cel);
}

/** The loops the edit may change: its validation's `targetLoops`. */
export function recolorTargets(document: SpriteDocument, edit: RecolorEdit): number[] {
  return [...new Set(recolorCels(document, edit).map(({ loop }) => loop))];
}

export interface RecolorCount {
  /** Displayed pixels that change colour. */
  readonly pixels: number;
  /** Cels with at least one of them. */
  readonly cels: number;
  /** The first reached cel whose transparent colour is `to` while it holds `from` pixels: the kernel refuses. */
  readonly clash: CelRef | null;
  /** Loops of a linked group the edit splits off as separate copies. */
  readonly copies: readonly number[];
}

/**
 * The `from` pixels the edit reaches (all change unless `to` is `from`, which
 * the kernel refuses). A cel's transparent pixels never change (a `from`
 * that is the cel's transparent colour reaches nothing there), and a cel
 * whose transparent colour is `to` cannot take it.
 */
export function recolorCount(document: SpriteDocument, edit: RecolorEdit): RecolorCount {
  let pixels = 0;
  let cels = 0;
  let clash: CelRef | null = null;
  const changed = new Set<number>();
  for (const ref of recolorCels(document, edit)) {
    const cel = document.loops[ref.loop]!.cels[ref.cel]!;
    if (edit.from === cel.transparent) continue;
    let count = 0;
    for (const value of cel.pixels) if (value === edit.from) count++;
    if (count === 0) continue;
    if (edit.to === cel.transparent) clash ??= ref;
    pixels += count;
    cels++;
    changed.add(ref.loop);
  }
  // A changed loop whose group is not wholly reached becomes its own copy.
  const reached = new Set(recolorTargets(document, edit));
  const copies = [...changed].filter((loop) =>
    aliasGroup(document, loop).some((member) => !reached.has(member)),
  );
  return { pixels, cels, clash, copies };
}
