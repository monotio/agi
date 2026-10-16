/**
 * Original interpreter files, separate from the released host save codec.
 * Load this module with import() when an original file is requested.
 * Binary evidence: docs/fidelity.md, "Original save-file interoperability".
 */
import type { Engine } from "./engine.ts";
import type { AgiProfile } from "./profile.ts";
import {
  block1Layout,
  decodeHostImage,
  decodeSave,
  encodeSave,
  type SaveState,
} from "./persistence.ts";

// [original flag, portable flag, inverted]. The same assignments occur in
// the PC handlers and the independently decoded Amiga/IIgs handlers.
const FLAGS: readonly (readonly [number, number, boolean])[] = [
  [0x0001, 0x0001, false],
  [0x0002, 0x0020, true],
  [0x0004, 0x0008, false],
  [0x0008, 0x0010, true],
  [0x0010, 0x0400, true],
  [0x0020, 0x0004, false],
  [0x0040, 0x0002, false],
  [0x0100, 0x0100, false],
  [0x0200, 0x0040, true],
  [0x0400, 0x0800, false],
  [0x0800, 0x0200, false],
  [0x1000, 0x1000, false],
  [0x2000, 0x0080, false],
  [0x4000, 0x2000, false],
];
const MOTION = [0, 3, 2, 1] as const;
const CYCLE = [0, 3, 1, 2] as const;

interface Source {
  profile: string;
  blocks: Uint8Array[];
  strings: string[];
  resume: string;
}

// Reserved bytes belong to a decoded document. They never enter host archives
// or change the engine's released replay state.
const sources = new WeakMap<SaveState, Source>();

function nativeProfile(profile: AgiProfile): AgiProfile {
  if (profile.id === "2.001")
    throw new RangeError("Interpreter 2.001 saves several slot files; it has no single .SAV file");
  if (profile.id === "2.230") return { ...profile, saveBlocks: 4 };
  if (["amiga-2.310", "amiga-2.316", "amiga-2.333"].includes(profile.id))
    return { ...profile, saveBlock3Xor: true };
  return profile;
}

function word(bytes: Uint8Array, at: number, be = false): number {
  return be ? (bytes[at]! << 8) | bytes[at + 1]! : bytes[at]! | (bytes[at + 1]! << 8);
}

function blocksOf(bytes: Uint8Array, profile: AgiProfile): Uint8Array[] {
  if (bytes.length < 31) throw new RangeError("Original save ends inside its description");
  const be = profile.id === "iigs-1.014";
  const blocks: Uint8Array[] = [];
  let at = 31;
  for (let i = 0; i < profile.saveBlocks; i++) {
    if (at + 2 > bytes.length) throw new RangeError(`Original save ends before block ${i + 1}`);
    const size = word(bytes, at, be);
    if (at + 2 + size > bytes.length)
      throw new RangeError(`Original save ends inside block ${i + 1}`);
    blocks.push(bytes.slice(at + 2, at + 2 + size));
    at += 2 + size;
  }
  if (at !== bytes.length) throw new RangeError("Original save has trailing bytes");
  return blocks;
}

function envelope(header: Uint8Array, blocks: readonly Uint8Array[], be: boolean): Uint8Array {
  const result = new Uint8Array(31 + blocks.reduce((n, block) => n + 2 + block.length, 0));
  result.set(header.subarray(0, 31));
  let at = 31;
  for (const block of blocks) {
    if (block.length > 0xffff) throw new RangeError("Original save block exceeds 65535 bytes");
    result[at + (be ? 1 : 0)] = block.length & 0xff;
    result[at + (be ? 0 : 1)] = block.length >>> 8;
    result.set(block, at + 2);
    at += block.length + 2;
  }
  return result;
}

/** Decode an original file to portable game state, retaining its unmodeled bytes. */
export function decodeOriginalSav(bytes: Uint8Array, profile: AgiProfile): SaveState {
  const native = nativeProfile(profile);
  const blocks = blocksOf(bytes, native);
  if (native.saveBlocks >= 5) {
    const resume = blocks.at(-1)!;
    const be = block1Layout(native).kind === "amiga";
    if (
      resume.length < 8 ||
      resume.length % 4 !== 0 ||
      word(resume, 0, be) !== 0 ||
      word(resume, resume.length - 4, be) !== 0xffff
    )
      throw new RangeError("Original save logic-resume head or terminator is invalid");
    for (let at = 4; at < resume.length - 4; at += 4)
      if (word(resume, at, be) > 255)
        throw new RangeError("Original save logic-resume number exceeds 255");
  }
  const state = decodeSave(bytes, native);
  if (block1Layout(native).kind === "pc") {
    for (let i = 0; i < state.objects.length; i++) {
      const object = state.objects[i]!;
      const original = object.state;
      object.state = 0;
      for (const [bit, portable, inverted] of FLAGS)
        if (Boolean(original & bit) !== inverted) object.state |= portable;
      const motion = MOTION.indexOf(object.motionMode as (typeof MOTION)[number]);
      const cycle = CYCLE.indexOf(object.cycleMode as (typeof CYCLE)[number]);
      if (motion < 0 || cycle < 0) throw new RangeError("Original save object mode is invalid");
      object.motionMode = motion;
      object.cycleMode = cycle;
      object.raw = blocks[1]!.slice(i * 43, (i + 1) * 43);
    }
  }
  sources.set(state, {
    profile: profile.id,
    blocks,
    strings: [...state.strings],
    resume: JSON.stringify(state.logicResume),
  });
  return state;
}

/**
 * Write an original file. A decoded state retains description tails, unused
 * string bytes, native reference tokens and unmapped object bits. A new state
 * emits zero reference tokens; the original restore rebuilds its view pointers.
 */
export function encodeOriginalSav(state: SaveState, profile: AgiProfile): Uint8Array {
  const native = nativeProfile(profile);
  const layout = block1Layout(native);
  const objects = state.objects.map((object) => {
    if (layout.kind !== "pc") return object;
    let flags = object.raw?.length === 43 ? word(object.raw, 0x25) & 0x8080 : 0;
    for (const [bit, portable, inverted] of FLAGS)
      if (Boolean(object.state & portable) !== inverted) flags |= bit;
    const motionMode = MOTION[object.motionMode];
    const cycleMode = CYCLE[object.cycleMode];
    if (motionMode === undefined || cycleMode === undefined)
      throw new RangeError("Object mode cannot be represented in an original PC save");
    return { ...object, state: flags, motionMode, cycleMode };
  });
  const encoded = encodeSave({ ...state, objects }, native);
  const blocks = blocksOf(encoded, native);
  const source = sources.get(state);
  if (source && source.profile !== profile.id)
    throw new RangeError("Original save state belongs to a different interpreter profile");
  if (source) {
    const stateIndex = layout.kind === "iigs" ? 1 : 0;
    const strings =
      layout.kind === "pc"
        ? 7 +
          256 +
          32 +
          4 +
          (layout.middle === "early" ? 28 : 24) +
          (layout.keyMapEntries + layout.keyMapReserved) * 4 +
          4
        : layout.strings;
    // The legacy codec clears PC string tails, and truncates unterminated
    // 40-byte strings. An unchanged original record must remain byte-identical.
    for (let i = 0; i < state.strings.length; i++) {
      if (state.strings[i] === source.strings[i])
        blocks[stateIndex]!.set(
          source.blocks[stateIndex]!.subarray(strings + i * 40, strings + (i + 1) * 40),
          strings + i * 40,
        );
    }
    if (native.saveBlocks >= 5 && JSON.stringify(state.logicResume) === source.resume)
      blocks[blocks.length - 1] = source.blocks.at(-1)!;
  }
  const result = envelope(encoded, blocks, layout.kind === "iigs");
  // Avoid the legacy encoder's u16 length wrapping on large object/inventory blocks.
  decodeOriginalSav(result, profile);
  return result;
}

/** Import at a host execution boundary; malformed or foreign files leave the game intact. */
export function importOriginalSav(engine: Engine, bytes: Uint8Array): void {
  const state = decodeOriginalSav(bytes, engine.profile);
  const current = decodeSave(engine.serialize(), engine.profile);
  if (!state.signature.every((byte, i) => byte === current.signature[i]))
    throw new RangeError("Original save belongs to a different game signature");
  if (state.objects.length !== current.objects.length)
    throw new RangeError("Original save object allocation differs from this game");
  if (
    state.inventory.length !== current.inventory.length ||
    !state.inventory.every(
      (byte, i) =>
        (i < engine.itemNames().length * engine.profile.inventoryEntryBytes &&
          i % engine.profile.inventoryEntryBytes === 2) ||
        byte === current.inventory[i],
    )
  )
    throw new RangeError("Original save inventory differs from this game");
  engine.restoreImage(encodeSave(state, engine.profile));
}

/** Export a running game at a boundary representable by an original interpreter. */
export function exportOriginalSav(engine: Engine, description?: string): Uint8Array {
  const snapshot = engine.autosaveImage();
  if (snapshot === null) throw new RangeError("Play to a complete room before exporting a save");
  const host = decodeHostImage(snapshot);
  if (host.continuation || engine.modalOpen)
    throw new RangeError("Finish the open game interaction before exporting a save");
  const state = decodeSave(host.image, engine.profile);
  if (description !== undefined) state.description = description;
  return encodeOriginalSav(state, engine.profile);
}
