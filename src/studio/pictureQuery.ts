/**
 * Pure queries over a compiled picture document for the Room Studio: which
 * item owns a pixel, its highlight mask, the draw-order timeline, a partial
 * render for the scrubber, and why a seed fill stopped short of a cell.
 */

import {
  createPictureSurface,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type PictureSurface,
} from "../types.ts";
import { DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";
import { renderPicture, type PictureOwnerBuffers } from "../picture/renderer.ts";
import { compilePictureSource, pictureSpanAt, type PictureSourceSpan } from "../picture/source.ts";
import { pictureCommandStates, pictureStateAt } from "../picture/elements.ts";
import {
  pictureCommandText,
  pictureItemAtLine,
  serializePictureDocument,
  type PictureDocument,
  type PictureItem,
} from "./pictureDocument.ts";

export type PicturePlane = "visual" | "priority";

export interface CompiledPictureDocument {
  bytes: Uint8Array;
  /** One span per byte-emitting source line, in byte order. */
  spans: readonly PictureSourceSpan[];
  /** Per cell, the opcode offset of the command that last wrote it, or -1. */
  owners: PictureOwnerBuffers;
  /** The final surface, row-major 160x168. */
  visual: Uint8Array;
  priority: Uint8Array;
}

/**
 * Compile the document's source (leniently, as disassembled originals need)
 * and render it once with owner buffers. Throws PictureSourceSyntaxError.
 */
export function compileDocument(
  document: PictureDocument,
  profile: AgiProfile,
): CompiledPictureDocument {
  const { bytes, spans } = compilePictureSource(serializePictureDocument(document), {
    lenient: true,
    profile,
  });
  const cells = SCREEN_WIDTH * SCREEN_HEIGHT;
  const owners = { visual: new Int32Array(cells), priority: new Int32Array(cells) };
  const surface = createPictureSurface();
  renderPicture(bytes, surface, { profile, owner: owners });
  return { bytes, spans, owners, visual: surface.visual, priority: surface.priority };
}

const onSurface = (x: number, y: number): boolean =>
  Number.isInteger(x) &&
  Number.isInteger(y) &&
  x >= 0 &&
  x < SCREEN_WIDTH &&
  y >= 0 &&
  y < SCREEN_HEIGHT;

/** The source line of the command that last wrote cell x,y on `plane`, or null. */
function ownerLine(
  compiled: CompiledPictureDocument,
  x: number,
  y: number,
  plane: PicturePlane,
): number | null {
  const owner = compiled.owners[plane][y * SCREEN_WIDTH + x]!;
  return owner < 0 ? null : (pictureSpanAt(compiled.spans, owner)?.line ?? null);
}

/** The item whose command last wrote x,y on `plane`: owner offset → span line → item. */
export function itemAt(
  compiled: CompiledPictureDocument,
  document: PictureDocument,
  x: number,
  y: number,
  plane: PicturePlane,
): PictureItem | undefined {
  if (!onSurface(x, y)) return undefined;
  const line = ownerLine(compiled, x, y, plane);
  return line === null ? undefined : pictureItemAtLine(document, line);
}

/** 160x168 mask: 1 where item `itemId` owns the final cell on `plane`. */
export function itemMask(
  compiled: CompiledPictureDocument,
  document: PictureDocument,
  itemId: string,
  plane: PicturePlane,
): Uint8Array {
  const mask = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  const item = document.items.find((candidate) => candidate.id === itemId);
  if (!item) return mask;
  const ownedByte = new Uint8Array(compiled.bytes.length);
  for (const span of compiled.spans) {
    if (item.openLine < span.line && span.line < item.closeLine) {
      ownedByte.fill(1, span.start, span.end);
    }
  }
  const owners = compiled.owners[plane];
  for (let i = 0; i < mask.length; i++) {
    const owner = owners[i]!;
    if (owner >= 0 && ownedByte[owner] === 1) mask[i] = 1;
  }
  return mask;
}

export interface TimelineEntry {
  /** 1-based source line. */
  line: number;
  /** The command word, lower-cased (`vis`, `line`, `copy`, `raw`, ...). */
  op: string;
  /** Visual colour in effect when the command starts, or null when visual drawing is off. */
  visual: number | null;
  /** Priority value in effect when the command starts, or null when priority drawing is off. */
  priority: number | null;
  itemId?: string;
}

/**
 * One entry per byte-emitting command line, in order, so entry k matches
 * `spans[k]` and `renderUpTo(compiled, k + 1)` shows the picture after it. A
 * state line reports the state before it changes it. Throws
 * PictureSourceSyntaxError.
 */
export function commandTimeline(
  document: PictureDocument,
  profile: AgiProfile = DEFAULT_V2_PROFILE,
): TimelineEntry[] {
  const { bytes, spans } = compilePictureSource(serializePictureDocument(document), {
    lenient: true,
    profile,
  });
  const states = pictureCommandStates(bytes, profile);
  return spans.map((span) => {
    const { visual, priority } = pictureStateAt(states, span.start);
    const op = pictureCommandText(document.lines[span.line - 1]!)
      .split(/\s+/)[0]!
      .toLowerCase();
    const entry: TimelineEntry = { line: span.line, op, visual, priority };
    const item = pictureItemAtLine(document, span.line);
    if (item) entry.itemId = item.id;
    return entry;
  });
}

/** Render only the first `commandIndex` spans (then 0xff) onto a fresh surface. */
export function renderUpTo(
  compiled: Pick<CompiledPictureDocument, "bytes" | "spans">,
  commandIndex: number,
  profile: AgiProfile,
): PictureSurface {
  const count = Math.max(0, Math.min(Math.floor(commandIndex), compiled.spans.length));
  const end = count === 0 ? 0 : compiled.spans[count - 1]!.end;
  const bytes = new Uint8Array(end + 1);
  bytes.set(compiled.bytes.subarray(0, end));
  bytes[end] = 0xff;
  const surface = createPictureSurface();
  renderPicture(bytes, surface, { profile });
  return surface;
}

export interface FillExplanation {
  plane: PicturePlane;
  x: number;
  y: number;
  /** The cell's final value on `plane`. */
  value: number;
  /** The value a fill on `plane` floods: 15 visual, 4 priority. */
  target: 15 | 4;
  /** Source line of the command that last wrote the cell, or null if none did. */
  line: number | null;
  /** Whether the cell still holds the target, so a fill seeded in its region reaches it. */
  fillable: boolean;
  message: string;
}

/**
 * Why a seed fill did not reach x,y on `plane`, from the final picture. AGI
 * fills flood the 4-connected region holding the target (15 on the visual
 * plane; 4 on the priority plane, filled only while visual drawing is off)
 * and do nothing when the seed cell does not hold it.
 */
export function whyNotFilled(
  compiled: CompiledPictureDocument,
  x: number,
  y: number,
  plane: PicturePlane,
): FillExplanation | undefined {
  if (!onSurface(x, y)) return undefined;
  const value = compiled[plane][y * SCREEN_WIDTH + x]!;
  const target = plane === "visual" ? 15 : 4;
  const line = ownerLine(compiled, x, y, plane);
  const fillable = value === target;
  const rule =
    plane === "visual"
      ? "A visual fill floods only 4-connected cells holding 15."
      : "A priority fill runs only while visual drawing is off and floods only 4-connected cells holding priority 4.";
  const cause =
    line === null
      ? `No command wrote this cell; it holds its initial ${plane} ${value}.`
      : `Line ${line} last wrote this cell; it holds ${plane} ${value}.`;
  const outcome = fillable
    ? `It still holds the target, so a ${plane} fill seeded in its region${line === null ? "" : ` after line ${line}`} reaches it.`
    : `It no longer holds ${target}, so a later fill stops at it.`;
  return { plane, x, y, value, target, line, fillable, message: `${cause} ${rule} ${outcome}` };
}
