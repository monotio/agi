/**
 * Sprite edit validation: the UI and the agent pass the same check, which
 * compares the DECODED display of every loop and cel before and after an
 * edit, never the operation. Loops and cels are compared by index.
 *
 * A pixel counts as changed when its colour or its transparency differs, so
 * swapping the transparent colour without changing what is drawn is no pixel
 * change (it is reported as a metadata change). A cel whose size changed
 * counts every pixel of the larger size as changed.
 */
import type { SpriteCel, SpriteDocument } from "./spriteDocument.ts";

export interface SpriteEditConstraints {
  /** Cels whose displayed pixels may not change. */
  readonly protectedCels?: readonly { readonly loop: number; readonly cel: number }[];
  /** Loops none of whose cels, cel count or metadata may change. */
  readonly protectedLoops?: readonly number[];
  /**
   * Loops that shared a data block before the edit may not all change: an
   * edit of one member that reached the others is an accidental propagation.
   */
  readonly protectMirrors?: boolean;
  /** The loops the edit targets; a changed cel of any other loop is reported. */
  readonly targetLoops?: readonly number[];
}

interface ChangedCel {
  readonly loop: number;
  readonly cel: number;
  /** How many display pixels differ. */
  readonly pixels: number;
}

type SpriteViolation =
  | {
      readonly constraint: "protected-cel" | "protected-loop" | "outside-target";
      readonly loop: number;
      /** Absent for a loop-level change: cel count or alias. */
      readonly cel?: number;
      readonly pixels?: number;
      readonly message: string;
    }
  | {
      readonly constraint: "mirror-propagation";
      /** The members of one former alias group that all changed. */
      readonly loops: readonly number[];
      readonly message: string;
    };

type SpriteMetadataChange =
  | { readonly kind: "loop-count"; readonly before: number; readonly after: number }
  | {
      readonly kind: "cel-count";
      readonly loop: number;
      readonly before: number;
      readonly after: number;
    }
  | {
      readonly kind: "alias";
      readonly loop: number;
      readonly before: number | null;
      readonly after: number | null;
    }
  | {
      readonly kind: "mirror-bit" | "transparent";
      readonly loop: number;
      readonly cel: number;
      readonly before: boolean | number;
      readonly after: boolean | number;
    }
  | {
      readonly kind: "description";
      readonly before: string | null;
      readonly after: string | null;
    };

export interface SpriteValidation {
  readonly ok: boolean;
  readonly violations: readonly SpriteViolation[];
  /** Every cel whose displayed pixels changed, loop then cel order. */
  readonly changedCels: readonly ChangedCel[];
  /** Header and metadata changes: counts, aliases, mirror bits, transparency, description. */
  readonly metadata: readonly SpriteMetadataChange[];
}

/** Pixels that differ in colour or transparency; every pixel of the larger cel on a size change. */
function pixelDifference(a: SpriteCel | undefined, b: SpriteCel | undefined): number {
  if (!a || !b) return Math.max(a ? a.width * a.height : 0, b ? b.width * b.height : 0);
  if (a.width !== b.width || a.height !== b.height)
    return Math.max(a.width * a.height, b.width * b.height);
  let count = 0;
  for (let i = 0; i < a.pixels.length; i++) {
    const pa = a.pixels[i] === a.transparent ? -1 : a.pixels[i];
    const pb = b.pixels[i] === b.transparent ? -1 : b.pixels[i];
    if (pa !== pb) count++;
  }
  return count;
}

function metadataChanges(before: SpriteDocument, after: SpriteDocument): SpriteMetadataChange[] {
  const out: SpriteMetadataChange[] = [];
  if (before.loops.length !== after.loops.length)
    out.push({ kind: "loop-count", before: before.loops.length, after: after.loops.length });
  const shared = Math.min(before.loops.length, after.loops.length);
  for (let loop = 0; loop < shared; loop++) {
    const a = before.loops[loop]!;
    const b = after.loops[loop]!;
    if (a.cels.length !== b.cels.length)
      out.push({ kind: "cel-count", loop, before: a.cels.length, after: b.cels.length });
    if (a.alias !== b.alias) out.push({ kind: "alias", loop, before: a.alias, after: b.alias });
    const cels = Math.min(a.cels.length, b.cels.length);
    for (let cel = 0; cel < cels; cel++) {
      const ca = a.cels[cel]!;
      const cb = b.cels[cel]!;
      if (ca.mirrorBit !== cb.mirrorBit)
        out.push({ kind: "mirror-bit", loop, cel, before: ca.mirrorBit, after: cb.mirrorBit });
      if (ca.transparent !== cb.transparent)
        out.push({ kind: "transparent", loop, cel, before: ca.transparent, after: cb.transparent });
    }
  }
  if (before.description !== after.description)
    out.push({
      kind: "description",
      before: before.description ?? null,
      after: after.description ?? null,
    });
  return out;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Check an edit by its decoded display and report its metadata changes. */
export function validateSpriteEdit(
  before: SpriteDocument,
  after: SpriteDocument,
  constraints: SpriteEditConstraints = {},
): SpriteValidation {
  const changedCels: ChangedCel[] = [];
  const loops = Math.max(before.loops.length, after.loops.length);
  for (let loop = 0; loop < loops; loop++) {
    const a = before.loops[loop]?.cels ?? [];
    const b = after.loops[loop]?.cels ?? [];
    for (let cel = 0; cel < Math.max(a.length, b.length); cel++) {
      const pixels = pixelDifference(a[cel], b[cel]);
      if (pixels > 0) changedCels.push({ loop, cel, pixels });
    }
  }
  const metadata = metadataChanges(before, after);
  const violations: SpriteViolation[] = [];

  const protectedLoops = new Set(constraints.protectedLoops ?? []);
  const protectedCels = new Set(
    (constraints.protectedCels ?? []).map(({ loop, cel }) => `${loop}:${cel}`),
  );
  const targets = constraints.targetLoops ? new Set(constraints.targetLoops) : null;
  for (const { loop, cel, pixels } of changedCels) {
    const where = `loop ${loop}, cel ${cel}`;
    if (protectedLoops.has(loop))
      violations.push({
        constraint: "protected-loop",
        loop,
        cel,
        pixels,
        message: `${plural(pixels, "pixel")} changed in ${where} of protected loop ${loop}`,
      });
    else if (protectedCels.has(`${loop}:${cel}`))
      violations.push({
        constraint: "protected-cel",
        loop,
        cel,
        pixels,
        message: `${plural(pixels, "pixel")} changed in protected ${where}`,
      });
    else if (targets && !targets.has(loop))
      violations.push({
        constraint: "outside-target",
        loop,
        cel,
        pixels,
        message: `${plural(pixels, "pixel")} changed in ${where}, outside the edited loop${targets.size === 1 ? "" : "s"}`,
      });
  }
  for (const change of metadata) {
    if (!("loop" in change) || !protectedLoops.has(change.loop)) continue;
    const where = "cel" in change ? `cel ${change.cel}'s ` : "";
    violations.push({
      constraint: "protected-loop",
      loop: change.loop,
      ...("cel" in change ? { cel: change.cel } : {}),
      message: `protected loop ${change.loop} changed ${where}${change.kind}`,
    });
  }
  if (constraints.protectMirrors) {
    const changedLoops = new Set(changedCels.map(({ loop }) => loop));
    for (const group of aliasMembers(before))
      if (group.every((loop) => changedLoops.has(loop)))
        violations.push({
          constraint: "mirror-propagation",
          loops: group,
          message: `loops ${group.join(", ")} shared a data block and all changed; an edit of one reached the others`,
        });
  }
  return { ok: violations.length === 0, violations, changedCels, metadata };
}

/** The document's current alias groups of two or more loops. */
function aliasMembers(document: SpriteDocument): number[][] {
  const groups = new Map<number, number[]>();
  document.loops.forEach((loop, index) => {
    const owner = loop.alias ?? index;
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner)!.push(index);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}
