/**
 * Sprite Studio edit operations: the one kernel through which the UI and the
 * agent change a VIEW document. Operations are pure: each returns a new
 * document, re-encoded and decoded again (spriteDocument.ts `withLoops`), or
 * a refusal. An operation that changes nothing returns the same document.
 *
 * Copy-on-write. Loops that share one data block (an alias group, usually a
 * loop and its mirror) are edited as follows:
 * - By default an edit to a cel of a shared loop isolates that loop first: it
 *   gets its own block holding its displayed pixels plus the edit, and the
 *   other members keep the shared block untouched (`isolated` names it).
 * - `propagate: true` edits the shared block instead, so every member
 *   changes; a member that displays the block mirrored shows the edit
 *   mirrored.
 * - A recolor whose scope covers the same cels of every member edits the
 *   block, since recolouring commutes with mirroring and keeps them equal.
 * Nothing propagates without one of these.
 */
import {
  blankCel,
  detachCel,
  fillCel,
  flipCel,
  mirroredCel,
  recolorCel,
  requireInteger,
  resizeCel,
  setPixels,
  setTransparent,
  shiftCel,
  SpriteRefusal,
  type PixelChange,
  type ResizeAnchor,
} from "./spriteCels.ts";
import {
  mirrorPixels,
  sameDisplay,
  sameLoops,
  withLoops,
  type SpriteCel,
  type SpriteDocument,
  type SpriteLoop,
} from "./spriteDocument.ts";

export interface CelRef {
  readonly loop: number;
  readonly cel: number;
}

interface Propagation {
  /** Edit the shared data block so every loop sharing it changes. Default false. */
  readonly propagate?: boolean;
}

export type SpriteEdit =
  | ({ readonly type: "setPixels"; readonly changes: readonly PixelChange[] } & CelRef &
      Propagation)
  | ({
      readonly type: "fillCel";
      readonly x: number;
      readonly y: number;
      /** 0..15, or null for transparent. */
      readonly color: number | null;
    } & CelRef &
      Propagation)
  | ({
      readonly type: "recolor";
      /** Listed cels, every cel of `loop`, or every cel of the view. */
      readonly scope: readonly CelRef[] | "loop" | "view";
      /** Required with scope "loop". */
      readonly loop?: number;
      readonly from: number;
      readonly to: number;
    } & Propagation)
  | ({ readonly type: "flipCel"; readonly axis: "h" | "v" } & CelRef & Propagation)
  | ({ readonly type: "shiftCel"; readonly dx: number; readonly dy: number } & CelRef & Propagation)
  | ({
      readonly type: "resizeCel";
      readonly width: number;
      readonly height: number;
      /** Default "bottom-center". */
      readonly anchor?: ResizeAnchor;
    } & CelRef &
      Propagation)
  | ({ readonly type: "setTransparent"; readonly color: number; readonly remap?: number } & CelRef &
      Propagation)
  | ({
      readonly type: "addCel";
      readonly loop: number;
      /** Insert before this cel; the cel count appends. */
      readonly at: number;
      /** A copy of this displayed cel, or (default) a transparent cel sized like its neighbour. */
      readonly from?: CelRef | "blank";
    } & Propagation)
  | ({ readonly type: "deleteCel" } & CelRef & Propagation)
  | ({ readonly type: "moveCel"; readonly to: number } & CelRef & Propagation)
  | {
      readonly type: "addLoop";
      /** Insert before this loop; the loop count appends. */
      readonly at: number;
      /** An independent copy of this loop's displayed cels, or (default) one transparent cel. */
      readonly from?: number | "blank";
      /** Share this loop's data block, displayed mirrored. Excludes `from`. */
      readonly mirrorOf?: number;
    }
  | { readonly type: "deleteLoop"; readonly loop: number }
  | { readonly type: "unlinkMirror"; readonly loop: number }
  | {
      readonly type: "linkMirror";
      readonly loop: number;
      readonly of: number;
      /** Replace the loop's cels with the mirror of `of`'s even when they differ. */
      readonly force?: boolean;
    };

export type SpriteEditResult =
  | {
      readonly document: SpriteDocument;
      /** Loops (new indices) split from a shared data block by copy-on-write. */
      readonly isolated: readonly number[];
    }
  | { readonly error: string };

/** Loops keyed by data block: loops with one `id` share a block. */
interface Draft {
  readonly loops: { id: number; cels: SpriteCel[] }[];
  readonly packed: boolean;
  nextId: number;
  readonly isolated: Set<number>;
}

const MAX_LOOPS = 255;

function toDraft(document: SpriteDocument): Draft {
  return {
    loops: document.loops.map((loop, index) => ({
      id: loop.alias ?? index,
      cels: [...loop.cels],
    })),
    packed: document.packed,
    nextId: MAX_LOOPS + 1,
    isolated: new Set(),
  };
}

function fromDraft(draft: Draft): SpriteLoop[] {
  const owners = new Map<number, number>();
  return draft.loops.map(({ id, cels }, index) => {
    const owner = owners.get(id);
    if (owner === undefined) owners.set(id, index);
    return {
      alias: owner ?? null,
      mirroredDisplay: cels.some((cel) => cel.mirrored),
      cels,
    };
  });
}

function loopIndex(draft: Draft, value: unknown, label = "loop"): number {
  return requireInteger(value, label, 0, draft.loops.length - 1);
}

function celOf(draft: Draft, ref: CelRef, label = ""): SpriteCel {
  const loop = loopIndex(draft, ref.loop, `${label}loop`);
  const cels = draft.loops[loop]!.cels;
  return cels[requireInteger(ref.cel, `${label}cel`, 0, cels.length - 1)]!;
}

function members(draft: Draft, loop: number): number[] {
  const id = draft.loops[loop]!.id;
  const out: number[] = [];
  draft.loops.forEach((entry, index) => {
    if (entry.id === id) out.push(index);
  });
  return out;
}

/** Give a shared loop its own block of its displayed cels; false when it was not shared. */
function isolate(draft: Draft, loop: number): boolean {
  if (members(draft, loop).length === 1) return false;
  const id = draft.nextId++;
  draft.loops[loop] = { id, cels: draft.loops[loop]!.cels.map(detachCel) };
  draft.isolated.add(id);
  return true;
}

/** The loops a structural edit of `loop` applies to, after copy-on-write. */
function editScope(draft: Draft, loop: number, propagate: boolean): number[] {
  if (!propagate) isolate(draft, loop);
  return members(draft, loop);
}

/** Replace one displayed cel under the copy-on-write rules. */
function writeCel(
  draft: Draft,
  loop: number,
  cel: number,
  next: SpriteCel,
  propagate: boolean,
): void {
  const current = draft.loops[loop]!.cels[cel]!;
  if (sameDisplay(current, next)) return;
  for (const member of editScope(draft, loop, propagate)) {
    const cels = draft.loops[member]!.cels;
    const shown = cels[cel]!;
    const flipped = shown.mirrored !== draft.loops[loop]!.cels[cel]!.mirrored;
    cels[cel] = {
      ...shown,
      width: next.width,
      height: next.height,
      transparent: next.transparent,
      pixels: flipped ? mirrorPixels(next.pixels, next.width, next.height) : next.pixels,
    };
  }
}

function editCel(
  draft: Draft,
  op: CelRef & Propagation,
  transform: (cel: SpriteCel) => SpriteCel,
): void {
  const cel = celOf(draft, op);
  writeCel(draft, op.loop, op.cel, transform(cel), op.propagate === true);
}

function recolor(draft: Draft, op: Extract<SpriteEdit, { type: "recolor" }>): void {
  const from = requireInteger(op.from, "from", 0, 15);
  const to = requireInteger(op.to, "to", 0, 15);
  if (from === to) throw new SpriteRefusal(`from and to are both ${from}`);
  const targets = new Map<number, Set<number>>();
  const add = (loop: number, cel: number) => {
    if (!targets.has(loop)) targets.set(loop, new Set());
    targets.get(loop)!.add(cel);
  };
  if (op.scope === "view" || op.scope === "loop") {
    const loops =
      op.scope === "view" ? draft.loops.map((_, index) => index) : [loopIndex(draft, op.loop)];
    for (const loop of loops) draft.loops[loop]!.cels.forEach((_, cel) => add(loop, cel));
  } else if (Array.isArray(op.scope)) {
    op.scope.forEach((ref, index) => {
      celOf(draft, ref, `scope[${index}].`);
      add(ref.loop, ref.cel);
    });
  } else throw new SpriteRefusal(`scope must be "loop", "view" or a list of cels`);
  // A block every member recolours alike is recoloured in place.
  const sameCels = (a: Set<number> | undefined, b: Set<number>) =>
    a !== undefined && a.size === b.size && [...b].every((cel) => a.has(cel));
  const inPlace = new Map<number, boolean>();
  for (const [loop, cels] of targets)
    inPlace.set(
      loop,
      op.propagate === true ||
        members(draft, loop).every((member) => sameCels(targets.get(member), cels)),
    );
  for (const [loop, cels] of targets)
    for (const cel of cels) {
      const current = draft.loops[loop]!.cels[cel]!;
      const next = recolorCel(current, from, to, `loop ${loop}, cel ${cel}`);
      writeCel(draft, loop, cel, next, inPlace.get(loop)!);
    }
}

function addCel(draft: Draft, op: Extract<SpriteEdit, { type: "addCel" }>): void {
  const loop = loopIndex(draft, op.loop);
  const count = draft.loops[loop]!.cels.length;
  const at = requireInteger(op.at, "at", 0, count);
  const max = draft.packed ? 15 : 255;
  if (count + 1 > max) throw new SpriteRefusal(`loop ${loop} already has the maximum ${max} cels`);
  const neighbour = Math.min(at, count - 1);
  const model = draft.loops[loop]!.cels[neighbour]!;
  const source =
    op.from === undefined || op.from === "blank"
      ? blankCel(model.width, model.height, model.transparent)
      : celOf(draft, op.from, "from.");
  for (const member of editScope(draft, loop, op.propagate === true)) {
    // The new cel joins the regime of its neighbour: same stored metadata,
    // shown mirrored wherever the neighbour is.
    const beside = draft.loops[member]!.cels[neighbour]!;
    const flipped = beside.mirrored !== draft.loops[loop]!.cels[neighbour]!.mirrored;
    draft.loops[member]!.cels.splice(at, 0, {
      ...beside,
      width: source.width,
      height: source.height,
      transparent: source.transparent,
      pixels: flipped ? mirrorPixels(source.pixels, source.width, source.height) : source.pixels,
    });
  }
}

function deleteCel(draft: Draft, op: Extract<SpriteEdit, { type: "deleteCel" }>): void {
  celOf(draft, op);
  if (draft.loops[op.loop]!.cels.length === 1)
    throw new SpriteRefusal(`cannot delete the last cel of loop ${op.loop}; delete the loop`);
  for (const member of editScope(draft, op.loop, op.propagate === true))
    draft.loops[member]!.cels.splice(op.cel, 1);
}

function moveCel(draft: Draft, op: Extract<SpriteEdit, { type: "moveCel" }>): void {
  celOf(draft, op);
  const to = requireInteger(op.to, "to", 0, draft.loops[op.loop]!.cels.length - 1);
  if (to === op.cel) return;
  for (const member of editScope(draft, op.loop, op.propagate === true)) {
    const cels = draft.loops[member]!.cels;
    cels.splice(to, 0, ...cels.splice(op.cel, 1));
  }
}

function addLoop(draft: Draft, op: Extract<SpriteEdit, { type: "addLoop" }>): void {
  const count = draft.loops.length;
  const at = requireInteger(op.at, "at", 0, count);
  if (count + 1 > MAX_LOOPS)
    throw new SpriteRefusal(`the view already has the maximum ${MAX_LOOPS} loops`);
  if (op.mirrorOf !== undefined && op.from !== undefined)
    throw new SpriteRefusal("give either from or mirrorOf, not both");
  let loop: Draft["loops"][number];
  if (op.mirrorOf !== undefined) {
    const of = draft.loops[loopIndex(draft, op.mirrorOf, "mirrorOf")]!;
    loop = { id: of.id, cels: of.cels.map(mirroredCel) };
  } else if (op.from === undefined || op.from === "blank") {
    const model = draft.loops[Math.min(at, count - 1)]!.cels[0]!;
    loop = { id: draft.nextId++, cels: [blankCel(model.width, model.height, model.transparent)] };
  } else {
    const from = draft.loops[loopIndex(draft, op.from, "from")]!;
    loop = { id: draft.nextId++, cels: from.cels.map(detachCel) };
  }
  draft.loops.splice(at, 0, loop);
}

function linkMirror(draft: Draft, op: Extract<SpriteEdit, { type: "linkMirror" }>): void {
  const loop = loopIndex(draft, op.loop);
  const of = loopIndex(draft, op.of, "of");
  if (loop === of) throw new SpriteRefusal("a loop cannot mirror itself");
  const source = draft.loops[of]!;
  if (draft.loops[loop]!.id === source.id)
    throw new SpriteRefusal(`loop ${loop} already shares loop ${of}'s data block`);
  const mirrored = source.cels.map(mirroredCel);
  const current = draft.loops[loop]!.cels;
  const exact =
    current.length === mirrored.length &&
    current.every((cel, index) => sameDisplay(cel, mirrored[index]!));
  if (!exact && op.force !== true)
    throw new SpriteRefusal(
      `loop ${loop}'s cels are not exact mirror images of loop ${of}'s; pass force to replace them`,
    );
  draft.loops[loop] = { id: source.id, cels: mirrored };
}

function dispatch(draft: Draft, op: SpriteEdit): void {
  switch (op.type) {
    case "setPixels":
      return editCel(draft, op, (cel) => setPixels(cel, op.changes));
    case "fillCel":
      return editCel(draft, op, (cel) => fillCel(cel, op.x, op.y, op.color));
    case "recolor":
      return recolor(draft, op);
    case "flipCel":
      return editCel(draft, op, (cel) => flipCel(cel, op.axis));
    case "shiftCel":
      return editCel(draft, op, (cel) => shiftCel(cel, op.dx, op.dy));
    case "resizeCel":
      return editCel(draft, op, (cel) => resizeCel(cel, op.width, op.height, op.anchor));
    case "setTransparent":
      return editCel(draft, op, (cel) => setTransparent(cel, op.color, op.remap));
    case "addCel":
      return addCel(draft, op);
    case "deleteCel":
      return deleteCel(draft, op);
    case "moveCel":
      return moveCel(draft, op);
    case "addLoop":
      return addLoop(draft, op);
    case "deleteLoop": {
      const loop = loopIndex(draft, op.loop);
      if (draft.loops.length === 1) throw new SpriteRefusal("cannot delete the view's last loop");
      draft.loops.splice(loop, 1);
      return;
    }
    case "unlinkMirror":
      if (!isolate(draft, loopIndex(draft, op.loop)))
        throw new SpriteRefusal(`loop ${op.loop} does not share its data block`);
      return;
    case "linkMirror":
      return linkMirror(draft, op);
    default:
      throw new SpriteRefusal(`unknown sprite edit '${String((op as { type?: unknown }).type)}'`);
  }
}

/** Apply one edit. Refusals and unencodable results come back as `{ error }`. */
export function applySpriteEdit(document: SpriteDocument, op: SpriteEdit): SpriteEditResult {
  try {
    const draft = toDraft(document);
    dispatch(draft, op);
    const loops = fromDraft(draft);
    if (sameLoops(loops, document.loops, true)) return { document, isolated: [] };
    const isolated = draft.loops.flatMap(({ id }, index) =>
      draft.isolated.has(id) ? [index] : [],
    );
    return { document: withLoops(document, loops), isolated };
  } catch (error) {
    if (error instanceof SpriteRefusal || error instanceof RangeError)
      return { error: error.message };
    throw error;
  }
}
