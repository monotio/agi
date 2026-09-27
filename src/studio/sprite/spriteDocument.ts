/**
 * Sprite Studio working model over an AGI VIEW: the decoded loops and cels in
 * display orientation, which loops share a data block (alias groups, mirrored
 * or not), and the bytes the document encodes to.
 *
 * Display is the truth. A document is re-encoded through `buildView`, and the
 * stored orientation metadata of each block — the v2 cel control nibble or the
 * packed loop header nibble — is chosen so that every member of the block
 * displays exactly the pixels the document holds: the block's own metadata
 * first, so an unchanged block keeps its orientation bits, then the builder's
 * default, then any other value. An unshared block is stored as displayed,
 * never behind an orientation that flips it. The result is decoded again and
 * compared; an arrangement the format cannot express is refused, never
 * approximated.
 *
 * An untouched document encodes to its original payload byte for byte, and so
 * does any document whose decoded state is again the original's.
 */
import type { AgiProfile } from "../../runtime/profile.ts";
import {
  aliasGroups,
  applyMetadata,
  type AliasGroup,
  type MetadataPlan,
} from "../../view/celEdit.ts";
import { buildView, parseView, type BuildLoopInput } from "../../view/view.ts";

export type SpriteProfile = Pick<AgiProfile, "packedViewLoopHeader">;

export interface SpriteCel {
  readonly width: number;
  readonly height: number;
  /** The transparent colour, 0..15; a pixel holding it is transparent. */
  readonly transparent: number;
  /** Row-major colours as this loop displays them (mirroring applied). Never mutated. */
  readonly pixels: Uint8Array;
  /** The block's mirrorable bit: v2 cel control 0x80, packed loop header 0x40. */
  readonly mirrorBit: boolean;
  /** Displayed flipped relative to the rows its data block stores. */
  readonly mirrored: boolean;
  /**
   * The stored high nibble (v2 cel control, packed loop header) of the block
   * this cel came from, preferred when re-encoding; null for new data.
   */
  readonly encoding: number | null;
}

export interface SpriteLoop {
  /** The earlier loop whose data block this loop shares, or null when it owns its block. */
  readonly alias: number | null;
  /** Some cel of this loop is displayed flipped relative to its stored rows. */
  readonly mirroredDisplay: boolean;
  readonly cels: readonly SpriteCel[];
}

export interface SpriteDocument {
  readonly loops: readonly SpriteLoop[];
  readonly description?: string;
  /** The packed (2.230) loop-header encoding. */
  readonly packed: boolean;
  /** The payload the document was opened from. */
  readonly original: Uint8Array;
  /** The original payload's alias groups. */
  readonly groups: readonly AliasGroup[];
  /** The bytes this document encodes to; `original` itself while nothing changed. */
  readonly payload: Uint8Array;
}

/** The pixels flipped left to right. */
export function mirrorPixels(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) out[y * width + x] = pixels[y * width + width - 1 - x]!;
  return out;
}

export function samePixels(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Same geometry, transparent colour and displayed pixels. */
export function sameDisplay(a: SpriteCel, b: SpriteCel): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.transparent === b.transparent &&
    samePixels(a.pixels, b.pixels)
  );
}

function sameCel(a: SpriteCel, b: SpriteCel): boolean {
  return (
    sameDisplay(a, b) &&
    a.mirrorBit === b.mirrorBit &&
    a.mirrored === b.mirrored &&
    a.encoding === b.encoding
  );
}

/** Same loops, aliases and displayed cels; `exact` also compares the stored metadata. */
export function sameLoops(
  a: readonly SpriteLoop[],
  b: readonly SpriteLoop[],
  exact: boolean,
): boolean {
  const same = exact ? sameCel : sameDisplay;
  return (
    a.length === b.length &&
    a.every((loop, index) => {
      const other = b[index]!;
      return (
        loop.alias === other.alias &&
        loop.cels.length === other.cels.length &&
        loop.cels.every((cel, c) => same(cel, other.cels[c]!))
      );
    })
  );
}

interface Decoded {
  readonly loops: SpriteLoop[];
  readonly description?: string;
  readonly groups: AliasGroup[];
}

function decode(payload: Uint8Array, packed: boolean): Decoded {
  const view = parseView(payload, { packedViewLoopHeader: packed });
  const groups = aliasGroups(payload, view, packed);
  const loops: SpriteLoop[] = new Array(view.loops.length);
  for (const group of groups) {
    const owner = group.members[0]!;
    for (const member of group.members) {
      const cels = view.loops[member]!.cels.map((cel, c): SpriteCel => {
        const encoding = packed ? group.headerHigh : group.controlHighs[c]!;
        return {
          width: cel.width,
          height: cel.height,
          transparent: cel.transparentColor,
          pixels: cel.pixels,
          mirrorBit: (encoding & (packed ? 0x40 : 0x80)) !== 0,
          mirrored: cel.mirrored,
          encoding,
        };
      });
      loops[member] = {
        alias: member === owner ? null : owner,
        mirroredDisplay: cels.some((cel) => cel.mirrored),
        cels,
      };
    }
  }
  return view.description === undefined
    ? { loops, groups }
    : { loops, groups, description: view.description };
}

/** Open a VIEW payload. Throws RangeError when it does not decode. */
export function openSprite(payload: Uint8Array, profile: SpriteProfile): SpriteDocument {
  const packed = profile.packedViewLoopHeader;
  const original = payload.slice();
  const { loops, groups, description } = decode(original, packed);
  return {
    loops,
    ...(description === undefined ? {} : { description }),
    packed,
    original,
    groups,
    payload: original,
  };
}

/** The document's VIEW payload: the original bytes while nothing changed. */
export function buildSprite(document: SpriteDocument, profile: SpriteProfile): Uint8Array {
  if (profile.packedViewLoopHeader !== document.packed)
    throw new RangeError("the document was opened for a different VIEW loop-header encoding");
  return document.payload.slice();
}

/** Whether a member displays its block flipped under stored nibble `high`. */
function flips(high: number, member: number, packed: boolean): boolean {
  return packed
    ? (high & 0xc0) === 0xc0 && ((high >>> 4) & 3) !== member
    : (high & 0x80) !== 0 && ((high >>> 4) & 7) !== (member & 7);
}

/**
 * How loops use a block: one loop alone, several showing it alike, or several
 * the document shows mirrored apart (a mirror link).
 */
type Sharing = "alone" | "alike" | "mirrored";

/**
 * Stored nibbles to try for a block owned by `owner`, most preferred first.
 * A block alone never needs flipped rows: it takes its hint only when that
 * does not flip it, then the builder's plain default (v2 orientation the
 * owner, packed no flags). A mirror link keeps orientation flags even where
 * symmetric pixels would fit without them.
 */
function candidates(
  hint: number | null,
  mirrorBit: boolean,
  owner: number,
  sharing: Sharing,
  packed: boolean,
) {
  const flags = packed ? 0xc0 : 0x80;
  const usable =
    hint !== null &&
    (sharing === "alone"
      ? !flips(hint, owner, packed)
      : sharing === "alike" || (hint & flags) === flags);
  const out: number[] = usable ? [hint] : [];
  if (sharing === "alone") out.push(packed ? 0 : (owner & 7) << 4);
  if (packed) {
    for (const o of [owner & 3, 0, 1, 2, 3]) out.push(0xc0 | (o << 4));
    out.push(0);
  } else {
    for (const bit of [mirrorBit || sharing === "mirrored" ? 0x80 : 0, 0x80, 0])
      for (const o of [owner & 7, 0, 1, 2, 3, 4, 5, 6, 7]) out.push(bit | (o << 4));
  }
  return [...new Set(out)];
}

/**
 * Choose the stored rows and nibble for cels `cels` of the block `members`
 * share (every cel of the loop when packed, one cel otherwise): the first
 * candidate under which every member displays its own pixels.
 */
function chooseEncoding(
  loops: readonly SpriteLoop[],
  members: readonly number[],
  cels: readonly number[],
  packed: boolean,
): { high: number; rows: Uint8Array[] } {
  const owner = members[0]!;
  const lead = loops[owner]!.cels[cels[0]!]!;
  const rowsFor = (flipped: boolean) =>
    cels.map((c) => {
      const cel = loops[owner]!.cels[c]!;
      return flipped ? mirrorPixels(cel.pixels, cel.width, cel.height) : cel.pixels;
    });
  const orientations = [lead.mirrored, !lead.mirrored].map((flipped) => rowsFor(flipped));
  const sharing: Sharing =
    members.length === 1
      ? "alone"
      : members.some((member) =>
            cels.some((c) => loops[member]!.cels[c]!.mirrored !== loops[owner]!.cels[c]!.mirrored),
          )
        ? "mirrored"
        : "alike";
  for (const high of candidates(lead.encoding, lead.mirrorBit, owner, sharing, packed)) {
    for (const rows of orientations) {
      const fits = members.every((member) =>
        cels.every((c, i) => {
          const cel = loops[member]!.cels[c]!;
          const stored = rows[i]!;
          const shown = flips(high, member, packed)
            ? mirrorPixels(stored, cel.width, cel.height)
            : stored;
          return samePixels(shown, cel.pixels);
        }),
      );
      if (fits) return { high, rows };
    }
  }
  const label = packed ? "" : `, cel ${cels[0]}`;
  throw new RangeError(
    `loops ${members.join(", ")} share a data block (loop ${owner}${label}) that no stored orientation can display as drawn`,
  );
}

/** Check one alias group's cels agree on geometry and transparency. */
function checkMembers(loops: readonly SpriteLoop[], members: readonly number[]): void {
  const owner = loops[members[0]!]!;
  for (const member of members.slice(1)) {
    const loop = loops[member]!;
    const matches =
      loop.cels.length === owner.cels.length &&
      loop.cels.every((cel, c) => {
        const lead = owner.cels[c]!;
        return (
          cel.width === lead.width &&
          cel.height === lead.height &&
          cel.transparent === lead.transparent
        );
      });
    if (!matches)
      throw new RangeError(
        `loop ${member} shares loop ${members[0]}'s data block but its cels differ in count, size or transparent colour`,
      );
  }
}

/**
 * Encode `loops` as the document's VIEW payload, keeping its description and
 * its two leading header bytes — without the unchanged-bytes short cut that
 * `buildSprite`/`withLoops` take, so round-trip checks see real re-encodes.
 */
export function encodeSprite(document: SpriteDocument, loops: readonly SpriteLoop[]): Uint8Array {
  const { description, packed } = document;
  const spec: BuildLoopInput[] = [];
  const plans: MetadataPlan[] = [];
  for (let index = 0; index < loops.length; index++) {
    const loop = loops[index]!;
    if (loop.alias !== null) {
      spec.push({ mirrorLoop: loop.alias });
      continue;
    }
    const members = [index];
    for (let other = index + 1; other < loops.length; other++)
      if (loops[other]!.alias === index) members.push(other);
    checkMembers(loops, members);
    const all = loop.cels.map((_, c) => c);
    const chosen = packed
      ? [chooseEncoding(loops, members, all, packed)]
      : all.map((c) => chooseEncoding(loops, members, [c], packed));
    const rows = chosen.flatMap((choice) => choice.rows);
    spec.push({
      cels: loop.cels.map((cel, c) => ({
        width: cel.width,
        height: cel.height,
        transparentColor: cel.transparent,
        pixels: rows[c]!,
        mirror: !packed && (chosen[c]!.high & 0x80) !== 0,
      })),
    });
    plans.push({
      loop: index,
      headerHigh: chosen[0]!.high,
      controlHighs: chosen.map((choice) => choice.high),
    });
  }
  const payload = buildView(
    description === undefined ? { loops: spec } : { loops: spec, description },
    { packedViewLoopHeader: packed },
  );
  applyMetadata(payload, packed, plans);
  // Bytes 0..1 precede the loop count; the builder zeroes them and parseView
  // does not read them, so an edit keeps the original's values.
  payload.set(document.original.subarray(0, 2));
  return payload;
}

/**
 * Re-encode `loops` as the next state of `document`. The encoded bytes are
 * decoded again and must display exactly what `loops` holds; a state equal to
 * the original's decodes to the original bytes. Throws RangeError when the
 * VIEW format cannot hold the loops.
 */
export function withLoops(document: SpriteDocument, loops: readonly SpriteLoop[]): SpriteDocument {
  const payload = encodeSprite(document, loops);
  const decoded = decode(payload, document.packed);
  if (!sameLoops(decoded.loops, loops, false))
    throw new RangeError("the edited view does not decode to the pixels drawn");
  const base = decode(document.original, document.packed);
  if (sameLoops(decoded.loops, base.loops, true))
    return { ...document, loops: base.loops, payload: document.original };
  return { ...document, loops: decoded.loops, payload };
}

/**
 * The document holding `payload` instead, keeping its original (undo and
 * redo restore encoded snapshots this way). Throws RangeError when the
 * payload does not decode.
 */
export function withPayload(document: SpriteDocument, payload: Uint8Array): SpriteDocument {
  if (samePixels(payload, document.original)) {
    const { loops } = decode(document.original, document.packed);
    return { ...document, loops, payload: document.original };
  }
  const bytes = payload.slice();
  return { ...document, loops: decode(bytes, document.packed).loops, payload: bytes };
}
