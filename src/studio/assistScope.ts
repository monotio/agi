/**
 * The scope contract of a Studio assist request: what an AI
 * proposal made from a Room Studio or Sprite Studio selection may change.
 * The UI builds it from the selection and the lens; `checkCandidate` holds a
 * candidate to it on DECODED pixels, whatever the proposal's operations or
 * the model's words claim. Pure and deterministic.
 *
 * Pictures. A candidate must start from `baseRevision`, keep every item
 * outside `targetIds` (id, label, kind and lock), change no item's lock
 * (locks are the creator's: a proposal never locks or unlocks an item, a
 * selected one included, nor adds a locked one), leave `lockedPlanes`
 * untouched, fit `maxBytes`, and change each plane only inside that plane's
 * allowed cells (`licence`): the ask-time area (the targets' old
 * footprints on the plane plus `allowedMask` when given), and the cells the
 * targets' bounded commands own after the edit. Lines, corners, rectangles
 * and plots lie on their own coordinates, so a reshaped or moved target may
 * take its new cells. A fill is bounded by nothing of its own: its cells are
 * allowed only inside the ask-time area, or inside a target's old area moved
 * by the offset the candidate moved (or duplicated) it by, read from the
 * decoded geometry. A fill that spills past that is a `fill-spill`.
 * `allowedMask` only adds cells; it never lifts the footprint rule. New items
 * a proposal inserts get no licence of their own: their pixels must land in
 * the allowed cells. The one exception is a duplicate, as manual Duplicate
 * makes: each target licenses ONE translated position, its own move or else
 * one new item repeating its commands with the same registers (colours and
 * pen), whose old area on each plane moved is allowed on that plane. A
 * further repeat, or one in other colours, is an `extra-copy` where it lands
 * outside the allowed cells. The lens rules a manual edit passes
 * (lensRules.ts: the Walk lens keeps depth values 4–15) apply too, with the
 * targets and the items the candidate creates as the edited items.
 * `pictureAssistScope` licenses the selection's on-screen area on every
 * unlocked plane, so "make this bridge walkable" in the Walk lens may paint
 * priority under the selected bridge art.
 *
 * Views. A candidate must start from `baseRevision`, change displayed pixels
 * only in `targetCels`, leave `protectedLoops` untouched (pixels and
 * metadata), change loop metadata only on loops that hold a target, never
 * change the loop count or description, and fit `maxBytes`. Copy-on-write
 * splitting a targeted mirror loop from its partner re-links both: allowed
 * for the partner too (its link and mirror bits, even when it is protected)
 * while the partner's pixels stay; a change reaching its pixels is not.
 */

import { PAYLOAD_MAX_BYTES } from "../container/container.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import {
  filledCell,
  footprintMask,
  unionMask,
  validateEdit,
  type AllowedMask,
  type CellBox,
  type CompiledDocument,
} from "./editValidation.ts";
import { commandTokens, EditRefusal, translateLine } from "./editSource.ts";
import { commandHead, drawStateBeforeLine } from "./editState.ts";
import {
  checkLensRules,
  lockedPlanes,
  NO_UNLOCKS,
  type LensUnlocks,
  type StudioLens,
} from "./lensRules.ts";
import {
  serializePictureDocument,
  type PictureDocument,
  type PictureItem,
} from "./pictureDocument.ts";
import { itemAt, type PicturePlane } from "./pictureQuery.ts";
import type { SpriteDocument } from "../view/spriteDocument.ts";
import type { CelRef } from "./sprite/spriteOperations.ts";
import { validateSpriteEdit } from "./sprite/spriteValidation.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;
const PLANES: readonly PicturePlane[] = ["visual", "priority"];

/** A Studio draft as the assist sees it: picture source text, or an encoded VIEW. */
export type AssistDraft =
  | { readonly kind: "picture"; readonly source: string }
  | { readonly kind: "view"; readonly payload: Uint8Array };

export interface PictureAssistScope {
  readonly kind: "picture";
  readonly num: number;
  /** `draftRevision` of the draft the request was made against. */
  readonly baseRevision: string;
  /** The selected item ids. */
  readonly targetIds: readonly string[];
  /** Planes that may not change anywhere. */
  readonly lockedPlanes: readonly PicturePlane[];
  /** The Studio lens and the creator's unlocks: the lens rules (lensRules.ts) apply as to a manual edit. */
  readonly lens: StudioLens;
  readonly unlocks: LensUnlocks;
  /** Cells licensed beyond the targets' own footprints; never a way around them. */
  readonly allowedMask?: AllowedMask;
  /** The largest compiled picture, in bytes. */
  readonly maxBytes: number;
}

export interface ViewAssistScope {
  readonly kind: "view";
  readonly num: number;
  readonly baseRevision: string;
  /** The selected cels: the only cels whose displayed pixels may change. */
  readonly targetCels: readonly CelRef[];
  /** Loops none of whose pixels or metadata may change. */
  readonly protectedLoops?: readonly number[];
  /** The largest encoded VIEW, in bytes. */
  readonly maxBytes: number;
}

export type AssistScope = PictureAssistScope | ViewAssistScope;

type AssistConstraint =
  | "stale-base"
  | "unknown-target"
  | "outside-target"
  | "item-lock"
  | "locked-plane"
  | "outside-mask"
  | "fill-spill"
  | "extra-copy"
  | "walk-depth"
  | "protected-loop"
  | "max-bytes";

interface AssistViolation {
  readonly constraint: AssistConstraint;
  /** Plain words: what the candidate would break. */
  readonly message: string;
  readonly plane?: PicturePlane;
  readonly loop?: number;
  readonly cel?: number;
  /** Cells or pixels that break the constraint. */
  readonly count?: number;
  readonly bbox?: CellBox;
}

export interface AssistCheck {
  readonly ok: boolean;
  readonly violations: readonly AssistViolation[];
}

/** FNV-1a over 16-bit units (source text) or bytes (payloads). */
function fnv(length: number, unit: (index: number) => number): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < length; i++) {
    const value = unit(i);
    hash = Math.imul(hash ^ (value & 0xff), 0x01000193) >>> 0;
    if (value > 0xff) hash = Math.imul(hash ^ (value >>> 8), 0x01000193) >>> 0;
  }
  return `${length}-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * The draft's revision: `picture-<length>-<fnv>` over the source text (so a
 * label edit is a new revision), `view-<length>-<fnv>` over the payload.
 */
export function draftRevision(draft: AssistDraft): string {
  if (draft.kind === "picture") {
    const { source } = draft;
    return `picture-${fnv(source.length, (i) => source.charCodeAt(i))}`;
  }
  const { payload } = draft;
  return `view-${fnv(payload.length, (i) => payload[i]!)}`;
}

/** 160x168: 1 where any target owns the final cell on either plane (its on-screen area). */
export function selectionArea(
  compiled: CompiledDocument,
  targetIds: readonly string[],
): Uint8Array {
  return unionMask(...targetIds.map((id) => footprintMask(compiled, id, "both")));
}

/**
 * The scope the UI sends for a Room Studio selection: the draft's revision,
 * the lens and unlocks the Studio holds (and so its locked planes), and the
 * selection's on-screen area licensed on every unlocked plane.
 */
export function pictureAssistScope(input: {
  readonly num: number;
  readonly compiled: CompiledDocument;
  readonly targetIds: readonly string[];
  readonly lens: StudioLens;
  readonly unlocks?: LensUnlocks;
  readonly maxBytes?: number;
}): PictureAssistScope {
  const unlocks = input.unlocks ?? NO_UNLOCKS;
  const locked = lockedPlanes(input.lens, unlocks);
  const area = selectionArea(input.compiled, input.targetIds);
  const allowedMask: { visual?: Uint8Array; priority?: Uint8Array } = {};
  for (const plane of PLANES) if (!locked.includes(plane)) allowedMask[plane] = area;
  return {
    kind: "picture",
    num: input.num,
    baseRevision: draftRevision({
      kind: "picture",
      source: serializePictureDocument(input.compiled.document),
    }),
    targetIds: [...input.targetIds],
    lockedPlanes: locked,
    lens: input.lens,
    unlocks: { ...unlocks },
    allowedMask,
    maxBytes: input.maxBytes ?? PAYLOAD_MAX_BYTES,
  };
}

/** The scope the UI sends for a Sprite Studio selection of cels. */
export function viewAssistScope(input: {
  readonly num: number;
  readonly document: SpriteDocument;
  readonly targetCels: readonly CelRef[];
  readonly protectedLoops?: readonly number[];
  readonly maxBytes?: number;
}): ViewAssistScope {
  return {
    kind: "view",
    num: input.num,
    baseRevision: draftRevision({ kind: "view", payload: input.document.payload }),
    targetCels: input.targetCels.map(({ loop, cel }) => ({ loop, cel })),
    ...(input.protectedLoops ? { protectedLoops: [...input.protectedLoops] } : {}),
    maxBytes: input.maxBytes ?? PAYLOAD_MAX_BYTES,
  };
}

/** The extra cells `allowed` licenses on `plane`, checked for size. */
function extraCells(allowed: AllowedMask | undefined, plane: PicturePlane): Uint8Array | undefined {
  const mask = allowed instanceof Uint8Array ? allowed : allowed?.[plane];
  if (mask !== undefined && mask.length !== CELLS)
    throw new RangeError(`allowedMask has ${mask.length} cells; expected ${CELLS}`);
  return mask;
}

/** Heads of the commands whose coordinates `translateLine` moves. */
const GEOMETRY = new Set([
  "line",
  "polyline",
  "polygon",
  "rect",
  "fill",
  "plot",
  "rel",
  "xcorner",
  "ycorner",
]);

/** Heads that set a register: a copy is compared by the registers its commands draw with. */
const STATE_HEADS = new Set(["vis", "visual", "pri", "priority", "pen"]);

/** A drawing command line of an item: 1-based line and text. */
interface Drawing {
  readonly line: number;
  readonly text: string;
}

/** The item's command lines other than register settings, in order. */
const drawingOf = (document: PictureDocument, item: PictureItem): Drawing[] =>
  item.commandLines
    .map((line) => ({ line, text: document.lines[line - 1]! }))
    .filter(({ text }) => !STATE_HEADS.has(commandHead(text)));

/**
 * Every command byte read as a command, and the pen as its raw operand: the
 * visual and priority registers read the same under every profile, and a
 * copy's pen must be byte for byte its original's.
 */
const ANY_VOCABULARY = { pictureMaxCommand: 0xff, patternProfile: "shaped-v2" } as const;

/**
 * Whether each of `now`'s commands draws with the registers the command at
 * its index in `was` drew with: the same visual and priority values (or
 * off), and for a plot the same pen.
 */
function sameState(
  before: CompiledDocument,
  was: readonly Drawing[],
  after: CompiledDocument,
  now: readonly Drawing[],
): boolean {
  return was.every(({ line, text }, index) => {
    const a = drawStateBeforeLine(before, line, ANY_VOCABULARY);
    const b = drawStateBeforeLine(after, now[index]!.line, ANY_VOCABULARY);
    return (
      a.visual === b.visual &&
      a.priority === b.priority &&
      (commandHead(text) !== "plot" || a.pen === b.pen)
    );
  });
}

/**
 * The offset `moved` repeats `original`'s drawing at: every command of
 * `original` (register settings aside) moved by one dx,dy, in order and
 * nothing else, and whether each command draws with the same registers
 * (`sameState`); null when it is not such a repeat, or holds a copy or raw
 * line. Only an item with bounded commands counts: its outline moved with
 * its fills, while a bare fill encloses nothing, so any fill would pass as a
 * copy of it.
 */
function translation(
  before: CompiledDocument,
  original: PictureItem,
  after: CompiledDocument,
  moved: PictureItem,
): { dx: number; dy: number; sameState: boolean } | null {
  const was = drawingOf(before.document, original);
  const now = drawingOf(after.document, moved);
  if (was.length !== now.length || was.every(({ text }) => commandHead(text) === "fill"))
    return null;
  const anchor = was.findIndex(({ text }) => GEOMETRY.has(commandHead(text)));
  const pair = (text: string) => /^(-?\d+),(-?\d+)$/.exec(commandTokens(text)[1] ?? "");
  const from = anchor < 0 ? null : pair(was[anchor]!.text);
  const to = anchor < 0 ? null : pair(now[anchor]!.text);
  if (!from || !to) return null;
  const dx = Number(to[1]) - Number(from[1]);
  const dy = Number(to[2]) - Number(from[2]);
  try {
    const same = was.every(
      ({ text }, index) =>
        commandTokens(translateLine(text, 0, dx, dy)).join(" ") ===
        commandTokens(now[index]!.text).join(" "),
    );
    return same ? { dx, dy, sameState: sameState(before, was, after, now) } : null;
  } catch (error) {
    if (error instanceof EditRefusal) return null;
    throw error;
  }
}

/** `mask` moved by dx,dy; cells moved off the surface drop. */
function shifted(mask: Uint8Array, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    if (mask[i] !== 1) continue;
    const x = (i % SCREEN_WIDTH) + dx;
    const y = Math.floor(i / SCREEN_WIDTH) + dy;
    if (x >= 0 && x < SCREEN_WIDTH && y >= 0 && y < SCREEN_HEIGHT) out[y * SCREEN_WIDTH + x] = 1;
  }
  return out;
}

/** A new item that repeats a target somewhere the candidate gets no licence for, and why. */
interface Stray {
  /** The target's label. */
  readonly target: string;
  /** "second": the target already moved or was copied once; "colours": other registers. */
  readonly why: "second" | "colours";
}

interface Licence {
  /** Each plane's allowed cells. */
  readonly cells: Record<PicturePlane, Uint8Array>;
  /** New items repeating a target without a licence, by id. */
  readonly strays: ReadonlyMap<string, Stray>;
}

/**
 * Each plane's allowed cells: the ask-time area (the targets' old footprints
 * plus the scope's extra cells), the cells the targets' bounded commands own
 * after the edit, and at most ONE translated position per target, as manual
 * Move and Duplicate make: the target's own move (its old area on both
 * planes, moved), or else the first new item repeating it at an offset with
 * the same registers (its old area on each plane, moved). Any further repeat,
 * or one in other registers, gets nothing and is named a stray. A fill gets
 * no cells of its own.
 */
function licence(
  before: CompiledDocument,
  after: CompiledDocument,
  scope: Pick<PictureAssistScope, "targetIds" | "allowedMask">,
): Licence {
  const known = new Set(before.document.items.map((item) => item.id));
  const created = after.document.items.filter((item) => !known.has(item.id));
  const moved: Record<PicturePlane, Uint8Array[]> = { visual: [], priority: [] };
  const copies = new Set<string>();
  const strays = new Map<string, Stray>();
  for (const id of scope.targetIds) {
    const original = before.document.items.find((item) => item.id === id);
    if (!original) continue;
    const own = after.document.items.find((item) => item.id === id);
    const offset = own && translation(before, original, after, own);
    let placed = !!offset && (offset.dx !== 0 || offset.dy !== 0);
    if (offset && placed) {
      const area = shifted(footprintMask(before, id, "both"), offset.dx, offset.dy);
      for (const plane of PLANES) moved[plane].push(area);
    }
    for (const item of created) {
      const copy = translation(before, original, after, item);
      if (!copy || (copy.dx === 0 && copy.dy === 0)) continue;
      if (placed || !copy.sameState) {
        if (!strays.has(item.id))
          strays.set(item.id, { target: original.label, why: placed ? "second" : "colours" });
        continue;
      }
      placed = true;
      copies.add(item.id);
      for (const plane of PLANES)
        moved[plane].push(shifted(footprintMask(before, id, plane), copy.dx, copy.dy));
    }
  }
  for (const id of copies) strays.delete(id);
  const cells = (plane: PicturePlane) => {
    const extra = extraCells(scope.allowedMask, plane);
    return unionMask(
      ...(extra ? [extra] : []),
      ...moved[plane],
      ...scope.targetIds.flatMap((id) => [
        footprintMask(before, id, plane),
        footprintMask(after, id, plane, "bounded"),
      ]),
    );
  };
  return { cells: { visual: cells("visual"), priority: cells("priority") }, strays };
}

const PLANE_WORDS: Record<PicturePlane, string> = {
  visual: "art (visual plane)",
  priority: "depth and walk (priority plane)",
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
/** 23680 → "23,680": fixed grouping, whatever the locale. */
const grouped = (count: number) => String(count).replace(/\B(?=(\d{3})+$)/g, ",");
const at = (count: number, bbox: CellBox) =>
  `${plural(count, "cell")} at ${bbox.x0},${bbox.y0}..${bbox.x1},${bbox.y1}`;

/** A running count of cells and their bounding box. */
interface Tally {
  count: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const tally = (): Tally => ({ count: 0, x0: SCREEN_WIDTH, y0: SCREEN_HEIGHT, x1: -1, y1: -1 });
function add(into: Tally, x: number, y: number): void {
  into.count++;
  into.x0 = Math.min(into.x0, x);
  into.y0 = Math.min(into.y0, y);
  into.x1 = Math.max(into.x1, x);
  into.y1 = Math.max(into.y1, y);
}
const boxOf = ({ x0, y0, x1, y1 }: Tally): CellBox => ({ x0, y0, x1, y1 });

const staleBase = (scope: AssistScope, actual: string): AssistViolation => ({
  constraint: "stale-base",
  message: `the draft changed since this request was made (request base ${scope.baseRevision}, draft now ${actual})`,
});

function checkPicture(
  before: CompiledDocument,
  after: CompiledDocument,
  scope: PictureAssistScope,
): AssistCheck {
  const violations: AssistViolation[] = [];
  const revision = draftRevision({
    kind: "picture",
    source: serializePictureDocument(before.document),
  });
  if (revision !== scope.baseRevision) violations.push(staleBase(scope, revision));
  const known = new Set(before.document.items.map((item) => item.id));
  const missing = scope.targetIds.filter((id) => !known.has(id));
  if (missing.length > 0)
    violations.push({
      constraint: "unknown-target",
      message: `the selection names ${missing.length === 1 ? "an item" : "items"} the draft does not have: ${missing.join(", ")}`,
    });
  for (const item of before.document.items) {
    if (scope.targetIds.includes(item.id)) continue;
    const next = after.document.items.find((candidate) => candidate.id === item.id);
    const change = !next
      ? "be removed"
      : next.label !== item.label || next.kind !== item.kind || next.locked !== item.locked
        ? "have its label, kind or lock changed"
        : null;
    if (change)
      violations.push({
        constraint: "outside-target",
        message: `item '${item.id}' ("${item.label}") is not selected but would ${change}`,
      });
  }
  // Locks are the creator's: no proposal locks or unlocks an item, selected
  // or new (an unselected one is reported above).
  for (const item of after.document.items) {
    const was = before.document.items.find((candidate) => candidate.id === item.id);
    if (was ? was.locked === item.locked || !scope.targetIds.includes(item.id) : !item.locked)
      continue;
    violations.push({
      constraint: "item-lock",
      message: `${was ? "item" : "new item"} '${item.id}' ("${item.label}") would be ${item.locked ? "locked" : "unlocked"}, but only the creator locks or unlocks items: leave "locked" out of setItemMeta${was?.locked ? " and ask the creator to unlock it" : ""}`,
    });
  }
  const created = after.document.items.flatMap((item) => (known.has(item.id) ? [] : [item.id]));
  const { cells: allowed, strays } = licence(before, after, scope);
  const result = validateEdit(before, after, {
    lockedPlanes: scope.lockedPlanes,
    allowedMask: allowed,
    maxBytes: scope.maxBytes,
  });
  const controlled = new Set([...scope.targetIds, ...created]);
  const spills = new Map<string, { plane: PicturePlane; label: string; cells: Tally }>();
  const repeats = new Map<
    string,
    { plane: PicturePlane; id: string; label: string; stray: Stray; cells: Tally }
  >();
  for (const violation of result.violations) {
    if (violation.constraint === "max-bytes") {
      violations.push({
        constraint: "max-bytes",
        count: violation.bytes,
        message: `the picture would be ${violation.bytes} bytes, ${violation.over} over the ${violation.maxBytes}-byte budget`,
      });
      continue;
    }
    const { plane } = violation;
    if (violation.constraint === "locked-plane") {
      violations.push({
        constraint: "locked-plane",
        plane,
        count: violation.count,
        bbox: violation.bbox,
        message: `the ${PLANE_WORDS[plane]} is locked, but ${at(violation.count, violation.bbox)} would change`,
      });
      continue;
    }
    // The cells validateEdit found outside the allowed ones: those a stray
    // repeat of a target owns are that repeat, and those a fill of an item
    // the proposal controls owns are that fill spilling.
    const rest = tally();
    const [a, b, mask] = [before[plane], after[plane], allowed[plane]];
    for (let i = 0; i < CELLS; i++) {
      if (a[i] === b[i] || mask[i] === 1) continue;
      const x = i % SCREEN_WIDTH;
      const y = (i - x) / SCREEN_WIDTH;
      const owner = itemAt(after, after.document, x, y, plane);
      const stray = owner && strays.get(owner.id);
      if (owner && stray) {
        const key = `${plane} ${owner.id}`;
        const repeat = repeats.get(key) ?? {
          plane,
          id: owner.id,
          label: owner.label,
          stray,
          cells: tally(),
        };
        repeats.set(key, repeat);
        add(repeat.cells, x, y);
        continue;
      }
      const item = filledCell(after, plane, i) ? owner : undefined;
      if (!item || !controlled.has(item.id)) {
        add(rest, x, y);
        continue;
      }
      const key = `${plane} ${item.id}`;
      const spill = spills.get(key) ?? { plane, label: item.label, cells: tally() };
      spills.set(key, spill);
      add(spill.cells, x, y);
    }
    if (rest.count > 0)
      violations.push({
        constraint: "outside-mask",
        plane,
        count: rest.count,
        bbox: boxOf(rest),
        message: `${at(rest.count, boxOf(rest))} of the ${PLANE_WORDS[plane]} outside the selection would change`,
      });
  }
  for (const { plane, id, label, stray, cells } of repeats.values())
    violations.push({
      constraint: "extra-copy",
      plane,
      count: cells.count,
      bbox: boxOf(cells),
      message: `new item '${id}' ("${label}") ${stray.why === "second" ? "would be a second copy of" : "copies"} the selected "${stray.target}"${stray.why === "second" ? "" : " in other colours"}: ${at(cells.count, boxOf(cells))} of the ${PLANE_WORDS[plane]} outside the selection would change. ${stray.why === "second" ? "An assist may move a selected item or copy it once, no more; drop the extra copies" : "A copy keeps the item's colours and pen; draw it in the same ones, or keep new drawing inside the selection"}`,
    });
  for (const { plane, label, cells } of spills.values())
    violations.push({
      constraint: "fill-spill",
      plane,
      count: cells.count,
      bbox: boxOf(cells),
      message: `the ${label} fill would spill outside the selection (${grouped(cells.count)} ${cells.count === 1 ? "cell" : "cells"}); close the outline or keep the fill seed inside it`,
    });
  for (const { constraint, plane, count, bbox, message } of checkLensRules(
    before,
    after,
    [...scope.targetIds, ...created],
    scope.lens,
    scope.unlocks,
  ))
    violations.push({ constraint, plane, count, bbox, message });
  return { ok: violations.length === 0, violations };
}

function checkView(
  before: SpriteDocument,
  after: SpriteDocument,
  scope: ViewAssistScope,
): AssistCheck {
  const violations: AssistViolation[] = [];
  const revision = draftRevision({ kind: "view", payload: before.payload });
  if (revision !== scope.baseRevision) violations.push(staleBase(scope, revision));
  const missing = scope.targetCels.filter(({ loop, cel }) => !before.loops[loop]?.cels[cel]);
  if (missing.length > 0)
    violations.push({
      constraint: "unknown-target",
      message: `the selection names cels the view does not have: ${missing.map(({ loop, cel }) => `loop ${loop} cel ${cel}`).join(", ")}`,
    });
  const protectedLoops = new Set(scope.protectedLoops ?? []);
  const targets = new Set(scope.targetCels.map(({ loop, cel }) => `${loop}:${cel}`));
  const targetLoops = new Set(scope.targetCels.map(({ loop }) => loop));
  const validation = validateSpriteEdit(before, after, { protectedLoops: [...protectedLoops] });
  // Splitting a targeted loop from its mirror partner re-links the partner
  // too; its display stays, so its link and orientation bits may follow.
  const owner = (loop: number) => before.loops[loop]?.alias ?? loop;
  const targetBlocks = new Set([...targetLoops].map(owner));
  const repainted = new Set(validation.changedCels.map(({ loop }) => loop));
  /** A protected partner of a targeted loop whose pixels stay: only its link and mirror bits moved. */
  const relinkOnly = (loop: number, cel: number | undefined) =>
    targetBlocks.has(owner(loop)) &&
    !repainted.has(loop) &&
    validation.metadata.every(
      (change) =>
        !("loop" in change) ||
        change.loop !== loop ||
        ("cel" in change && change.cel !== cel) ||
        change.kind === "alias" ||
        change.kind === "mirror-bit",
    );
  for (const violation of validation.violations)
    if (
      violation.constraint === "protected-loop" &&
      !(violation.pixels === undefined && relinkOnly(violation.loop, violation.cel))
    )
      violations.push({
        constraint: "protected-loop",
        loop: violation.loop,
        ...(violation.cel === undefined ? {} : { cel: violation.cel }),
        ...(violation.pixels === undefined ? {} : { count: violation.pixels }),
        message: violation.message,
      });
  for (const { loop, cel, pixels } of validation.changedCels) {
    if (protectedLoops.has(loop) || targets.has(`${loop}:${cel}`)) continue;
    violations.push({
      constraint: "outside-target",
      loop,
      cel,
      count: pixels,
      message: `loop ${loop}, cel ${cel} is not selected, but ${plural(pixels, "pixel")} of it would change`,
    });
  }
  for (const change of validation.metadata) {
    if ("loop" in change && (protectedLoops.has(change.loop) || targetLoops.has(change.loop)))
      continue;
    if (
      (change.kind === "alias" || change.kind === "mirror-bit") &&
      targetBlocks.has(owner(change.loop))
    )
      continue;
    const what =
      change.kind === "loop-count"
        ? `the view's loop count would change from ${change.before} to ${change.after}`
        : change.kind === "description"
          ? "the view's description would change"
          : `loop ${change.loop} is not selected, but its ${change.kind === "cel-count" ? "cel count" : change.kind === "alias" ? "mirror link" : `cel ${change.cel} ${change.kind}`} would change`;
    violations.push({
      constraint: "outside-target",
      ...("loop" in change ? { loop: change.loop } : {}),
      message: what,
    });
  }
  if (after.payload.length > scope.maxBytes)
    violations.push({
      constraint: "max-bytes",
      count: after.payload.length,
      message: `the view would be ${after.payload.length} bytes, ${after.payload.length - scope.maxBytes} over the ${scope.maxBytes}-byte budget`,
    });
  return { ok: violations.length === 0, violations };
}

/**
 * Hold a candidate to its scope: `before` is the draft the candidate was made
 * from, `after` the candidate, both decoded. Runs `validateEdit` for a
 * picture and `validateSpriteEdit` for a view, plus the scope's revision and
 * target rules.
 */
export function checkCandidate(
  before: CompiledDocument,
  after: CompiledDocument,
  scope: PictureAssistScope,
): AssistCheck;
export function checkCandidate(
  before: SpriteDocument,
  after: SpriteDocument,
  scope: ViewAssistScope,
): AssistCheck;
export function checkCandidate(
  before: CompiledDocument | SpriteDocument,
  after: CompiledDocument | SpriteDocument,
  scope: AssistScope,
): AssistCheck {
  return scope.kind === "picture"
    ? checkPicture(before as CompiledDocument, after as CompiledDocument, scope)
    : checkView(before as SpriteDocument, after as SpriteDocument, scope);
}

/**
 * The violations in plain words, for a refusal the model and the creator
 * read: a locked plane says it all for that plane, so its outside-selection
 * cells are not repeated.
 */
export function assistRefusalText(check: AssistCheck): string {
  const locked = new Set(
    check.violations.flatMap((v) => (v.constraint === "locked-plane" ? [v.plane] : [])),
  );
  return check.violations
    .filter(
      (v) =>
        !(
          (v.constraint === "outside-mask" ||
            v.constraint === "fill-spill" ||
            v.constraint === "extra-copy") &&
          locked.has(v.plane)
        ),
    )
    .map((v) => v.message)
    .join("; ");
}
