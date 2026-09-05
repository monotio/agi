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

/** Positions and capacities of one profile's block 1. */
export interface Block1Layout {
  /** Exact block-1 length in bytes. */
  readonly size: number;
  readonly middle: Block1MiddleOrder;
  /** Serialized key-map records this profile addresses (39 or 49). */
  readonly keyMapEntries: number;
  /** Inactive key-map records serialized after them; canonical contents zero. */
  readonly keyMapReserved: number;
  /** Addressable 40-byte script string slots (6 or 12). */
  readonly stringSlots: number;
  /** Reserved 40-byte records after them; canonical contents zero. */
  readonly stringReserved: number;
  /** The trailing replay-checkpoint word exists (absent in 2.411/2.440 and the early profiles). */
  readonly checkpoint: boolean;
  /** The trailing menu-interaction gate word and key-release gate byte exist. */
  readonly gates: boolean;
}

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
  // "The source-backed 2.089/2.230/2.272 block-1 partition": 0x03db.
  "2.089": {
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
    size: 0x0404,
    middle: "common",
    keyMapEntries: 49,
    keyMapReserved: 0,
    stringSlots: 12,
    stringReserved: 0,
    checkpoint: true,
    gates: true,
  },
};

/** Derived block-1 field positions for a layout. */
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

function block1Offsets(layout: Block1Layout): Block1Offsets {
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
  const computed = block1Offsets(layout).end;
  if (computed !== layout.size) {
    throw new RangeError(
      `profile ${profile.id} block-1 layout computes ${computed}, expected ${layout.size}`,
    );
  }
  return layout;
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
}

/** Portable contents of one save file. */
export interface SaveState {
  /** Displayed description: the zero-terminated prefix of the 31-byte header. */
  description: string;
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
    strings: Array.from({ length: layout.stringSlots }, () => ""),
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
  };
}

/**
 * Canonical block-1 image: zeros except the two reserved words the spec names
 * (`0x012d` is `00 00`, `0x013d` is `0f 00`). The early partition has neither
 * of those words; its reserved startup count is a mapped field instead.
 */
function canonicalBlock1(layout: Block1Layout): Uint8Array {
  const block = new Uint8Array(layout.size);
  if (layout.middle === "common") {
    putU16(block, OFF_MIDDLE + 2, 0x0000);
    putU16(block, OFF_MIDDLE + 18, 0x000f);
  }
  return block;
}

// ---------- block 1 ----------

function encodeBlock1(state: SaveState, layout: Block1Layout): Uint8Array {
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
  for (let i = 0; i < layout.stringSlots; i++) {
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

function decodeBlock1(block: Uint8Array, layout: Block1Layout, into: SaveState): void {
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
  for (let i = 0; i < layout.stringSlots; i++) {
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

// ---------- envelope ----------

/** Encode a save state as the real file image for the selected profile. */
export function encodeSave(state: SaveState, profile: AgiProfile): Uint8Array {
  const layout = block1Layout(profile);
  if (state.replay.length > state.replayCapacity) {
    throw new RangeError(
      `replay sequence has ${state.replay.length} pairs, capacity is ${state.replayCapacity}`,
    );
  }
  const blocks: Uint8Array[] = [
    encodeBlock1(state, layout),
    encodeBlock2(state.objects),
    profile.saveBlock3Xor ? transformBlock3(state.inventory) : Uint8Array.from(state.inventory),
    encodeBlock4(state.replay, state.replayCapacity),
  ];
  if (profile.saveBlocks === 5) blocks.push(encodeBlock5(state.logicResume));

  let size = SAVE_DESCRIPTION_BYTES;
  for (const block of blocks) size += 2 + block.length;
  const out = new Uint8Array(size);
  writeZString(out, 0, SAVE_DESCRIPTION_BYTES, state.description);
  let at = SAVE_DESCRIPTION_BYTES;
  for (const block of blocks) {
    putU16(out, at, block.length);
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

  const blocks: Uint8Array[] = [];
  let at = SAVE_DESCRIPTION_BYTES;
  for (let i = 0; i < profile.saveBlocks; i++) {
    if (at + 2 > bytes.length)
      throw new RangeError(`save file ends before block ${i + 1}'s length`);
    const length = u16(bytes, at);
    if (at + 2 + length > bytes.length)
      throw new RangeError(`save file ends inside block ${i + 1}`);
    blocks.push(bytes.slice(at + 2, at + 2 + length));
    at += 2 + length;
  }

  decodeBlock1(blocks[0]!, layout, state);
  state.objects = decodeBlock2(blocks[1]!);
  const block3 = blocks[2]!;
  state.inventory = profile.saveBlock3Xor ? transformBlock3(block3) : block3;
  state.replay = decodeBlock4(blocks[3]!);
  if (state.replay.length !== state.replayCapacity) {
    throw new RangeError(
      `block 4 holds ${state.replay.length} pairs but block 1 configures ${state.replayCapacity}`,
    );
  }
  if (state.replayActive > state.replayCapacity) {
    throw new RangeError(
      `active replay count ${state.replayActive} exceeds capacity ${state.replayCapacity}`,
    );
  }
  state.logicResume = profile.saveBlocks === 5 ? decodeBlock5(blocks[4]!) : [];
  return state;
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
