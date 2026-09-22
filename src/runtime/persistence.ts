/**
 * Authentic AGI save-file envelope, clean-room from Peter Kelly's agi-re behavioral
 * specification: "Rooms, Replay, and Persistence" (save-file envelope, the
 * per-profile block-1 partitions, the block-2 object record, block-3 inventory
 * payload, block-4 replay-pair storage, block-5 logic-resume grammar, and the
 * v3 block-3 transform).
 *
 * The engine owns game state; this module owns bytes. It has no dependency on
 * the engine, on Node, or on the browser: `encodeSave` turns a portable
 * `SaveState` into the real file image and `decodeSave` turns an image back,
 * preserving every reserved byte the file supplied.
 *
 * Framing (spec "Save-file envelope"):
 *
 *     description_header[31]
 *     repeat profile_block_count times:
 *         block_length:u16le
 *         block_data[block_length]
 *
 * Block count is four for profile 2.089 and five afterwards
 * (`AgiProfile.saveBlocks`). Block 3 is XOR-transformed on disk in the v3
 * profiles (`AgiProfile.saveBlock3Xor`).
 */

import type { AgiProfile, ProfileId } from "./profile.ts";
import { validateContinuation, type ParkedContinuation } from "./replayState.ts";
import { TEXT_COLS, TEXT_ROWS } from "./textSurface.ts";

/** Bytes of the leading description header (spec "Save-file envelope"). */
export const SAVE_DESCRIPTION_BYTES = 31;
/** Bytes of one block-2 drawable-object record (spec "Profile 2.936 block 2"). */
export const OBJECT_RECORD_BYTES = 0x2b;
/** Repeating key of the v3 block-3 transform (spec "V3 block-3 transform"). */
export const BLOCK3_XOR_KEY = "Avis Durgan";
/** Logic number of the block-5 terminator record (spec "Profile 2.936 block 5"). */
export const LOGIC_RESUME_TERMINATOR = 0xffff;

/**
 * Ordering of the 24- or 28-byte middle section at block-1 position `0x012b`.
 *
 * "common" is the partition shared by 2.411 and every later promoted profile.
 * "early" is the 2.089/2.230/2.272 partition, which carries a display-mode
 * word, a previous-navigation word, a navigation-direction word and a reserved
 * startup count that the later profiles do not, and is four bytes longer.
 */
export type Block1MiddleOrder = "early" | "common";

/** Positions and capacities of one PC profile's block 1. */
export interface PcBlock1Layout {
  readonly kind: "pc";
  /** Exact block-1 length in bytes. */
  readonly size: number;
  readonly middle: Block1MiddleOrder;
  /** Serialized key-map records this profile addresses (39 or 49). */
  readonly keyMapEntries: number;
  /** Inactive key-map records serialized after them; canonical contents zero. */
  readonly keyMapReserved: number;
  /** Addressable 40-byte script string slots (6 or 12). */
  readonly stringSlots: number;
  /** 40-byte records after them: outside parse()'s range, addressable by every other string operand. */
  readonly stringReserved: number;
  /** The trailing replay-checkpoint word exists (absent in 2.411/2.440 and the early profiles). */
  readonly checkpoint: boolean;
  /** The trailing menu-interaction gate word and key-release gate byte exist. */
  readonly gates: boolean;
}

/**
 * Positions and capacities of an Amiga profile's block 1 — the raw
 * state-hunk image the save routine dumps, with big-endian fields
 * (docs/fidelity.md "Amiga interpreter profiles"). Every offset is read off
 * the shipped Save/ images and the save/restore disassembly.
 */
export interface AmigaBlock1Layout {
  readonly kind: "amiga";
  /** Exact block-1 (state-hunk) length in bytes. */
  readonly size: number;
  /** Key-map start: `keyMapEntries` {rawKey u16be, status u16be} records. */
  readonly keyMap: number;
  readonly keyMapEntries: number;
  /** String bank start: `stringSlots` 40-byte zero-terminated records. */
  readonly strings: number;
  readonly stringSlots: number;
  /** v0..v255 start. */
  readonly vars: number;
  /** 32 packed flag bytes. */
  readonly flags: number;
  /** The 24-byte text/window group (three u16be attributes, u32be input enable, u16be input row, prompt byte + pad, u32be status enable, three u16be rows). */
  readonly text: number;
  /** Script-buffer capacity word (u16be); block 4 is this many two-byte pairs. */
  readonly replayCapacity: number;
  /** Active replay-pair count word (u16be). */
  readonly replayActive: number;
  /**
   * Block-enable flag (u32be): written by `block`/`unblock`. The verified
   * offset is +0x22 on 2.082 and +0x20 on the later builds (docs/fidelity.md).
   */
  readonly blockEnabled: number;
  /**
   * The 2.082 ego click-direction mirror (u16be at +0x20), or null on the
   * later builds where that word is a different, unmapped field.
   */
  readonly navMirror: number | null;
}

/**
 * Positions and capacities of the Apple IIgs save (docs/fidelity.md "Apple
 * IIgs interpreter"). The envelope is six big-endian-length blocks: an
 * opaque lead block, then the 0x3d0-byte main state block this layout maps
 * (little-endian fields), the object records, the inventory payload, the
 * replay pairs and the logic-resume records.
 */
export interface IigsBlock1Layout {
  readonly kind: "iigs";
  /** Bytes of the leading block saved ahead of the state block. */
  readonly lead: number;
  /** Lead-block offsets, all u16le: the block()/horizon globals at bank 0
   * $0111..$0121 (docs/fidelity.md "Apple IIgs interpreter"). */
  readonly horizon: number;
  readonly blockRect: number;
  /** Lead-block offset of the player/program-control flag (u16le, $011d). */
  readonly controlFlag: number;
  /** Lead-block offset of the block-enable flag (u16le, $0121). */
  readonly blockEnabled: number;
  /** Offset inside the lead block of the replay capacity u16le. */
  readonly replayCapacity: number;
  /** Bytes of the main state block (the second block in the envelope). */
  readonly size: number;
  /** Key-map start inside the state block: {rawKey u16le, status u16le}. */
  readonly keyMap: number;
  readonly keyMapEntries: number;
  /** String bank start inside the state block. */
  readonly strings: number;
  readonly stringSlots: number;
  /** v0..v255 start inside the state block. */
  readonly vars: number;
  /** 32 packed flag bytes. */
  readonly flags: number;
}

/** Positions and capacities of one profile's block 1. */
export type Block1Layout = PcBlock1Layout | AmigaBlock1Layout | IigsBlock1Layout;

const SIGNATURE_BYTES = 7;
const VAR_COUNT = 256;
const FLAG_BYTES = 32;
const OFF_SIGNATURE = 0;
const OFF_VARS = OFF_SIGNATURE + SIGNATURE_BYTES; // 0x0007
const OFF_FLAGS = OFF_VARS + VAR_COUNT; // 0x0107
const OFF_TIMER = OFF_FLAGS + FLAG_BYTES; // 0x0127
const OFF_MIDDLE = OFF_TIMER + 4; // 0x012b
const MIDDLE_BYTES: Readonly<Record<Block1MiddleOrder, number>> = { common: 24, early: 28 };
/** Text/window fields: fg, bg, attribute, input enable, input row, prompt+pad, status enable, status row, base row, bottom row. */
const TEXT_BYTES = 20;

/** Block-1 layout of each promoted profile (spec, the per-profile block tables). */
const BLOCK1_LAYOUTS: Readonly<Record<ProfileId, Block1Layout>> = {
  // 2.001 save images are unverified (no observed 2.001 save); the earliest
  // documented partition applies. docs/fidelity.md pc-booter-2.001-profile.
  "2.001": {
    kind: "pc",
    size: 0x03db,
    middle: "early",
    keyMapEntries: 39,
    keyMapReserved: 0,
    stringSlots: 6,
    stringReserved: 6,
    checkpoint: false,
    gates: false,
  },
  // "The source-backed 2.089/2.230/2.272 block-1 partition": 0x03db.
  "2.089": {
    kind: "pc",
    size: 0x03db,
    middle: "early",
    keyMapEntries: 39,
    keyMapReserved: 0,
    stringSlots: 6,
    stringReserved: 6,
    checkpoint: false,
    gates: false,
  },
  "2.230": {
    kind: "pc",
    size: 0x03db,
    middle: "early",
    keyMapEntries: 39,
    keyMapReserved: 0,
    stringSlots: 6,
    stringReserved: 6,
    checkpoint: false,
    gates: false,
  },
  "2.272": {
    kind: "pc",
    size: 0x03db,
    middle: "early",
    keyMapEntries: 39,
    keyMapReserved: 0,
    stringSlots: 6,
    stringReserved: 6,
    checkpoint: false,
    gates: false,
  },
  // "Profiles 2.411 and 2.440 observed early blocks": the first 0x05df bytes of
  // the 2.936 partition, omitting the saved replay-checkpoint count.
  "2.411": {
    kind: "pc",
    size: 0x05df,
    middle: "common",
    keyMapEntries: 39,
    keyMapReserved: 10,
    stringSlots: 12,
    stringReserved: 12,
    checkpoint: false,
    gates: false,
  },
  "2.440": {
    kind: "pc",
    size: 0x05df,
    middle: "common",
    keyMapEntries: 39,
    keyMapReserved: 10,
    stringSlots: 12,
    stringReserved: 12,
    checkpoint: false,
    gates: false,
  },
  // "The selected KQ1 data uses the profile 2.936 block-1 partition ... exactly."
  "2.917": {
    kind: "pc",
    size: 0x05e1,
    middle: "common",
    keyMapEntries: 39,
    keyMapReserved: 10,
    stringSlots: 12,
    stringReserved: 12,
    checkpoint: true,
    gates: false,
  },
  // "Profile 2.936 block 1": exactly 0x05e1 bytes.
  "2.936": {
    kind: "pc",
    size: 0x05e1,
    middle: "common",
    keyMapEntries: 39,
    keyMapReserved: 10,
    stringSlots: 12,
    stringReserved: 12,
    checkpoint: true,
    gates: false,
  },
  // "The selected full KQ4 data uses the profile 2.936 block-1 partition ...
  // The profile's menu interaction gate and incrementing key-release gate are
  // not fields in this serialized block."
  "3.002.086": {
    kind: "pc",
    size: 0x05e1,
    middle: "common",
    keyMapEntries: 39,
    keyMapReserved: 10,
    stringSlots: 12,
    stringReserved: 12,
    checkpoint: true,
    gates: false,
  },
  // "Profile 3.002.102 observed KQ4D demo blocks": 2.936 through 0x05e0, then
  // the menu interaction gate and key-release enqueue gate. 0x05e4 bytes.
  "3.002.102": {
    kind: "pc",
    size: 0x05e4,
    middle: "common",
    keyMapEntries: 39,
    keyMapReserved: 10,
    stringSlots: 12,
    stringReserved: 12,
    checkpoint: true,
    gates: true,
  },
  // "Profile 3.002.149 observed Gold Rush blocks": the 49-slot key map consumes
  // the ten inactive records, and there is no reserved string bank. 0x0404.
  "3.002.149": {
    kind: "pc",
    size: 0x0404,
    middle: "common",
    keyMapEntries: 49,
    keyMapReserved: 0,
    stringSlots: 12,
    stringReserved: 0,
    checkpoint: true,
    gates: true,
  },
  // Amiga "Sierra" 2.082 (SQ1): the 0x2f4-byte state hunk, verified against
  // the shipped Save/sqsg.* images — key map @0x2c, strings @0xcc, vars
  // @0x1bc, flags @0x2bc, text tail @0x2dc, and the script capacity/active
  // words at +0x28/+0x2a (docs/fidelity.md "Amiga interpreter profiles").
  "amiga-2.082": {
    kind: "amiga",
    size: 0x02f4,
    keyMap: 0x2c,
    keyMapEntries: 40,
    strings: 0xcc,
    stringSlots: 6,
    vars: 0x1bc,
    flags: 0x2bc,
    text: 0x2dc,
    replayCapacity: 0x28,
    replayActive: 0x2a,
    blockEnabled: 0x22,
    navMirror: 0x20,
  },
  // Amiga "KQ2" 2.176: the 0x40a-byte state hunk — key map @0x2a, strings
  // @0xca, vars @0x2d2, flags @0x3d2, text tail @0x3f2, capacity/active at
  // +0x26/+0x28 (docs/fidelity.md "Amiga interpreter profiles").
  "amiga-2.176": {
    kind: "amiga",
    size: 0x040a,
    keyMap: 0x2a,
    keyMapEntries: 39,
    strings: 0xca,
    stringSlots: 13,
    vars: 0x2d2,
    flags: 0x3d2,
    text: 0x3f2,
    replayCapacity: 0x26,
    replayActive: 0x28,
    blockEnabled: 0x20,
    navMirror: null,
  },
  // Amiga "SQ2" 2.202: the same state-hunk partition as 2.176, verified
  // against the shipped Save/sq2sg.* images.
  "amiga-2.202": {
    kind: "amiga",
    size: 0x040a,
    keyMap: 0x2a,
    keyMapEntries: 39,
    strings: 0xca,
    stringSlots: 13,
    vars: 0x2d2,
    flags: 0x3d2,
    text: 0x3f2,
    replayCapacity: 0x26,
    replayActive: 0x28,
    blockEnabled: 0x20,
    navMirror: null,
  },
  // Amiga 2.31x (PQ/GR/MH2): the 0x414-byte state hunk — the 2.176 partition
  // plus ten trailing bytes the later builds' tail adds.
  "amiga-2.310": {
    kind: "amiga",
    size: 0x0414,
    keyMap: 0x2a,
    keyMapEntries: 39,
    strings: 0xca,
    stringSlots: 13,
    vars: 0x2d2,
    flags: 0x3d2,
    text: 0x3f2,
    replayCapacity: 0x26,
    replayActive: 0x28,
    blockEnabled: 0x20,
    navMirror: null,
  },
  "amiga-2.316": {
    kind: "amiga",
    size: 0x0414,
    keyMap: 0x2a,
    keyMapEntries: 39,
    strings: 0xca,
    stringSlots: 13,
    vars: 0x2d2,
    flags: 0x3d2,
    text: 0x3f2,
    replayCapacity: 0x26,
    replayActive: 0x28,
    blockEnabled: 0x20,
    navMirror: null,
  },
  "amiga-2.333": {
    kind: "amiga",
    size: 0x0414,
    keyMap: 0x2a,
    keyMapEntries: 39,
    strings: 0xca,
    stringSlots: 13,
    vars: 0x2d2,
    flags: 0x3d2,
    text: 0x3f2,
    replayCapacity: 0x26,
    replayActive: 0x28,
    blockEnabled: 0x20,
    navMirror: null,
  },
  // Apple IIgs 1.014 (SQ2.SYS16): the savegameseg writer emits six
  // big-endian-length blocks — a 0x38-byte lead state block (replay capacity
  // u16le at +0x1a), then the 0x3d0-byte main state block mapped here:
  // 8 opaque head bytes, key map @0x08, strings @0xa8, vars @0x2b0, flags
  // @0x3b0 (docs/fidelity.md "Apple IIgs interpreter").
  "iigs-1.014": {
    kind: "iigs",
    lead: 0x38,
    horizon: 0x04,
    blockRect: 0x08,
    controlFlag: 0x10,
    blockEnabled: 0x14,
    replayCapacity: 0x1a,
    size: 0x03d0,
    keyMap: 0x08,
    keyMapEntries: 40,
    strings: 0xa8,
    stringSlots: 13,
    vars: 0x2b0,
    flags: 0x3b0,
  },
};

/** Derived block-1 field positions for a PC layout. */
interface Block1Offsets {
  keyMap: number;
  preStringPadding: number;
  strings: number;
  stringReserved: number;
  text: number;
  checkpoint: number;
  menuGate: number;
  releaseGate: number;
  end: number;
}

function block1Offsets(layout: PcBlock1Layout): Block1Offsets {
  const keyMap = OFF_MIDDLE + MIDDLE_BYTES[layout.middle];
  const preStringPadding = keyMap + (layout.keyMapEntries + layout.keyMapReserved) * 4;
  const strings = preStringPadding + 4;
  const stringReserved = strings + layout.stringSlots * 40;
  const text = stringReserved + layout.stringReserved * 40;
  const checkpoint = text + TEXT_BYTES;
  const menuGate = checkpoint + (layout.checkpoint ? 2 : 0);
  const releaseGate = menuGate + (layout.gates ? 2 : 0);
  return {
    keyMap,
    preStringPadding,
    strings,
    stringReserved,
    text,
    checkpoint,
    menuGate,
    releaseGate,
    end: releaseGate + (layout.gates ? 1 : 0),
  };
}

/** Block-1 layout the selected profile serializes. */
export function block1Layout(profile: AgiProfile): Block1Layout {
  const layout = BLOCK1_LAYOUTS[profile.id];
  if (layout.kind === "pc") {
    const computed = block1Offsets(layout).end;
    if (computed !== layout.size) {
      throw new RangeError(
        `profile ${profile.id} block-1 layout computes ${computed}, expected ${layout.size}`,
      );
    }
  }
  return layout;
}

/** Total string records serialized (addressable slots plus the PC reserved bank). */
export function layoutStringTotal(layout: Block1Layout): number {
  return layout.kind === "pc" ? layout.stringSlots + layout.stringReserved : layout.stringSlots;
}

/** One `raw_key:u16le, status:u16le` script key mapping (spec, block 1). */
export interface KeyMapEntry {
  rawKey: number;
  status: number;
}

/** One two-byte replay pair (spec "Resource replay sequence"). */
export interface ReplayPair {
  kind: number;
  value: number;
}

/** One four-byte block-5 record (spec "Profile 2.936 block 5"). */
export interface LogicResumeRecord {
  logic: number;
  offset: number;
}

/**
 * One block-2 drawable-object record. The five reference tokens the file
 * carries are serialized profile data rather than portable object identity
 * (spec, block 2), so they are preserved verbatim in `tokens` and never
 * interpreted; a restoring engine rebuilds those associations from the loaded
 * view resource.
 */
export interface SaveObjectRecord {
  stepTime: number;
  stepCount: number;
  /** Boundary/collision event identifier; normalized to the table index on restore. */
  event: number;
  x: number;
  y: number;
  view: number;
  loop: number;
  loopCount: number;
  cel: number;
  celCount: number;
  prevX: number;
  prevY: number;
  width: number;
  height: number;
  stepSize: number;
  cycleTime: number;
  cycleCount: number;
  direction: number;
  motionMode: number;
  cycleMode: number;
  /** Priority/control byte; zero selects the automatic band. */
  priority: number;
  /** Object state flags word. */
  state: number;
  /** Mode-dependent motion parameters (4 bytes, meaning selected by motionMode). */
  motionParams: readonly [number, number, number, number];
  /** The five serialized reference tokens, in record order. */
  tokens: readonly [number, number, number, number, number];
  /**
   * The native record image this record decoded from (Amiga/IIgs 0x48-byte
   * runtime records). Fields the portable record does not model — pointers,
   * view-cache words — are re-emitted verbatim on the next encode, like
   * `reservedBlock1` does for block 1.
   */
  raw?: Uint8Array;
}

/** Portable contents of one save file. */
export interface SaveState {
  /** Displayed description: the zero-terminated prefix of the 31-byte header. */
  description: string;
  /**
   * The 31-byte header image this state decoded from, or null. Encoding
   * re-emits it verbatim when `description` is still its zero-terminated
   * prefix — the original leaves the previous string's tail bytes in the
   * field rather than clearing them.
   */
  descriptionImage: Uint8Array | null;
  /** Game/save signature area (7 bytes). */
  signature: Uint8Array;
  /** Variables v0..v255. */
  vars: Uint8Array;
  /** Flags f0..f255, one byte per flag (0 or 1); packed into 32 bytes on disk. */
  flags: Uint8Array;
  /** Unsigned 32-bit timer tick count. */
  timerTicks: number;
  horizon: number;
  /** Early-partition fields; ignored by the common partition. */
  displayMode: number;
  previousNavigation: number;
  navigationDirection: number;
  /** Reserved startup count of the early partition; preserved on round trip. */
  startupCount: number;
  blockLeft: number;
  blockTop: number;
  blockRight: number;
  blockBottom: number;
  blockEnabled: number;
  /** Object-0/global-direction coupling selector. */
  directionCoupling: number;
  lastPicture: number;
  replayCapacity: number;
  replayActive: number;
  replayCheckpoint: number;
  keyMap: KeyMapEntry[];
  strings: string[];
  textFg: number;
  textBg: number;
  textAttr: number;
  inputEnabled: number;
  inputRow: number;
  promptChar: number;
  statusEnabled: number;
  statusRow: number;
  displayBaseRow: number;
  displayBottomRow: number;
  /** Menu interaction gate and key-release enqueue gate (v3 layouts only). */
  menuGate: number;
  releaseGate: number;
  objects: SaveObjectRecord[];
  /** Decoded block 3: the game's runtime inventory payload with live locations. */
  inventory: Uint8Array;
  /** Block 4: exactly `replayCapacity` slots; the first `replayActive` participate. */
  replay: ReplayPair[];
  /** Block-5 cached-logic records, without the leading head or the terminator. */
  logicResume: LogicResumeRecord[];
  /**
   * The block-1 image this state was decoded from, or null for a synthesized
   * state. Encoding starts from it so every reserved byte the file supplied is
   * emitted unchanged (spec "Reserved-state rule").
   */
  reservedBlock1: Uint8Array | null;
  /**
   * Whole opaque blocks the profile's envelope carries ahead of the state
   * block — currently the Apple IIgs lead block. Decoded verbatim and
   * re-emitted at the same envelope position.
   */
  extraBlocks: Uint8Array[];
}

// ---------- little-endian primitives ----------

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function putU16(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
  );
}

function putU32(bytes: Uint8Array, at: number, value: number): void {
  putU16(bytes, at, value & 0xffff);
  putU16(bytes, at + 2, (value >>> 16) & 0xffff);
}

// ---------- big-endian primitives (Amiga state fields, IIgs envelope) ----------

function u16be(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

function putU16be(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >>> 8) & 0xff;
  bytes[at + 1] = value & 0xff;
}

function u32be(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

function putU32be(bytes: Uint8Array, at: number, value: number): void {
  putU16be(bytes, at, (value >>> 16) & 0xffff);
  putU16be(bytes, at + 2, value & 0xffff);
}

/** Zero-terminated ASCII prefix of a fixed-size field. */
function readZString(bytes: Uint8Array, at: number, size: number): string {
  let end = at;
  const limit = at + size;
  while (end < limit && bytes[end] !== 0) end++;
  let out = "";
  for (let i = at; i < end; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

/** Write an ASCII string zero-terminated into a fixed-size field, clearing the rest. */
function writeZString(bytes: Uint8Array, at: number, size: number, value: string): void {
  bytes.fill(0, at, at + size);
  const n = Math.min(value.length, size - 1);
  for (let i = 0; i < n; i++) bytes[at + i] = value.charCodeAt(i) & 0xff;
}

/**
 * Write a zero-terminated string into a fixed-size field without clearing
 * the bytes after the terminator — the Amiga and IIgs state images keep the
 * previous contents there (shipped saves show a prior string's tail and
 * space padding past the NUL).
 */
function writeZStringKeepTail(bytes: Uint8Array, at: number, size: number, value: string): void {
  const n = Math.min(value.length, size - 1);
  for (let i = 0; i < n; i++) bytes[at + i] = value.charCodeAt(i) & 0xff;
  bytes[at + n] = 0;
}

/**
 * Emit the 31-byte description header: the decoded header image verbatim
 * while `description` is still its zero-terminated prefix (the original
 * leaves the previous string's tail bytes in the field), else a fresh
 * zero-terminated write.
 */
function writeDescription(out: Uint8Array, state: SaveState): void {
  const image = state.descriptionImage;
  if (image && image.length === SAVE_DESCRIPTION_BYTES) {
    if (readZString(image, 0, SAVE_DESCRIPTION_BYTES) === state.description) {
      out.set(image, 0);
      return;
    }
  }
  writeZString(out, 0, SAVE_DESCRIPTION_BYTES, state.description);
}

/**
 * The repeating-key XOR applied to block 3 in the v3 profiles. It is its own
 * inverse: `stored[i] = runtime[i] XOR key[i modulo 11]`.
 */
export function transformBlock3(block: Uint8Array): Uint8Array {
  const out = new Uint8Array(block.length);
  for (let i = 0; i < block.length; i++) {
    out[i] = block[i]! ^ BLOCK3_XOR_KEY.charCodeAt(i % BLOCK3_XOR_KEY.length);
  }
  return out;
}

// ---------- flag packing ----------

/** Pack f0..f255 into 32 bytes; flag n is bit `n & 7` of byte `n >> 3`. */
function packFlags(flags: Uint8Array, into: Uint8Array, at: number): void {
  into.fill(0, at, at + FLAG_BYTES);
  for (let n = 0; n < 256; n++) {
    if (flags[n]) into[at + (n >> 3)] = into[at + (n >> 3)]! | (1 << (n & 7));
  }
}

function unpackFlags(bytes: Uint8Array, at: number): Uint8Array {
  const flags = new Uint8Array(256);
  for (let n = 0; n < 256; n++) {
    flags[n] = (bytes[at + (n >> 3)]! >> (n & 7)) & 1;
  }
  return flags;
}

// ---------- a canonically initialized state ----------

/**
 * A state whose reserved and unmapped bytes hold this profile's canonical
 * values (spec: reserved word `0x012d` is `00 00`, reserved word `0x013d` is
 * `0f 00`, and every other reserved record and padding is zero).
 */
export function newSaveState(profile: AgiProfile): SaveState {
  const layout = block1Layout(profile);
  return {
    description: "",
    descriptionImage: null,
    signature: new Uint8Array(SIGNATURE_BYTES),
    vars: new Uint8Array(256),
    flags: new Uint8Array(256),
    timerTicks: 0,
    horizon: 36,
    displayMode: 0,
    previousNavigation: 0,
    navigationDirection: 0,
    startupCount: 0,
    blockLeft: 0,
    blockTop: 0,
    blockRight: 0,
    blockBottom: 0,
    blockEnabled: 0,
    directionCoupling: 0,
    lastPicture: 0,
    replayCapacity: 0,
    replayActive: 0,
    replayCheckpoint: 0,
    keyMap: Array.from({ length: layout.keyMapEntries }, () => ({ rawKey: 0, status: 0 })),
    strings: Array.from({ length: layoutStringTotal(layout) }, () => ""),
    textFg: 15,
    textBg: 0,
    textAttr: 0,
    inputEnabled: 0,
    inputRow: 22,
    promptChar: 0,
    statusEnabled: 0,
    statusRow: 0,
    displayBaseRow: 1,
    displayBottomRow: 22,
    menuGate: 0,
    releaseGate: 0,
    objects: [],
    inventory: new Uint8Array(0),
    replay: [],
    logicResume: [],
    reservedBlock1: null,
    extraBlocks: [],
  };
}

/**
 * Canonical block-1 image: zeros except the two reserved words the spec names
 * (`0x012d` is `00 00`, `0x013d` is `0f 00`). The early partition has neither
 * of those words; its reserved startup count is a mapped field instead.
 */
function canonicalBlock1(layout: Block1Layout): Uint8Array {
  const block = new Uint8Array(layout.size);
  if (layout.kind === "pc" && layout.middle === "common") {
    putU16(block, OFF_MIDDLE + 2, 0x0000);
    putU16(block, OFF_MIDDLE + 18, 0x000f);
  }
  return block;
}

// ---------- block 1 ----------

function encodeBlock1(state: SaveState, layout: Block1Layout): Uint8Array {
  if (layout.kind === "amiga") return encodeBlock1Amiga(state, layout);
  if (layout.kind === "iigs") return encodeBlock1Iigs(state, layout);
  return encodeBlock1Pc(state, layout);
}

function decodeBlock1(block: Uint8Array, layout: Block1Layout, into: SaveState): void {
  if (layout.kind === "amiga") return decodeBlock1Amiga(block, layout, into);
  if (layout.kind === "iigs") return decodeBlock1Iigs(block, layout, into);
  return decodeBlock1Pc(block, layout, into);
}

function encodeBlock1Pc(state: SaveState, layout: PcBlock1Layout): Uint8Array {
  const off = block1Offsets(layout);
  const base = state.reservedBlock1;
  const block =
    base && base.length === layout.size ? Uint8Array.from(base) : canonicalBlock1(layout);

  block.set(state.signature.subarray(0, SIGNATURE_BYTES), OFF_SIGNATURE);
  block.set(state.vars.subarray(0, VAR_COUNT), OFF_VARS);
  packFlags(state.flags, block, OFF_FLAGS);
  putU32(block, OFF_TIMER, state.timerTicks);

  const m = OFF_MIDDLE;
  if (layout.middle === "early") {
    putU16(block, m, state.displayMode);
    putU16(block, m + 2, state.horizon);
    putU16(block, m + 4, state.previousNavigation);
    putU16(block, m + 6, state.blockLeft);
    putU16(block, m + 8, state.blockTop);
    putU16(block, m + 10, state.blockRight);
    putU16(block, m + 12, state.blockBottom);
    putU16(block, m + 14, state.directionCoupling);
    putU16(block, m + 16, state.lastPicture);
    putU16(block, m + 18, state.navigationDirection);
    putU16(block, m + 20, state.blockEnabled);
    putU16(block, m + 22, state.startupCount);
    putU16(block, m + 24, state.replayCapacity);
    putU16(block, m + 26, state.replayActive);
  } else {
    putU16(block, m, state.horizon);
    // m + 2: reserved word, canonical 00 00 — left as supplied.
    putU16(block, m + 4, state.blockLeft);
    putU16(block, m + 6, state.blockTop);
    putU16(block, m + 8, state.blockRight);
    putU16(block, m + 10, state.blockBottom);
    putU16(block, m + 12, state.directionCoupling);
    putU16(block, m + 14, state.lastPicture);
    putU16(block, m + 16, state.blockEnabled);
    // m + 18: reserved word, canonical 0f 00 — left as supplied.
    putU16(block, m + 20, state.replayCapacity);
    putU16(block, m + 22, state.replayActive);
  }

  for (let i = 0; i < layout.keyMapEntries; i++) {
    const entry = state.keyMap[i] ?? { rawKey: 0, status: 0 };
    putU16(block, off.keyMap + i * 4, entry.rawKey);
    putU16(block, off.keyMap + i * 4 + 2, entry.status);
  }
  // The reserved records follow the table contiguously and scripts reach them
  // as s12 and up (docs/fidelity.md, "Original string slot addressing").
  for (let i = 0; i < layout.stringSlots + layout.stringReserved; i++) {
    writeZString(block, off.strings + i * 40, 40, state.strings[i] ?? "");
  }

  const t = off.text;
  putU16(block, t, state.textFg);
  putU16(block, t + 2, state.textBg);
  putU16(block, t + 4, state.textAttr);
  putU16(block, t + 6, state.inputEnabled);
  putU16(block, t + 8, state.inputRow);
  block[t + 10] = state.promptChar & 0xff;
  // t + 11: reserved alignment byte, canonical zero — left as supplied.
  putU16(block, t + 12, state.statusEnabled);
  putU16(block, t + 14, state.statusRow);
  putU16(block, t + 16, state.displayBaseRow);
  putU16(block, t + 18, state.displayBottomRow);

  if (layout.checkpoint) putU16(block, off.checkpoint, state.replayCheckpoint);
  if (layout.gates) {
    putU16(block, off.menuGate, state.menuGate);
    block[off.releaseGate] = state.releaseGate & 0xff;
  }
  return block;
}

function decodeBlock1Pc(block: Uint8Array, layout: PcBlock1Layout, into: SaveState): void {
  if (block.length !== layout.size) {
    throw new RangeError(`block 1 is ${block.length} bytes, expected ${layout.size}`);
  }
  const off = block1Offsets(layout);
  into.reservedBlock1 = Uint8Array.from(block);
  into.signature = block.slice(OFF_SIGNATURE, OFF_SIGNATURE + SIGNATURE_BYTES);
  into.vars = block.slice(OFF_VARS, OFF_VARS + VAR_COUNT);
  into.flags = unpackFlags(block, OFF_FLAGS);
  into.timerTicks = u32(block, OFF_TIMER);

  const m = OFF_MIDDLE;
  if (layout.middle === "early") {
    into.displayMode = u16(block, m);
    into.horizon = u16(block, m + 2);
    into.previousNavigation = u16(block, m + 4);
    into.blockLeft = u16(block, m + 6);
    into.blockTop = u16(block, m + 8);
    into.blockRight = u16(block, m + 10);
    into.blockBottom = u16(block, m + 12);
    into.directionCoupling = u16(block, m + 14);
    into.lastPicture = u16(block, m + 16);
    into.navigationDirection = u16(block, m + 18);
    into.blockEnabled = u16(block, m + 20);
    into.startupCount = u16(block, m + 22);
    into.replayCapacity = u16(block, m + 24);
    into.replayActive = u16(block, m + 26);
  } else {
    into.horizon = u16(block, m);
    into.blockLeft = u16(block, m + 4);
    into.blockTop = u16(block, m + 6);
    into.blockRight = u16(block, m + 8);
    into.blockBottom = u16(block, m + 10);
    into.directionCoupling = u16(block, m + 12);
    into.lastPicture = u16(block, m + 14);
    into.blockEnabled = u16(block, m + 16);
    into.replayCapacity = u16(block, m + 20);
    into.replayActive = u16(block, m + 22);
  }

  into.keyMap = [];
  for (let i = 0; i < layout.keyMapEntries; i++) {
    into.keyMap.push({
      rawKey: u16(block, off.keyMap + i * 4),
      status: u16(block, off.keyMap + i * 4 + 2),
    });
  }
  into.strings = [];
  for (let i = 0; i < layout.stringSlots + layout.stringReserved; i++) {
    into.strings.push(readZString(block, off.strings + i * 40, 40));
  }

  const t = off.text;
  into.textFg = u16(block, t);
  into.textBg = u16(block, t + 2);
  into.textAttr = u16(block, t + 4);
  into.inputEnabled = u16(block, t + 6);
  into.inputRow = u16(block, t + 8);
  into.promptChar = block[t + 10]!;
  into.statusEnabled = u16(block, t + 12);
  into.statusRow = u16(block, t + 14);
  into.displayBaseRow = u16(block, t + 16);
  into.displayBottomRow = u16(block, t + 18);

  into.replayCheckpoint = layout.checkpoint ? u16(block, off.checkpoint) : 0;
  into.menuGate = layout.gates ? u16(block, off.menuGate) : 0;
  into.releaseGate = layout.gates ? block[off.releaseGate]! : 0;
}

// ---------- Amiga block 1 (the raw state-hunk image, big-endian) ----------

function encodeBlock1Amiga(state: SaveState, layout: AmigaBlock1Layout): Uint8Array {
  const base = state.reservedBlock1;
  const block =
    base && base.length === layout.size ? Uint8Array.from(base) : new Uint8Array(layout.size);
  block.set(state.signature.subarray(0, SIGNATURE_BYTES), OFF_SIGNATURE);
  putU32be(block, 0x08, state.timerTicks);
  putU16be(block, 0x0e, state.horizon);
  putU16be(block, 0x12, state.blockLeft);
  putU16be(block, 0x14, state.blockTop);
  putU16be(block, 0x16, state.blockRight);
  putU16be(block, 0x18, state.blockBottom);
  // +0x1a is the player/program-control flag (a long; `pause` reaches its
  // low word at +0x1c); +0x1e is the drawn picture number (docs/fidelity.md).
  putU32be(block, 0x1a, state.directionCoupling);
  putU16be(block, 0x1e, state.lastPicture);
  putU32be(block, layout.blockEnabled, state.blockEnabled);
  if (layout.navMirror !== null) putU16be(block, layout.navMirror, state.navigationDirection);
  putU16be(block, layout.replayCapacity, state.replayCapacity);
  putU16be(block, layout.replayActive, state.replayActive);
  for (let i = 0; i < layout.keyMapEntries; i++) {
    const entry = state.keyMap[i] ?? { rawKey: 0, status: 0 };
    putU16be(block, layout.keyMap + i * 4, entry.rawKey);
    putU16be(block, layout.keyMap + i * 4 + 2, entry.status);
  }
  for (let i = 0; i < layout.stringSlots; i++) {
    writeZStringKeepTail(block, layout.strings + i * 40, 40, state.strings[i] ?? "");
  }
  block.set(state.vars.subarray(0, VAR_COUNT), layout.vars);
  packFlags(state.flags, block, layout.flags);
  const t = layout.text;
  putU16be(block, t, state.textFg);
  putU16be(block, t + 2, state.textBg);
  putU16be(block, t + 4, state.textAttr);
  putU32be(block, t + 6, state.inputEnabled);
  putU16be(block, t + 0x0a, state.inputRow);
  block[t + 0x0c] = state.promptChar & 0xff;
  putU32be(block, t + 0x0e, state.statusEnabled);
  putU16be(block, t + 0x12, state.statusRow);
  putU16be(block, t + 0x14, state.displayBaseRow);
  putU16be(block, t + 0x16, state.displayBottomRow);
  return block;
}

function decodeBlock1Amiga(block: Uint8Array, layout: AmigaBlock1Layout, into: SaveState): void {
  if (block.length !== layout.size) {
    throw new RangeError(`block 1 is ${block.length} bytes, expected ${layout.size}`);
  }
  into.reservedBlock1 = Uint8Array.from(block);
  into.signature = block.slice(OFF_SIGNATURE, OFF_SIGNATURE + SIGNATURE_BYTES);
  into.timerTicks = u32be(block, 0x08);
  into.horizon = u16be(block, 0x0e);
  into.blockLeft = u16be(block, 0x12);
  into.blockTop = u16be(block, 0x14);
  into.blockRight = u16be(block, 0x16);
  into.blockBottom = u16be(block, 0x18);
  into.directionCoupling = u32be(block, 0x1a);
  into.lastPicture = u16be(block, 0x1e);
  into.blockEnabled = u32be(block, layout.blockEnabled);
  if (layout.navMirror !== null) into.navigationDirection = u16be(block, layout.navMirror);
  into.replayCapacity = u16be(block, layout.replayCapacity);
  into.replayActive = u16be(block, layout.replayActive);
  into.keyMap = [];
  for (let i = 0; i < layout.keyMapEntries; i++) {
    into.keyMap.push({
      rawKey: u16be(block, layout.keyMap + i * 4),
      status: u16be(block, layout.keyMap + i * 4 + 2),
    });
  }
  into.strings = [];
  for (let i = 0; i < layout.stringSlots; i++) {
    into.strings.push(readZString(block, layout.strings + i * 40, 40));
  }
  into.vars = block.slice(layout.vars, layout.vars + VAR_COUNT);
  into.flags = unpackFlags(block, layout.flags);
  const t = layout.text;
  into.textFg = u16be(block, t);
  into.textBg = u16be(block, t + 2);
  into.textAttr = u16be(block, t + 4);
  into.inputEnabled = u32be(block, t + 6);
  into.inputRow = u16be(block, t + 0x0a);
  into.promptChar = block[t + 0x0c]!;
  into.statusEnabled = u32be(block, t + 0x0e);
  into.statusRow = u16be(block, t + 0x12);
  into.displayBaseRow = u16be(block, t + 0x14);
  into.displayBottomRow = u16be(block, t + 0x16);
}

// ---------- Apple IIgs block 1 (the 0x3d0-byte state block, little-endian) ----------

function encodeBlock1Iigs(state: SaveState, layout: IigsBlock1Layout): Uint8Array {
  const base = state.reservedBlock1;
  const block =
    base && base.length === layout.size ? Uint8Array.from(base) : new Uint8Array(layout.size);
  for (let i = 0; i < layout.keyMapEntries; i++) {
    const entry = state.keyMap[i] ?? { rawKey: 0, status: 0 };
    putU16(block, layout.keyMap + i * 4, entry.rawKey);
    putU16(block, layout.keyMap + i * 4 + 2, entry.status);
  }
  for (let i = 0; i < layout.stringSlots; i++) {
    writeZStringKeepTail(block, layout.strings + i * 40, 40, state.strings[i] ?? "");
  }
  block.set(state.vars.subarray(0, VAR_COUNT), layout.vars);
  packFlags(state.flags, block, layout.flags);
  return block;
}

function decodeBlock1Iigs(block: Uint8Array, layout: IigsBlock1Layout, into: SaveState): void {
  if (block.length !== layout.size) {
    throw new RangeError(`block 1 is ${block.length} bytes, expected ${layout.size}`);
  }
  into.reservedBlock1 = Uint8Array.from(block);
  into.keyMap = [];
  for (let i = 0; i < layout.keyMapEntries; i++) {
    into.keyMap.push({
      rawKey: u16(block, layout.keyMap + i * 4),
      status: u16(block, layout.keyMap + i * 4 + 2),
    });
  }
  into.strings = [];
  for (let i = 0; i < layout.stringSlots; i++) {
    into.strings.push(readZString(block, layout.strings + i * 40, 40));
  }
  into.vars = block.slice(layout.vars, layout.vars + VAR_COUNT);
  into.flags = unpackFlags(block, layout.flags);
}

// ---------- block 2 ----------

/** A record whose every field is zero, for a synthesized object. */
export function newObjectRecord(): SaveObjectRecord {
  return {
    stepTime: 0,
    stepCount: 0,
    event: 0,
    x: 0,
    y: 0,
    view: 0,
    loop: 0,
    loopCount: 0,
    cel: 0,
    celCount: 0,
    prevX: 0,
    prevY: 0,
    width: 0,
    height: 0,
    stepSize: 0,
    cycleTime: 0,
    cycleCount: 0,
    direction: 0,
    motionMode: 0,
    cycleMode: 0,
    priority: 0,
    state: 0,
    motionParams: [0, 0, 0, 0],
    tokens: [0, 0, 0, 0, 0],
  };
}

function encodeBlock2(objects: readonly SaveObjectRecord[]): Uint8Array {
  const block = new Uint8Array(objects.length * OBJECT_RECORD_BYTES);
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i]!;
    const at = i * OBJECT_RECORD_BYTES;
    block[at] = o.stepTime & 0xff;
    block[at + 0x01] = o.stepCount & 0xff;
    block[at + 0x02] = o.event & 0xff;
    putU16(block, at + 0x03, o.x);
    putU16(block, at + 0x05, o.y);
    block[at + 0x07] = o.view & 0xff;
    putU16(block, at + 0x08, o.tokens[0]);
    block[at + 0x0a] = o.loop & 0xff;
    block[at + 0x0b] = o.loopCount & 0xff;
    putU16(block, at + 0x0c, o.tokens[1]);
    block[at + 0x0e] = o.cel & 0xff;
    block[at + 0x0f] = o.celCount & 0xff;
    putU16(block, at + 0x10, o.tokens[2]);
    putU16(block, at + 0x12, o.tokens[3]);
    putU16(block, at + 0x14, o.tokens[4]);
    putU16(block, at + 0x16, o.prevX);
    putU16(block, at + 0x18, o.prevY);
    putU16(block, at + 0x1a, o.width);
    putU16(block, at + 0x1c, o.height);
    block[at + 0x1e] = o.stepSize & 0xff;
    block[at + 0x1f] = o.cycleTime & 0xff;
    block[at + 0x20] = o.cycleCount & 0xff;
    block[at + 0x21] = o.direction & 0xff;
    block[at + 0x22] = o.motionMode & 0xff;
    block[at + 0x23] = o.cycleMode & 0xff;
    block[at + 0x24] = o.priority & 0xff;
    putU16(block, at + 0x25, o.state);
    for (let p = 0; p < 4; p++) block[at + 0x27 + p] = o.motionParams[p]! & 0xff;
  }
  return block;
}

function decodeBlock2(block: Uint8Array): SaveObjectRecord[] {
  if (block.length % OBJECT_RECORD_BYTES !== 0) {
    throw new RangeError(
      `block 2 is ${block.length} bytes, not a multiple of ${OBJECT_RECORD_BYTES}`,
    );
  }
  const out: SaveObjectRecord[] = [];
  for (let at = 0; at < block.length; at += OBJECT_RECORD_BYTES) {
    out.push({
      stepTime: block[at]!,
      stepCount: block[at + 0x01]!,
      event: block[at + 0x02]!,
      x: u16(block, at + 0x03),
      y: u16(block, at + 0x05),
      view: block[at + 0x07]!,
      loop: block[at + 0x0a]!,
      loopCount: block[at + 0x0b]!,
      cel: block[at + 0x0e]!,
      celCount: block[at + 0x0f]!,
      prevX: u16(block, at + 0x16),
      prevY: u16(block, at + 0x18),
      width: u16(block, at + 0x1a),
      height: u16(block, at + 0x1c),
      stepSize: block[at + 0x1e]!,
      cycleTime: block[at + 0x1f]!,
      cycleCount: block[at + 0x20]!,
      direction: block[at + 0x21]!,
      motionMode: block[at + 0x22]!,
      cycleMode: block[at + 0x23]!,
      priority: block[at + 0x24]!,
      state: u16(block, at + 0x25),
      motionParams: [block[at + 0x27]!, block[at + 0x28]!, block[at + 0x29]!, block[at + 0x2a]!],
      tokens: [
        u16(block, at + 0x08),
        u16(block, at + 0x0c),
        u16(block, at + 0x10),
        u16(block, at + 0x12),
        u16(block, at + 0x14),
      ],
    });
  }
  return out;
}

// ---------- Amiga/IIgs block 2 (0x48-byte runtime records) ----------

/** Bytes of one Amiga/IIgs drawable-object record (docs/fidelity.md). */
export const NATIVE_OBJECT_RECORD_BYTES = 0x48;

/**
 * The Amiga family's native flag word (record +0x3e) is its own bit
 * assignment, not the engine's portable packing — the verified bits
 * (docs/fidelity.md "Amiga interpreter profiles"):
 *
 *   0x0001 drawn      0x0010 update      0x0100 water "both"
 *   0x0004 fixed pri  0x0020 cycling     0x0200 ignore objects
 *   0x0008 ignore hor 0x0040 animated    0x0800 water "off" (0x0900 = "on")
 *   0x1000 stationary 0x2000 fix.loop
 *
 * 0x0002 is ignore.blocks on both families (verified). 0x0040 is the
 * "animated" state `animate.obj` writes; the portable word has no
 * corresponding bit, so it and the unverified 0x0400/0x4000 bits round-trip
 * through the record's `raw` image.
 */
const AMIGA_FLAG_MAPPED =
  0x0001 | 0x0002 | 0x0004 | 0x0008 | 0x0010 | 0x0020 | 0x0100 | 0x0200 | 0x0800 | 0x1000 | 0x2000;

/** Portable state-word bits this translation reads (engine's packing). */
const P_ACTIVE = 0x0001;
const P_UPDATE = 0x0002;
const P_CYCLING = 0x0004;
const P_FIXED_PRIORITY = 0x0008;
const P_OBSERVE_HORIZON = 0x0010;
const P_OBSERVE_BLOCKS = 0x0020;
const P_OBSERVE_OBJECTS = 0x0040;
const P_LOOP_FIXED = 0x0080;
const P_WATER_ON = 0x0100;
const P_WATER_OFF = 0x0200;
const P_EARLIER_PARTITION = 0x0400;
const P_STATIONARY = 0x2000;

/** Portable -> native motion-mode values: {normal, move, follow, wander, click} -> {0,3,2,1,4}.
 * Identical on the Amiga builds and the Apple IIgs (verified from the
 * normal.motion/move.obj/follow.ego/wander handlers on both). */
const NATIVE_MOTION: readonly number[] = [0, 3, 2, 1, 4];
/** Portable -> Amiga native cycle-mode values: {forward, reverse, end.of.loop, reverse.loop} -> {0,1,3,2}. */
const NATIVE_CYCLE: readonly number[] = [0, 1, 3, 2];
/** Portable -> IIgs native cycle-mode values -> {0,3,1,2}: the IIgs
 * reverse.cycle/end.of.loop/reverse.loop handlers write the PC order
 * (docs/fidelity.md "Apple IIgs interpreter"). */
const IIGS_CYCLE: readonly number[] = [0, 3, 1, 2];

function nativeFlagsFromPortable(state: number): number {
  let w = 0;
  // 0x0001 is "drawn" (drawseg/draw handlers on both families); an object in
  // the earlier drawn partition is drawn too.
  if (state & (P_ACTIVE | P_EARLIER_PARTITION)) w |= 0x0001;
  if (!(state & P_OBSERVE_BLOCKS)) w |= 0x0002;
  if (state & P_FIXED_PRIORITY) w |= 0x0004;
  if (!(state & P_OBSERVE_HORIZON)) w |= 0x0008;
  if (state & P_UPDATE) w |= 0x0010;
  if (state & P_CYCLING) w |= 0x0020;
  const water = state & (P_WATER_ON | P_WATER_OFF);
  if (water === (P_WATER_ON | P_WATER_OFF)) w |= 0x0100;
  else if (water === P_WATER_OFF) w |= 0x0800;
  else if (water === P_WATER_ON) w |= 0x0900;
  if (!(state & P_OBSERVE_OBJECTS)) w |= 0x0200;
  if (state & P_STATIONARY) w |= 0x1000;
  if (state & P_LOOP_FIXED) w |= 0x2000;
  return w;
}

function portableFlagsFromNative(w: number): number {
  // 0x0002 is the native ignore.blocks bit (blockseg/motion handlers on both
  // families); the portable word tracks the observing state instead.
  let s = w & 0x0002 ? 0 : P_OBSERVE_BLOCKS;
  if (w & 0x0001) s |= P_ACTIVE;
  if (w & 0x0010) s |= P_UPDATE;
  if (w & 0x0020) s |= P_CYCLING;
  if (w & 0x0004) s |= P_FIXED_PRIORITY;
  if (!(w & 0x0008)) s |= P_OBSERVE_HORIZON;
  if (!(w & 0x0200)) s |= P_OBSERVE_OBJECTS;
  if (w & 0x2000) s |= P_LOOP_FIXED;
  const water = w & 0x0900;
  if (water === 0x0900) s |= P_WATER_ON;
  else if (water === 0x0800) s |= P_WATER_OFF;
  else if (w & 0x0100) s |= P_WATER_ON | P_WATER_OFF;
  // Drawn without an update pass is the earlier-drawn partition.
  if (w & 0x0001 && !(w & 0x0010)) s |= P_EARLIER_PARTITION;
  if (w & 0x1000) s |= P_STATIONARY;
  return s;
}

function encodeBlock2Native(
  objects: readonly SaveObjectRecord[],
  be: boolean,
  cycles: readonly number[],
): Uint8Array {
  const block = new Uint8Array(objects.length * NATIVE_OBJECT_RECORD_BYTES);
  const w16 = be ? putU16be : putU16;
  const r16 = be ? u16be : u16;
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i]!;
    const at = i * NATIVE_OBJECT_RECORD_BYTES;
    // Start from the decoded image so pointers (+0x0c..0x27) and the
    // unmapped flag bits keep their native contents.
    const base = o.raw;
    if (base && base.length === NATIVE_OBJECT_RECORD_BYTES) block.set(base, at);
    w16(block, at + 0x00, o.stepTime);
    w16(block, at + 0x02, o.stepCount);
    w16(block, at + 0x04, o.event);
    w16(block, at + 0x06, o.x);
    w16(block, at + 0x08, o.y);
    w16(block, at + 0x0a, o.view);
    w16(block, at + 0x10, o.loop);
    w16(block, at + 0x12, o.loopCount);
    w16(block, at + 0x18, o.cel);
    w16(block, at + 0x1a, o.celCount);
    w16(block, at + 0x28, o.prevX);
    w16(block, at + 0x2a, o.prevY);
    w16(block, at + 0x2c, o.width);
    w16(block, at + 0x2e, o.height);
    w16(block, at + 0x30, o.stepSize);
    w16(block, at + 0x32, o.cycleTime);
    w16(block, at + 0x34, o.cycleCount);
    w16(block, at + 0x36, o.direction);
    w16(block, at + 0x38, NATIVE_MOTION[o.motionMode] ?? 0);
    w16(block, at + 0x3a, cycles[o.cycleMode] ?? 0);
    w16(block, at + 0x3c, o.priority);
    // Unmapped flag bits survive through the preserved image; the mapped
    // bits come from the portable state word.
    const carried = base && base.length === NATIVE_OBJECT_RECORD_BYTES ? r16(base, 0x3e) : 0;
    w16(block, at + 0x3e, (carried & ~AMIGA_FLAG_MAPPED) | nativeFlagsFromPortable(o.state));
    // The parameter bank is four bytes riding in the low half of four words.
    for (let p = 0; p < 4; p++) {
      block[at + 0x40 + p * 2 + (be ? 1 : 0)] = o.motionParams[p]! & 0xff;
    }
  }
  return block;
}

function decodeBlock2Native(
  block: Uint8Array,
  be: boolean,
  cycles: readonly number[],
): SaveObjectRecord[] {
  if (block.length % NATIVE_OBJECT_RECORD_BYTES !== 0) {
    throw new RangeError(
      `block 2 is ${block.length} bytes, not a multiple of ${NATIVE_OBJECT_RECORD_BYTES}`,
    );
  }
  const r16 = be ? u16be : u16;
  const out: SaveObjectRecord[] = [];
  for (let at = 0; at < block.length; at += NATIVE_OBJECT_RECORD_BYTES) {
    const rec = block.slice(at, at + NATIVE_OBJECT_RECORD_BYTES);
    const record = newObjectRecord();
    record.stepTime = r16(rec, 0x00);
    record.stepCount = r16(rec, 0x02);
    record.event = r16(rec, 0x04);
    record.x = r16(rec, 0x06);
    record.y = r16(rec, 0x08);
    record.view = r16(rec, 0x0a);
    record.loop = r16(rec, 0x10);
    record.loopCount = r16(rec, 0x12);
    record.cel = r16(rec, 0x18);
    record.celCount = r16(rec, 0x1a);
    record.prevX = r16(rec, 0x28);
    record.prevY = r16(rec, 0x2a);
    record.width = r16(rec, 0x2c);
    record.height = r16(rec, 0x2e);
    record.stepSize = r16(rec, 0x30);
    record.cycleTime = r16(rec, 0x32);
    record.cycleCount = r16(rec, 0x34);
    record.direction = r16(rec, 0x36);
    // The Amiga tables are involutions; the IIgs cycle table is not — decode
    // native values through a reverse lookup of the portable->native table.
    record.motionMode = Math.max(0, NATIVE_MOTION.indexOf(r16(rec, 0x38)));
    if (record.motionMode < 0) record.motionMode = 0;
    record.cycleMode = Math.max(0, cycles.indexOf(r16(rec, 0x3a)));
    record.priority = r16(rec, 0x3c);
    record.state = portableFlagsFromNative(r16(rec, 0x3e));
    record.motionParams = [
      rec[0x40 + (be ? 1 : 0)]!,
      rec[0x42 + (be ? 1 : 0)]!,
      rec[0x44 + (be ? 1 : 0)]!,
      rec[0x46 + (be ? 1 : 0)]!,
    ];
    record.raw = rec;
    out.push(record);
  }
  return out;
}

// ---------- blocks 4 and 5 ----------

function encodeBlock4(replay: readonly ReplayPair[], capacity: number): Uint8Array {
  const block = new Uint8Array(capacity * 2);
  for (let i = 0; i < capacity; i++) {
    const pair = replay[i];
    if (!pair) break;
    block[i * 2] = pair.kind & 0xff;
    block[i * 2 + 1] = pair.value & 0xff;
  }
  return block;
}

function decodeBlock4(block: Uint8Array): ReplayPair[] {
  if (block.length % 2 !== 0)
    throw new RangeError(`block 4 is ${block.length} bytes, not a multiple of 2`);
  const out: ReplayPair[] = [];
  for (let at = 0; at < block.length; at += 2)
    out.push({ kind: block[at]!, value: block[at + 1]! });
  return out;
}

function encodeBlock5(records: readonly LogicResumeRecord[]): Uint8Array {
  // A leading cache-head record, one record per cached logic, and a terminator.
  const block = new Uint8Array((records.length + 2) * 4);
  putU16(block, 0, 0);
  putU16(block, 2, 0);
  for (let i = 0; i < records.length; i++) {
    putU16(block, 4 + i * 4, records[i]!.logic);
    putU16(block, 6 + i * 4, records[i]!.offset);
  }
  putU16(block, 4 + records.length * 4, LOGIC_RESUME_TERMINATOR);
  putU16(block, 6 + records.length * 4, 0);
  return block;
}

function decodeBlock5(block: Uint8Array): LogicResumeRecord[] {
  if (block.length % 4 !== 0)
    throw new RangeError(`block 5 is ${block.length} bytes, not a multiple of 4`);
  const out: LogicResumeRecord[] = [];
  // Skip the leading cache-head record; stop at the terminator.
  for (let at = 4; at + 4 <= block.length; at += 4) {
    const logic = u16(block, at);
    if (logic === LOGIC_RESUME_TERMINATOR) break;
    out.push({ logic, offset: u16(block, at + 2) });
  }
  return out;
}

/**
 * Resume offset for a replay-loaded logic: the FIRST record with that number
 * wins, and no match leaves the logic at its normal bytecode entry
 * (spec "Profile 2.936 block 5").
 */
export function resumeOffsetFor(records: readonly LogicResumeRecord[], logic: number): number {
  for (const record of records) {
    if (record.logic === logic) return record.offset;
  }
  return 0;
}

/**
 * The Amiga logic-resume block carries the same grammar — a {0,0}
 * cache-head record, one {logic, offset} record per cached logic and a
 * {0xffff, 0} terminator — in the state hunk's big-endian byte order
 * (docs/fidelity.md "Amiga interpreter profiles"). The IIgs keeps the
 * little-endian form.
 */
function encodeBlock5Native(records: readonly LogicResumeRecord[]): Uint8Array {
  const block = new Uint8Array((records.length + 2) * 4);
  putU16be(block, 0, 0);
  putU16be(block, 2, 0);
  for (let i = 0; i < records.length; i++) {
    putU16be(block, 4 + i * 4, records[i]!.logic);
    putU16be(block, 6 + i * 4, records[i]!.offset);
  }
  putU16be(block, 4 + records.length * 4, LOGIC_RESUME_TERMINATOR);
  putU16be(block, 6 + records.length * 4, 0);
  return block;
}

function decodeBlock5Native(block: Uint8Array): LogicResumeRecord[] {
  if (block.length % 4 !== 0)
    throw new RangeError(`block 5 is ${block.length} bytes, not a multiple of 4`);
  const out: LogicResumeRecord[] = [];
  for (let at = 4; at + 4 <= block.length; at += 4) {
    const logic = u16be(block, at);
    if (logic === LOGIC_RESUME_TERMINATOR) break;
    out.push({ logic, offset: u16be(block, at + 2) });
  }
  return out;
}

// ---------- envelope ----------

/** Encode a save state as the real file image for the selected profile. */
export function encodeSave(state: SaveState, profile: AgiProfile): Uint8Array {
  const layout = block1Layout(profile);
  if (state.replay.length > state.replayCapacity) {
    throw new RangeError(
      `replay sequence has ${state.replay.length} pairs, capacity is ${state.replayCapacity}`,
    );
  }
  if (layout.kind === "iigs") return encodeSaveIigs(state, layout);

  const blocks: Uint8Array[] = [
    encodeBlock1(state, layout),
    layout.kind === "amiga"
      ? encodeBlock2Native(state.objects, true, NATIVE_CYCLE)
      : encodeBlock2(state.objects),
    profile.saveBlock3Xor ? transformBlock3(state.inventory) : Uint8Array.from(state.inventory),
    encodeBlock4(state.replay, state.replayCapacity),
  ];
  if (profile.saveBlocks >= 5) {
    // The Amiga logic-resume block is big-endian; the PC grammar is little-endian.
    blocks.push(
      layout.kind === "amiga"
        ? encodeBlock5Native(state.logicResume)
        : encodeBlock5(state.logicResume),
    );
  }

  let size = SAVE_DESCRIPTION_BYTES;
  for (const block of blocks) size += 2 + block.length;
  const out = new Uint8Array(size);
  writeDescription(out, state);
  let at = SAVE_DESCRIPTION_BYTES;
  for (const block of blocks) {
    putU16(out, at, block.length);
    out.set(block, at + 2);
    at += 2 + block.length;
  }
  return out;
}

/**
 * The Apple IIgs envelope: six blocks with big-endian lengths — the opaque
 * lead block, the state block, the little-endian object records, the raw
 * inventory, the replay pairs and the logic-resume records
 * (docs/fidelity.md "Apple IIgs interpreter").
 */
function encodeSaveIigs(state: SaveState, layout: IigsBlock1Layout): Uint8Array {
  const lead =
    state.extraBlocks[0] && state.extraBlocks[0]!.length === layout.lead
      ? Uint8Array.from(state.extraBlocks[0]!)
      : new Uint8Array(layout.lead);
  // The lead block is the bank-0 globals image ($010d..$0144): horizon,
  // the block rectangle and enable, the player/program-control flag and the
  // replay capacity sit at the verified offsets (docs/fidelity.md).
  putU16(lead, layout.horizon, state.horizon);
  putU16(lead, layout.blockRect, state.blockLeft);
  putU16(lead, layout.blockRect + 2, state.blockTop);
  putU16(lead, layout.blockRect + 4, state.blockRight);
  putU16(lead, layout.blockRect + 6, state.blockBottom);
  putU16(lead, layout.controlFlag, state.directionCoupling);
  putU16(lead, layout.blockEnabled, state.blockEnabled);
  putU16(lead, layout.replayCapacity, state.replayCapacity);
  const blocks: Uint8Array[] = [
    lead,
    encodeBlock1(state, layout),
    encodeBlock2Native(state.objects, false, IIGS_CYCLE),
    Uint8Array.from(state.inventory),
    encodeBlock4(state.replay, state.replayCapacity),
    encodeBlock5(state.logicResume),
  ];
  let size = SAVE_DESCRIPTION_BYTES;
  for (const block of blocks) size += 2 + block.length;
  const out = new Uint8Array(size);
  writeDescription(out, state);
  let at = SAVE_DESCRIPTION_BYTES;
  for (const block of blocks) {
    putU16be(out, at, block.length);
    out.set(block, at + 2);
    at += 2 + block.length;
  }
  return out;
}

/** Decode a save file image written for the selected profile. */
export function decodeSave(bytes: Uint8Array, profile: AgiProfile): SaveState {
  const layout = block1Layout(profile);
  if (bytes.length < SAVE_DESCRIPTION_BYTES) {
    throw new RangeError(`save file is ${bytes.length} bytes, shorter than its description header`);
  }
  const state = newSaveState(profile);
  state.description = readZString(bytes, 0, SAVE_DESCRIPTION_BYTES);
  state.descriptionImage = Uint8Array.from(bytes.subarray(0, SAVE_DESCRIPTION_BYTES));

  const bigEndian = layout.kind === "iigs";
  const blocks: Uint8Array[] = [];
  let at = SAVE_DESCRIPTION_BYTES;
  for (let i = 0; i < profile.saveBlocks; i++) {
    if (at + 2 > bytes.length)
      throw new RangeError(`save file ends before block ${i + 1}'s length`);
    const length = bigEndian ? u16be(bytes, at) : u16(bytes, at);
    if (at + 2 + length > bytes.length)
      throw new RangeError(`save file ends inside block ${i + 1}`);
    blocks.push(bytes.slice(at + 2, at + 2 + length));
    at += 2 + length;
  }

  if (layout.kind === "iigs") {
    state.extraBlocks = [blocks.shift()!];
    const lead = state.extraBlocks[0]!;
    if (lead.length !== layout.lead) {
      throw new RangeError(`lead block is ${lead.length} bytes, expected ${layout.lead}`);
    }
    state.horizon = u16(lead, layout.horizon);
    state.blockLeft = u16(lead, layout.blockRect);
    state.blockTop = u16(lead, layout.blockRect + 2);
    state.blockRight = u16(lead, layout.blockRect + 4);
    state.blockBottom = u16(lead, layout.blockRect + 6);
    state.directionCoupling = u16(lead, layout.controlFlag);
    state.blockEnabled = u16(lead, layout.blockEnabled);
    state.replayCapacity = u16(lead, layout.replayCapacity);
  }
  decodeBlock1(blocks[0]!, layout, state);
  state.objects =
    layout.kind === "pc"
      ? decodeBlock2(blocks[1]!)
      : decodeBlock2Native(
          blocks[1]!,
          layout.kind === "amiga",
          layout.kind === "iigs" ? IIGS_CYCLE : NATIVE_CYCLE,
        );
  const block3 = blocks[2]!;
  state.inventory = profile.saveBlock3Xor ? transformBlock3(block3) : block3;
  state.replay = decodeBlock4(blocks[3]!);
  if (state.replay.length !== state.replayCapacity) {
    throw new RangeError(
      `block ${layout.kind === "iigs" ? 5 : 4} holds ${state.replay.length} pairs but ` +
        `${layout.kind === "iigs" ? "the lead block" : "block 1"} configures ${state.replayCapacity}`,
    );
  }
  if (state.replayActive > state.replayCapacity) {
    throw new RangeError(
      `active replay count ${state.replayActive} exceeds capacity ${state.replayCapacity}`,
    );
  }
  const last = blocks[blocks.length - 1]!;
  if (profile.saveBlocks >= 5) {
    state.logicResume = layout.kind === "amiga" ? decodeBlock5Native(last) : decodeBlock5(last);
  }
  return state;
}

// ---------- host autosave envelope ----------

/**
 * Extends beyond the 31-byte description and puts 0xffff where a bare save
 * stores its first block length. No supported profile has that block length,
 * so even a description containing the marker cannot identify a bare save.
 */
const HOST_IMAGE_MAGIC = "MONOTIO AUTOSAVE".padEnd(SAVE_DESCRIPTION_BYTES + 2, "\xff");
const HOST_IMAGE_VERSION = 1;
const HOST_IMAGE_HEADER = HOST_IMAGE_MAGIC.length + 1 + 4;

const HOST_TEXT_CELLS = TEXT_COLS * TEXT_ROWS;
const HOST_DRAW_COUNT = 256;
const HOST_PRESENTATION_BYTES = 8 + HOST_TEXT_CELLS * 6 + HOST_DRAW_COUNT * 24;

export interface HostDraw {
  drawSeq: number;
  drawnX: number;
  drawnY: number;
  drawnWidth: number;
  drawnHeight: number;
}

/** Host-only text and draw ages; these never enter an authentic save.game file. */
export interface HostPresentation {
  cells: Uint8Array;
  written: Uint32Array;
  seq: number;
  draws: HostDraw[];
}

/** A host autosave taken apart (see Engine.autosaveImage). */
export interface HostImage {
  /** The authentic save image, byte for byte what save.game writes. */
  image: Uint8Array;
  /**
   * The screen sequence that rebuilds the room: every load and draw since the
   * room began, whether or not f7 kept it out of the game's replay. Null for a
   * bare save image, whose own replay is then the only screen there is.
   */
  screen: ReplayPair[] | null;
  presentation?: HostPresentation;
  /**
   * The parked pass the snapshot was taken at — an open window or a have.key
   * wait — so the resume restores the identical instruction, not a fresh pass.
   * Absent from non-parked snapshots.
   */
  continuation?: ParkedContinuation | null;
}

/**
 * Wrap a save image with the engine's screen sequence for a host autosave.
 * The envelope keeps the two apart so a resume restores the game's replay and
 * capacity from the image and rebuilds the screen from the sequence; a later
 * save.game then writes what the game recorded, not what the host needed.
 * Layout: the 33-byte marker, u8 version, u32le image length, the image, u16le pair
 * count, the pairs as block 4 encodes them, then a presence byte and optional
 * fixed-size presentation: f64 sequence, cells, u32 write stamps, and 256
 * draw records (f64 sequence and four i32 bounds). The envelope ends with a u32le
 * length and the parked-pass continuation as UTF-8 JSON (length 0: none).
 * All numbers are little-endian.
 */
export function encodeHostImage(
  image: Uint8Array,
  screen: readonly ReplayPair[],
  presentation?: HostPresentation,
  continuation?: ParkedContinuation | null,
): Uint8Array {
  if (screen.length > 0xffff)
    throw new RangeError(`screen sequence has ${screen.length} pairs, more than the 65535 fit`);
  if (
    presentation &&
    (presentation.cells.length !== HOST_TEXT_CELLS * 2 ||
      presentation.written.length !== HOST_TEXT_CELLS ||
      presentation.draws.length !== HOST_DRAW_COUNT)
  )
    throw new RangeError("host autosave presentation dimensions are invalid");
  const continuationBytes = continuation
    ? new TextEncoder().encode(JSON.stringify(continuation))
    : new Uint8Array(0);
  const out = new Uint8Array(
    HOST_IMAGE_HEADER +
      image.length +
      2 +
      screen.length * 2 +
      1 +
      (presentation ? HOST_PRESENTATION_BYTES : 0) +
      4 +
      continuationBytes.length,
  );
  for (let i = 0; i < HOST_IMAGE_MAGIC.length; i++) out[i] = HOST_IMAGE_MAGIC.charCodeAt(i);
  out[HOST_IMAGE_MAGIC.length] = HOST_IMAGE_VERSION;
  putU32(out, HOST_IMAGE_MAGIC.length + 1, image.length);
  out.set(image, HOST_IMAGE_HEADER);
  let at = HOST_IMAGE_HEADER + image.length;
  putU16(out, at, screen.length);
  at += 2;
  for (const pair of screen) {
    out[at++] = pair.kind & 0xff;
    out[at++] = pair.value & 0xff;
  }
  out[at++] = presentation ? 1 : 0;
  if (presentation) {
    const view = new DataView(out.buffer);
    view.setFloat64(at, presentation.seq, true);
    at += 8;
    out.set(presentation.cells, at);
    at += HOST_TEXT_CELLS * 2;
    for (const stamp of presentation.written) {
      putU32(out, at, stamp);
      at += 4;
    }
    for (const draw of presentation.draws) {
      view.setFloat64(at, draw.drawSeq, true);
      view.setInt32(at + 8, draw.drawnX, true);
      view.setInt32(at + 12, draw.drawnY, true);
      view.setInt32(at + 16, draw.drawnWidth, true);
      view.setInt32(at + 20, draw.drawnHeight, true);
      at += 24;
    }
  }
  putU32(out, at, continuationBytes.length);
  out.set(continuationBytes, at + 4);
  return out;
}

/** Take a host autosave apart; bytes without the marker are a bare save image. */
export function decodeHostImage(bytes: Uint8Array): HostImage {
  let marked = bytes.length >= HOST_IMAGE_MAGIC.length;
  for (let i = 0; marked && i < HOST_IMAGE_MAGIC.length; i++) {
    marked = bytes[i] === HOST_IMAGE_MAGIC.charCodeAt(i);
  }
  if (!marked) return { image: bytes, screen: null };
  if (bytes.length < HOST_IMAGE_HEADER)
    throw new RangeError("host autosave ends before its image length");
  const version = bytes[HOST_IMAGE_MAGIC.length]!;
  if (version !== HOST_IMAGE_VERSION)
    throw new RangeError(`unsupported host autosave version ${version}`);
  const imageLength = u32(bytes, HOST_IMAGE_MAGIC.length + 1);
  const countAt = HOST_IMAGE_HEADER + imageLength;
  if (countAt + 2 > bytes.length) throw new RangeError("host autosave ends inside its save image");
  const count = u16(bytes, countAt);
  const pairEnd = countAt + 2 + count * 2;
  if (pairEnd >= bytes.length) throw new RangeError("host autosave ends inside its pair data");
  const present = bytes[pairEnd];
  if (present !== 0 && present !== 1)
    throw new RangeError("host autosave presentation marker is invalid");
  const presentationEnd = pairEnd + 1 + (present ? HOST_PRESENTATION_BYTES : 0);
  if (bytes.length < presentationEnd + 4)
    throw new RangeError("host autosave presentation length is invalid");
  const result: HostImage = {
    image: bytes.slice(HOST_IMAGE_HEADER, countAt),
    screen: decodeBlock4(bytes.subarray(countAt + 2, pairEnd)),
  };
  if (present) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = pairEnd + 1;
    const seq = view.getFloat64(at, true);
    at += 8;
    if (!Number.isSafeInteger(seq) || seq < 0)
      throw new RangeError("host autosave text sequence is invalid");
    const cells = bytes.slice(at, at + HOST_TEXT_CELLS * 2);
    at += HOST_TEXT_CELLS * 2;
    const written = new Uint32Array(HOST_TEXT_CELLS);
    for (let i = 0; i < written.length; i++) {
      written[i] = u32(bytes, at);
      at += 4;
      if (written[i]! > seq) throw new RangeError("host autosave text stamp exceeds its sequence");
    }
    const draws: HostDraw[] = [];
    for (let i = 0; i < HOST_DRAW_COUNT; i++) {
      const drawSeq = view.getFloat64(at, true);
      const drawnX = view.getInt32(at + 8, true);
      const drawnY = view.getInt32(at + 12, true);
      const drawnWidth = view.getInt32(at + 16, true);
      const drawnHeight = view.getInt32(at + 20, true);
      if (
        !Number.isSafeInteger(drawSeq) ||
        drawSeq < 0 ||
        drawSeq > seq ||
        drawnWidth < 0 ||
        drawnWidth > 255 ||
        drawnHeight < 0 ||
        drawnHeight > 255
      )
        throw new RangeError("host autosave draw snapshot is invalid");
      draws.push({ drawSeq, drawnX, drawnY, drawnWidth, drawnHeight });
      at += 24;
    }
    result.presentation = { cells, written, seq, draws };
  }
  const length = u32(bytes, presentationEnd);
  if (presentationEnd + 4 + length !== bytes.length)
    throw new RangeError("host autosave continuation length is invalid");
  if (length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder().decode(bytes.subarray(presentationEnd + 4, bytes.length)),
      );
    } catch {
      throw new RangeError("host autosave continuation is not valid JSON");
    }
    try {
      result.continuation = validateContinuation(parsed);
    } catch (error) {
      throw new RangeError(`host autosave continuation is invalid: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  return result;
}

/**
 * Save filename stem for a slot: the runtime signature followed by `SG.` and
 * the slot number (spec "Save names and signatures"). An empty signature
 * produces `SG.1`.
 */
export function saveFileName(signature: string, slot: number): string {
  return `${signature}SG.${slot}`;
}

/**
 * Restore-candidate validation: read the 31-byte header, skip the first block
 * length, and compare the first seven state bytes with the active signature
 * (spec "Save names and signatures").
 */
export function saveSignatureMatches(bytes: Uint8Array, signature: Uint8Array): boolean {
  const at = SAVE_DESCRIPTION_BYTES + 2;
  if (bytes.length < at + SIGNATURE_BYTES) return false;
  for (let i = 0; i < SIGNATURE_BYTES; i++) {
    if (bytes[at + i] !== signature[i]) return false;
  }
  return true;
}
