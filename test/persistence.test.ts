import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK3_XOR_KEY,
  OBJECT_RECORD_BYTES,
  SAVE_DESCRIPTION_BYTES,
  block1Layout,
  decodeSave,
  encodeSave,
  newObjectRecord,
  newSaveState,
  resumeOffsetFor,
  saveFileName,
  saveSignatureMatches,
  transformBlock3,
} from "../src/runtime/persistence.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { rngDraw } from "../src/runtime/rng.ts";
import { createContainer, openContainer } from "../src/container/container.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildView } from "../src/view/view.ts";
import { findFixture, fixtureSkip } from "./fixtures.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Authentic save-file envelope, clean-room from the agi-re specification
 * "Rooms, Replay, and Persistence".
 *
 * Every offset and length below is hand-computed from the spec's block tables
 * and restated here as arithmetic, never snapshotted from the encoder:
 *
 *   block 1 (2.936/2.917) = 7 signature + 256 vars + 32 flags + 4 timer
 *                         + 24 middle + 39*4 key map + 10*4 reserved key map
 *                         + 4 padding + 12*40 strings + 12*40 reserved strings
 *                         + 20 text + 2 checkpoint
 *                         = 7+256+32+4+24+156+40+4+480+480+20+2 = 1505 = 0x05e1
 *   block 1 (2.411/2.440) = the same through the text fields, no checkpoint
 *                         = 1503 = 0x05df
 *   block 1 (3.002.149)   = 7+256+32+4+24 + 49*4 + 4 + 480 + 20 + 2 + 2 + 1
 *                         = 7+256+32+4+24+196+4+480+20+5 = 1028 = 0x0404
 *   block 1 (2.089/2.272) = 7+256+32+4+28+156+4+240+240+20 = 987 = 0x03db
 */

const DESC = SAVE_DESCRIPTION_BYTES;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

describe("save block-1 layouts", () => {
  const EXPECTED: readonly { profile: keyof typeof PROFILES; size: number }[] = [
    { profile: "2.089", size: 0x03db },
    { profile: "2.230", size: 0x03db },
    { profile: "2.272", size: 0x03db },
    { profile: "2.411", size: 0x05df },
    { profile: "2.440", size: 0x05df },
    { profile: "2.917", size: 0x05e1 },
    { profile: "2.936", size: 0x05e1 },
    { profile: "3.002.086", size: 0x05e1 },
    { profile: "3.002.102", size: 0x05e4 },
    { profile: "3.002.149", size: 0x0404 },
  ];

  for (const { profile, size } of EXPECTED) {
    test(`${profile} block 1 is 0x${size.toString(16)} bytes`, () => {
      // block1Layout() itself verifies that the field positions sum to the
      // declared size, so this pins the declared size to the spec's table.
      assert.equal(block1Layout(PROFILES[profile]).size, size);
    });
  }

  test("2.936 serializes a 39-entry key map and twelve string slots", () => {
    const layout = block1Layout(PROFILES["2.936"]);
    assert.equal(layout.kind, "pc");
    if (layout.kind !== "pc") return;
    assert.equal(layout.keyMapEntries, 39);
    assert.equal(layout.keyMapReserved, 10);
    assert.equal(layout.stringSlots, 12);
    assert.equal(layout.stringReserved, 12);
    assert.equal(layout.checkpoint, true);
  });

  test("3.002.149's 49-slot key map consumes the ten inactive records", () => {
    const layout = block1Layout(PROFILES["3.002.149"]);
    assert.equal(layout.kind, "pc");
    if (layout.kind !== "pc") return;
    assert.equal(layout.keyMapEntries, 49);
    assert.equal(layout.keyMapReserved, 0);
    // 39*4 + 10*4 == 49*4: the expanded map occupies exactly the same bytes.
    assert.equal(39 * 4 + 10 * 4, 49 * 4);
    assert.equal(layout.stringReserved, 0, "no reserved string bank in this profile");
    assert.equal(layout.gates, true);
  });
});

describe("save envelope byte layout", () => {
  /** A state exercising every mapped field of the common partition. */
  function sampleState() {
    const profile = PROFILES["2.936"];
    const state = newSaveState(profile);
    state.description = "First room";
    state.signature.set([0x4b, 0x51, 0x00, 0, 0, 0, 0]); // "KQ\0"
    state.vars[0] = 7;
    state.vars[255] = 0xfe;
    state.flags[0] = 1;
    state.flags[9] = 1;
    state.flags[255] = 1;
    state.timerTicks = 0x01020304;
    state.horizon = 36;
    state.blockLeft = 10;
    state.blockTop = 20;
    state.blockRight = 130;
    state.blockBottom = 160;
    state.blockEnabled = 1;
    state.directionCoupling = 1;
    state.lastPicture = 3;
    state.replayCapacity = 4;
    state.replayActive = 2;
    state.replayCheckpoint = 1;
    state.keyMap[0] = { rawKey: 0x4800, status: 5 };
    state.keyMap[38] = { rawKey: 0x0009, status: 200 };
    state.strings[0] = "hello";
    state.strings[11] = "twelfth";
    state.textFg = 15;
    state.textBg = 0;
    state.textAttr = 0x0f;
    state.inputEnabled = 1;
    state.inputRow = 23;
    state.promptChar = 0x3e; // ">"
    state.statusEnabled = 1;
    state.statusRow = 0;
    state.displayBaseRow = 1;
    state.displayBottomRow = 22;
    const object = newObjectRecord();
    object.x = 110;
    object.y = 100;
    object.view = 0;
    object.loop = 1;
    object.cel = 2;
    object.width = 13;
    object.height = 32;
    object.stepSize = 1;
    object.state = 0b0000_0011;
    object.motionParams = [1, 2, 3, 4];
    object.tokens = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];
    state.objects = [object, newObjectRecord()];
    // Two three-byte entries then a name pool: "axe\0" at offset 6.
    state.inventory = Uint8Array.from([6, 0, 0xff, 6, 0, 3, 0x61, 0x78, 0x65, 0x00]);
    state.replay = [
      { kind: 2, value: 1 },
      { kind: 4, value: 1 },
    ];
    state.logicResume = [
      { logic: 0, offset: 0 },
      { logic: 1, offset: 0x0040 },
    ];
    return { profile, state };
  }

  test("the framing is a 31-byte description plus five u16le length-prefixed blocks", () => {
    const { profile, state } = sampleState();
    const image = encodeSave(state, profile);

    // Hand-computed block lengths for this state.
    const block1 = 0x05e1;
    const block2 = 2 * OBJECT_RECORD_BYTES; // 2 * 43 = 86
    const block3 = 10;
    const block4 = 4 * 2; // capacity 4
    const block5 = (2 + 2) * 4; // head + 2 cached logics + terminator

    assert.equal(u16(image, DESC), block1);
    assert.equal(u16(image, DESC + 2 + block1), block2);
    assert.equal(u16(image, DESC + 2 + block1 + 2 + block2), block3);
    assert.equal(u16(image, DESC + 2 + block1 + 2 + block2 + 2 + block3), block4);
    assert.equal(u16(image, DESC + 2 + block1 + 2 + block2 + 2 + block3 + 2 + block4), block5);
    assert.equal(
      image.length,
      DESC + (2 + block1) + (2 + block2) + (2 + block3) + (2 + block4) + (2 + block5),
    );

    // The displayed description is the zero-terminated prefix of the header.
    assert.deepEqual(
      Array.from(image.subarray(0, 11)),
      [..."First room"].map((c) => c.charCodeAt(0)).concat(0),
    );
    for (let i = 11; i < DESC; i++) assert.equal(image[i], 0, `header byte ${i} is zero-filled`);
  });

  test("block 1 puts every field at its specified position", () => {
    const { profile, state } = sampleState();
    const image = encodeSave(state, profile);
    const b1 = image.subarray(DESC + 2, DESC + 2 + 0x05e1);

    assert.equal(b1.length, 0x05e1);
    // 0x0000: 7-byte signature area.
    assert.deepEqual(Array.from(b1.subarray(0, 7)), [0x4b, 0x51, 0, 0, 0, 0, 0]);
    // 0x0007: v0..v255.
    assert.equal(b1[0x0007], 7);
    assert.equal(b1[0x0007 + 255], 0xfe);
    // 0x0107: 32 packed flag bytes; f0 and f9 set, f255 set.
    assert.equal(b1[0x0107], 0b0000_0001, "f0 is bit 0 of the first flag byte");
    assert.equal(b1[0x0107 + 1], 0b0000_0010, "f9 is bit 1 of the second flag byte");
    assert.equal(b1[0x0107 + 31], 0b1000_0000, "f255 is bit 7 of the last flag byte");
    // 0x0127: u32le timer tick count.
    assert.deepEqual(Array.from(b1.subarray(0x0127, 0x012b)), [0x04, 0x03, 0x02, 0x01]);
    // 0x012b: horizon; 0x012d: reserved 00 00.
    assert.equal(u16(b1, 0x012b), 36);
    assert.deepEqual(Array.from(b1.subarray(0x012d, 0x012f)), [0x00, 0x00]);
    // 0x012f..0x0136: movement rectangle bounds.
    assert.equal(u16(b1, 0x012f), 10);
    assert.equal(u16(b1, 0x0131), 20);
    assert.equal(u16(b1, 0x0133), 130);
    assert.equal(u16(b1, 0x0135), 160);
    // 0x0137 coupling, 0x0139 last picture, 0x013b rectangle enable.
    assert.equal(u16(b1, 0x0137), 1);
    assert.equal(u16(b1, 0x0139), 3);
    assert.equal(u16(b1, 0x013b), 1);
    // 0x013d: reserved word, canonical bytes 0f 00.
    assert.deepEqual(Array.from(b1.subarray(0x013d, 0x013f)), [0x0f, 0x00]);
    // 0x013f capacity, 0x0141 active count.
    assert.equal(u16(b1, 0x013f), 4);
    assert.equal(u16(b1, 0x0141), 2);
    // 0x0143: 39 key mappings of raw_key:u16le, status:u16le.
    assert.equal(u16(b1, 0x0143), 0x4800);
    assert.equal(u16(b1, 0x0145), 5);
    assert.equal(u16(b1, 0x0143 + 38 * 4), 0x0009);
    assert.equal(u16(b1, 0x0143 + 38 * 4 + 2), 200);
    // 0x01df: ten inactive key-map records, all zero.
    for (let i = 0x01df; i < 0x0207; i++) assert.equal(b1[i], 0, `inactive key-map byte ${i}`);
    // 0x0207: four reserved pre-string bytes, all zero.
    for (let i = 0x0207; i < 0x020b; i++) assert.equal(b1[i], 0, `pre-string padding byte ${i}`);
    // 0x020b: twelve 40-byte string slots.
    assert.equal(String.fromCharCode(...b1.subarray(0x020b, 0x0210)), "hello");
    assert.equal(b1[0x0210], 0, "string slot 0 is zero-terminated");
    assert.equal(
      String.fromCharCode(...b1.subarray(0x020b + 11 * 40, 0x020b + 11 * 40 + 7)),
      "twelfth",
    );
    // 0x03eb: twelve reserved 40-byte records, all zero.
    for (let i = 0x03eb; i < 0x05cb; i++) assert.equal(b1[i], 0, `reserved string byte ${i}`);
    // 0x05cb..0x05de: the text/window fields.
    assert.equal(u16(b1, 0x05cb), 15, "foreground attribute");
    assert.equal(u16(b1, 0x05cd), 0, "background attribute");
    assert.equal(u16(b1, 0x05cf), 0x0f, "packed attribute");
    assert.equal(u16(b1, 0x05d1), 1, "input line enabled");
    assert.equal(u16(b1, 0x05d3), 23, "input row");
    assert.equal(b1[0x05d5], 0x3e, "prompt marker");
    assert.equal(b1[0x05d6], 0, "reserved alignment byte");
    assert.equal(u16(b1, 0x05d7), 1, "status line enabled");
    assert.equal(u16(b1, 0x05d9), 0, "status row");
    assert.equal(u16(b1, 0x05db), 1, "display base row");
    assert.equal(u16(b1, 0x05dd), 22, "display bottom row");
    // 0x05df: replay checkpoint count.
    assert.equal(u16(b1, 0x05df), 1);
  });

  test("block 2 records are 0x2b bytes at n * 0x2b with the specified partition", () => {
    const { profile, state } = sampleState();
    const image = encodeSave(state, profile);
    const at = DESC + 2 + 0x05e1 + 2;
    const b2 = image.subarray(at, at + 2 * OBJECT_RECORD_BYTES);

    assert.equal(OBJECT_RECORD_BYTES, 0x2b);
    assert.equal(b2.length, 86);
    assert.equal(u16(b2, 0x03), 110, "left X");
    assert.equal(u16(b2, 0x05), 100, "baseline Y");
    assert.equal(b2[0x07], 0, "view number");
    assert.equal(u16(b2, 0x08), 0x1111, "view reference token");
    assert.equal(b2[0x0a], 1, "loop number");
    assert.equal(u16(b2, 0x0c), 0x2222, "loop reference token");
    assert.equal(b2[0x0e], 2, "cel number");
    assert.equal(u16(b2, 0x10), 0x3333, "cel reference token");
    assert.equal(u16(b2, 0x12), 0x4444, "previous-cel token");
    assert.equal(u16(b2, 0x14), 0x5555, "render-list token");
    assert.equal(u16(b2, 0x1a), 13, "cel width");
    assert.equal(u16(b2, 0x1c), 32, "cel height");
    assert.equal(b2[0x1e], 1, "step size");
    assert.equal(u16(b2, 0x25), 0b11, "object state flags");
    assert.deepEqual(Array.from(b2.subarray(0x27, 0x2b)), [1, 2, 3, 4], "motion parameters");
    // The second record starts at exactly one record width.
    assert.equal(u16(b2, OBJECT_RECORD_BYTES + 0x03), 0, "second record's left X");
  });

  test("blocks 3, 4 and 5 carry inventory, replay pairs and logic-resume records", () => {
    const { profile, state } = sampleState();
    const image = encodeSave(state, profile);
    let at = DESC + 2 + 0x05e1 + 2 + 2 * OBJECT_RECORD_BYTES + 2;

    // Block 3: three-byte (name_offset:u16le, location:u8) entries then a pool.
    const b3 = image.subarray(at, at + 10);
    assert.deepEqual(Array.from(b3), [6, 0, 0xff, 6, 0, 3, 0x61, 0x78, 0x65, 0x00]);
    assert.equal(b3[2], 0xff, "location 0xff means carried");
    at += 10 + 2;

    // Block 4: capacity 4 two-byte slots; only the first two are active.
    const b4 = image.subarray(at, at + 8);
    assert.deepEqual(Array.from(b4), [2, 1, 4, 1, 0, 0, 0, 0]);
    at += 8 + 2;

    // Block 5: leading (0,0), one record per cached logic, then 0xffff.
    const b5 = image.subarray(at, at + 16);
    assert.deepEqual(Array.from(b5), [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0x40, 0x00, 0xff, 0xff, 0, 0]);
  });

  test("encode -> decode -> encode is byte-identical and preserves reserved bytes", () => {
    const { profile, state } = sampleState();
    const image = encodeSave(state, profile);
    const decoded = decodeSave(image, profile);

    assert.equal(decoded.description, "First room");
    assert.equal(decoded.vars[255], 0xfe);
    assert.equal(decoded.flags[9], 1);
    assert.equal(decoded.flags[8], 0);
    assert.equal(decoded.timerTicks, 0x01020304);
    assert.equal(decoded.replayCapacity, 4);
    assert.equal(decoded.replayActive, 2);
    assert.equal(decoded.replayCheckpoint, 1);
    assert.equal(decoded.strings[11], "twelfth");
    assert.equal(decoded.objects.length, 2);
    assert.deepEqual(decoded.objects[0]!.tokens, [0x1111, 0x2222, 0x3333, 0x4444, 0x5555]);
    assert.deepEqual(Array.from(decoded.inventory), Array.from(state.inventory));
    assert.deepEqual(decoded.replay, [
      { kind: 2, value: 1 },
      { kind: 4, value: 1 },
      { kind: 0, value: 0 },
      { kind: 0, value: 0 },
    ]);
    assert.deepEqual(decoded.logicResume, [
      { logic: 0, offset: 0 },
      { logic: 1, offset: 0x40 },
    ]);

    assert.deepEqual(Array.from(encodeSave(decoded, profile)), Array.from(image));
  });

  test("a reserved byte an existing save supplied is emitted unchanged", () => {
    const { profile, state } = sampleState();
    const image = encodeSave(state, profile);
    // Poke a nonzero value into the reserved string bank at block-1 0x03eb.
    image[DESC + 2 + 0x03eb] = 0xa5;
    const decoded = decodeSave(image, profile);
    const again = encodeSave(decoded, profile);
    assert.equal(again[DESC + 2 + 0x03eb], 0xa5, "reserved byte survived the round trip");
    assert.deepEqual(Array.from(again), Array.from(image));
  });

  test("2.411 writes the same partition without the checkpoint word", () => {
    const profile = PROFILES["2.411"];
    const state = newSaveState(profile);
    state.replayCheckpoint = 9; // no field to hold it in this profile
    state.displayBottomRow = 22;
    const image = encodeSave(state, profile);
    assert.equal(u16(image, DESC), 0x05df);
    const b1 = image.subarray(DESC + 2, DESC + 2 + 0x05df);
    assert.equal(u16(b1, 0x05dd), 22, "display bottom row is the last field");
    assert.equal(decodeSave(image, profile).replayCheckpoint, 0);
  });

  test("2.089 writes a four-block envelope with the early 0x03db partition", () => {
    const profile = PROFILES["2.089"];
    assert.equal(profile.saveBlocks, 4);
    const state = newSaveState(profile);
    state.displayMode = 2;
    state.horizon = 36;
    state.previousNavigation = 5;
    state.navigationDirection = 3;
    state.startupCount = 0x1234;
    state.strings = ["a", "b", "c", "d", "e", "f"];
    const image = encodeSave(state, profile);
    const b1 = image.subarray(DESC + 2, DESC + 2 + 0x03db);
    assert.equal(u16(image, DESC), 0x03db);
    assert.equal(u16(b1, 0x012b), 2, "selected display-mode value");
    assert.equal(u16(b1, 0x012d), 36, "object horizon baseline");
    assert.equal(u16(b1, 0x012f), 5, "previous navigation-event value");
    assert.equal(u16(b1, 0x013d), 3, "direction selected by navigation input");
    assert.equal(u16(b1, 0x0141), 0x1234, "reserved startup count");
    // Six 40-byte slots at 0x01e7 and six reserved records at 0x02d7.
    assert.equal(String.fromCharCode(b1[0x01e7]!), "a");
    assert.equal(String.fromCharCode(b1[0x01e7 + 5 * 40]!), "f");
    for (let i = 0x02d7; i < 0x03c7; i++) assert.equal(b1[i], 0, `reserved string byte ${i}`);
    // Four blocks: description + four length-prefixed blocks, nothing more.
    assert.equal(image.length, DESC + (2 + 0x03db) + 2 + 2 + 2);
    assert.deepEqual(
      Array.from(encodeSave(decodeSave(image, profile), profile)),
      Array.from(image),
    );
  });

  test("3.002.149 appends the menu and key-release gates after the checkpoint", () => {
    const profile = PROFILES["3.002.149"];
    const state = newSaveState(profile);
    state.replayCheckpoint = 7;
    state.menuGate = 1;
    state.releaseGate = 0x2a;
    state.keyMap[48] = { rawKey: 0x1234, status: 99 };
    const image = encodeSave(state, profile);
    const b1 = image.subarray(DESC + 2, DESC + 2 + 0x0404);
    assert.equal(u16(image, DESC), 0x0404);
    assert.equal(u16(b1, 0x0143 + 48 * 4), 0x1234, "the 49th key mapping");
    assert.equal(u16(b1, 0x03ff), 7, "replay checkpoint count");
    assert.equal(u16(b1, 0x0401), 1, "menu interaction gate");
    assert.equal(b1[0x0403], 0x2a, "key-release enqueue gate");
  });
});

describe("v3 block-3 transform", () => {
  test("XOR with the repeating key is its own inverse", () => {
    const runtime = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const stored = transformBlock3(runtime);
    // stored[i] = runtime[i] XOR key[i modulo 11]; key wraps at index 11.
    for (let i = 0; i < runtime.length; i++) {
      assert.equal(stored[i], runtime[i]! ^ BLOCK3_XOR_KEY.charCodeAt(i % 11));
    }
    assert.equal(BLOCK3_XOR_KEY.length, 11);
    assert.deepEqual(Array.from(transformBlock3(stored)), Array.from(runtime));
  });

  test("a v3 profile stores block 3 transformed and decodes it back", () => {
    const profile = PROFILES["3.002.149"];
    assert.equal(profile.saveBlock3Xor, true);
    const state = newSaveState(profile);
    state.inventory = Uint8Array.from([3, 0, 0xff, 0x61, 0x00]);
    const image = encodeSave(state, profile);
    const at = DESC + 2 + 0x0404 + 2 + 0 + 2; // block 2 is empty here
    assert.equal(image[at], 3 ^ "A".charCodeAt(0), "block 3 is stored transformed");
    assert.deepEqual(Array.from(decodeSave(image, profile).inventory), [3, 0, 0xff, 0x61, 0x00]);
  });

  test("a v2 profile stores block 3 directly", () => {
    const profile = PROFILES["2.936"];
    assert.equal(profile.saveBlock3Xor, false);
    const state = newSaveState(profile);
    state.inventory = Uint8Array.from([3, 0, 0xff]);
    const image = encodeSave(state, profile);
    assert.equal(image[DESC + 2 + 0x05e1 + 2 + 0 + 2], 3);
  });
});

describe("amiga save image (docs/fidelity.md, Amiga interpreter profiles)", () => {
  /**
   * Read off the original Save/ files and the save-routine disassembly: the
   * envelope is the same 31-byte header plus five u16le length-prefixed
   * blocks; block 1 is the raw state-hunk image with big-endian fields;
   * block 2 holds N * 0x48 object records; block 3 is the raw inventory
   * region (no XOR); block 4 the replay pair bank; block 5 big-endian
   * {logic, offset} records under a zero head record and a 0xffff
   * terminator.
   *
   *   block 1 (2.082)       = 0x02f4: keymap 40*4 @0x2c, strings 6*40 @0xcc,
   *                         vars @0x1bc, flags @0x2bc, text @0x2dc
   *   block 1 (2.176/2.202) = 0x040a: keymap 39*4 @0x2a, strings 13*40 @0xca,
   *                         vars @0x2d2, flags @0x3d2, text @0x3f2
   *   block 1 (2.31x)       = 0x0414: same offsets, ten trailing bytes
   */

  function u16be(bytes: Uint8Array, at: number): number {
    return (bytes[at]! << 8) | bytes[at + 1]!;
  }

  test("the block-1 layouts carry the verified sizes and field offsets", () => {
    const early = block1Layout(PROFILES["amiga-2.082"]);
    const later = block1Layout(PROFILES["amiga-2.202"]);
    const gen31x = block1Layout(PROFILES["amiga-2.316"]);
    assert.equal(early.kind, "amiga");
    assert.equal(later.kind, "amiga");
    assert.equal(gen31x.kind, "amiga");
    if (early.kind !== "amiga" || later.kind !== "amiga" || gen31x.kind !== "amiga") return;
    assert.equal(early.size, 0x2f4);
    assert.equal(later.size, 0x40a);
    assert.equal(gen31x.size, 0x414);
    // 2.082: forty key-map entries at +0x2c, six strings at +0xcc, the script
    // capacity/active words at +0x28/+0x2a.
    assert.equal(early.keyMap, 0x2c);
    assert.equal(early.keyMapEntries, 40);
    assert.equal(early.strings, 0xcc);
    assert.equal(early.stringSlots, 6);
    assert.equal(early.vars, 0x1bc);
    assert.equal(early.flags, 0x2bc);
    assert.equal(early.text, 0x2dc);
    assert.equal(early.replayCapacity, 0x28);
    assert.equal(early.replayActive, 0x2a);
    // Later builds: 39 entries at +0x2a, thirteen strings at +0xca, capacity
    // and active at +0x26/+0x28.
    for (const layout of [later, gen31x]) {
      assert.equal(layout.keyMap, 0x2a);
      assert.equal(layout.keyMapEntries, 39);
      assert.equal(layout.strings, 0xca);
      assert.equal(layout.stringSlots, 13);
      assert.equal(layout.vars, 0x2d2);
      assert.equal(layout.flags, 0x3d2);
      assert.equal(layout.text, 0x3f2);
      assert.equal(layout.replayCapacity, 0x26);
      assert.equal(layout.replayActive, 0x28);
    }
  });

  /** A state exercising every mapped field of the Amiga state-hunk image. */
  function amigaState(profile = PROFILES["amiga-2.202"]) {
    const state = newSaveState(profile);
    state.description = "door";
    state.signature.set([0x53, 0x51, 0x32]); // "SQ2"
    state.vars[0] = 7;
    state.flags[0] = 1;
    state.flags[255] = 1;
    state.timerTicks = 0x0003f710;
    state.horizon = 36;
    state.blockLeft = 0x52;
    state.blockTop = 0x51;
    state.blockRight = 0x74;
    state.blockBottom = 0x55;
    state.blockEnabled = 1;
    state.directionCoupling = 1;
    state.lastPicture = 0x11;
    state.navigationDirection = 5;
    state.replayCapacity = 4;
    state.replayActive = 2;
    state.keyMap[0] = { rawKey: 0x3b00, status: 2 };
    state.strings[0] = ">";
    state.textFg = 15;
    state.inputEnabled = 1;
    state.inputRow = 22;
    state.promptChar = 0x5f;
    state.statusEnabled = 1;
    state.displayBaseRow = 1;
    state.displayBottomRow = 22;
    state.inventory = Uint8Array.from([6, 0, 0xff, 0, 6, 0, 3, 0, 0x61, 0x78, 0x65, 0]);
    state.replay = [
      { kind: 2, value: 1 },
      { kind: 4, value: 1 },
    ];
    state.logicResume = [
      { logic: 0, offset: 0 },
      { logic: 0x3e, offset: 0 },
    ];
    return { profile, state };
  }

  test("block 1 puts the big-endian fields at the verified positions", () => {
    const { profile, state } = amigaState();
    const image = encodeSave(state, profile);
    const b1 = image.subarray(DESC + 2, DESC + 2 + 0x40a);
    assert.equal(u16(image, DESC), 0x40a, "block-1 length is little-endian in the envelope");
    assert.deepEqual(Array.from(b1.subarray(0, 3)), [0x53, 0x51, 0x32]);
    assert.deepEqual(Array.from(b1.subarray(0x08, 0x0c)), [0x00, 0x03, 0xf7, 0x10], "timer u32be");
    assert.equal(u16be(b1, 0x0e), 36, "horizon u16be");
    assert.deepEqual(
      Array.from(b1.subarray(0x12, 0x1a)),
      [0x00, 0x52, 0x00, 0x51, 0x00, 0x74, 0x00, 0x55],
      "block rectangle u16be",
    );
    // +0x1a is the player/program-control flag (u32be); +0x1c stays
    // reserved; +0x1e is the drawn picture (u16be); the block-enable flag
    // sits at +0x20 on the later builds (u32be).
    assert.deepEqual(Array.from(b1.subarray(0x1a, 0x1e)), [0, 0, 0, 1], "control flag u32be");
    assert.equal(u16be(b1, 0x1e), 0x11, "drawn picture u16be");
    assert.deepEqual(Array.from(b1.subarray(0x20, 0x24)), [0, 0, 0, 1], "block enable u32be");
    assert.equal(u16be(b1, 0x26), 4, "replay capacity u16be");
    assert.equal(u16be(b1, 0x28), 2, "active replay count u16be");
    // Key map @0x2a: {rawKey u16be, status u16be}.
    assert.deepEqual(Array.from(b1.subarray(0x2a, 0x32)), [0x3b, 0x00, 0x00, 0x02, 0, 0, 0, 0]);
    // String slot 0 @0xca is the input buffer.
    assert.equal(b1[0xca], 0x3e);
    assert.equal(b1[0xcb], 0);
    // Vars @0x2d2, packed flags @0x3d2.
    assert.equal(b1[0x2d2], 7);
    assert.equal(b1[0x3d2], 0b0000_0001);
    assert.equal(b1[0x3d2 + 31], 0b1000_0000);
    // Text tail @0x3f2: fg/bg/attr u16be, inputEnabled u32be, inputRow u16be,
    // prompt byte + pad, statusEnabled u32be, status/base/bottom rows u16be.
    assert.deepEqual(
      Array.from(b1.subarray(0x3f2, 0x40a)),
      [
        0x00, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x16, 0x5f, 0x00, 0x00,
        0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x16,
      ],
    );
  });

  test("block 2 records are 0x48 bytes with the big-endian field map", () => {
    const { profile, state } = amigaState();
    const object = newObjectRecord();
    object.stepTime = 3;
    object.stepCount = 2;
    object.x = 0x52;
    object.y = 0x51;
    object.view = 7;
    object.loop = 1;
    object.loopCount = 4;
    object.cel = 2;
    object.celCount = 5;
    object.prevX = 0x40;
    object.prevY = 0x41;
    object.width = 13;
    object.height = 32;
    object.stepSize = 1;
    object.cycleTime = 6;
    object.cycleCount = 4;
    object.direction = 7;
    object.motionMode = 1; // move.obj: Amiga mode 3
    object.cycleMode = 2; // end.of.loop: Amiga mode 1 (the PC order)
    object.priority = 9;
    // active|update|cycling|fixedPri|obsHor|obsBlk|obsObj|loopFixed|waterOn|stationary
    object.state = 1 | 2 | 4 | 8 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100 | 0x2000;
    object.motionParams = [10, 20, 30, 40];
    state.objects = [object];
    const image = encodeSave(state, profile);
    const b2at = DESC + 2 + 0x40a;
    assert.equal(u16(image, b2at), 0x48);
    const r = image.subarray(b2at + 2, b2at + 2 + 0x48);
    assert.equal(u16be(r, 0x00), 3);
    assert.equal(u16be(r, 0x02), 2);
    assert.equal(u16be(r, 0x06), 0x52);
    assert.equal(u16be(r, 0x08), 0x51);
    assert.equal(u16be(r, 0x0a), 7);
    assert.equal(u16be(r, 0x10), 1);
    assert.equal(u16be(r, 0x12), 4);
    assert.equal(u16be(r, 0x18), 2);
    assert.equal(u16be(r, 0x1a), 5);
    assert.equal(u16be(r, 0x28), 0x40);
    assert.equal(u16be(r, 0x2a), 0x41);
    assert.equal(u16be(r, 0x2c), 13);
    assert.equal(u16be(r, 0x2e), 32);
    assert.equal(u16be(r, 0x30), 1);
    assert.equal(u16be(r, 0x32), 6);
    assert.equal(u16be(r, 0x34), 4);
    assert.equal(u16be(r, 0x36), 7);
    assert.equal(u16be(r, 0x38), 3, "move.obj is Amiga motion mode 3");
    assert.equal(u16be(r, 0x3a), 1, "end.of.loop is Amiga cycle mode 1");
    assert.equal(u16be(r, 0x3c), 9);
    // Native flag word, bit by bit from the handlers (docs/fidelity.md):
    // drawn 0x0001 (active) + fixed priority 0x0004 + update pass 0x0010
    // (not earlierPartition) + cycling 0x0020 + animated 0x0040 (portable
    // update) + on.water 0x0100 + fix.loop 0x2000 + stationary 0x4000; the
    // observed horizon/blocks/objects leave 0x0008/0x0002/0x0200 clear.
    // 0x0001 + 0x0004 + 0x0010 + 0x0020 + 0x0040 + 0x0100 + 0x2000 + 0x4000
    // = 0x6175.
    assert.equal(u16be(r, 0x3e), 0x6175);
    assert.deepEqual(
      Array.from(r.subarray(0x40, 0x48)),
      [0x00, 0x0a, 0x00, 0x14, 0x00, 0x1e, 0x00, 0x28],
      "four u16be motion parameters",
    );
  });

  test("the flag word and mode numbering round-trip through the portable record", () => {
    const { profile, state } = amigaState();
    const object = newObjectRecord();
    object.motionMode = 3; // wander: Amiga mode 1
    object.cycleMode = 3; // reverse.loop: Amiga mode 2
    // Ignore horizon + ignore objects: the inverted Amiga bits set.
    object.state = 1 | 4 | 0x20; // active|cycling|obsBlocks — horizon/objs NOT observed
    state.objects = [object];
    const decoded = decodeSave(encodeSave(state, profile), profile);
    const out = decoded.objects[0]!;
    assert.equal(out.motionMode, 3);
    assert.equal(out.cycleMode, 3);
    // The Amiga word carries 0x0008 (ignore horizon) and 0x0200 (ignore
    // objects): both map back to "not observing".
    assert.equal(out.state & 0x10, 0, "observeHorizon bit cleared");
    assert.equal(out.state & 0x40, 0, "observeObjects bit cleared");
    assert.equal(out.state & 1, 1, "active");
    assert.equal(out.state & 4, 4, "cycling");
  });

  test("each native flag bit decodes to the portable state its handler maintains", () => {
    // One native bit per record, decoded against the portable packing
    // (screenObject.ts): active 0x1, update (animated) 0x2, cycling 0x4,
    // fixedPriority 0x8, observeHorizon 0x10, observeBlocks 0x20,
    // observeObjects 0x40, loopFixed 0x80, water on 0x100 / off 0x200,
    // earlierPartition 0x400, newlyPositioned 0x800, cycleDelay 0x1000,
    // stationary 0x2000. A zero native word observes everything and, with the
    // update-pass bit 0x0010 clear, selects the earlier partition: 0x0470.
    const cases: [number, number][] = [
      [0x0000, 0x0470],
      [0x0001, 0x0471], // drawn (draw sets, erase clears)
      [0x0002, 0x0450], // ignore.blocks
      [0x0004, 0x0478], // set.priority
      [0x0008, 0x0460], // ignore.horizon
      [0x0010, 0x0070], // update pass (start.update sets, stop.update clears)
      [0x0020, 0x0474], // start.cycling
      [0x0040, 0x0472], // animate.obj (unanimate.all clears)
      [0x0100, 0x0570], // object.on.water
      [0x0200, 0x0430], // ignore.objs
      [0x0400, 0x0c70], // reposition
      [0x0800, 0x0670], // object.on.land
      [0x0900, 0x0770], // object.on.water + object.on.land
      [0x1000, 0x1470], // end.of.loop/reverse.loop delay (draw clears)
      [0x2000, 0x04f0], // fix.loop
      [0x4000, 0x2470], // x,y equal the saved pair on the due pass
    ];
    const profile = PROFILES["amiga-2.202"];
    const block = new Uint8Array(cases.length * 0x48);
    cases.forEach(([native], i) => {
      block[i * 0x48 + 0x3e] = native >> 8;
      block[i * 0x48 + 0x3f] = native & 0xff;
    });
    const { state } = amigaState();
    const image = encodeSave(state, profile);
    const b2at = DESC + 2 + 0x40a;
    const withObjects = new Uint8Array(image.length + block.length);
    withObjects.set(image.subarray(0, b2at), 0);
    withObjects[b2at] = block.length & 0xff;
    withObjects[b2at + 1] = block.length >> 8;
    withObjects.set(block, b2at + 2);
    withObjects.set(image.subarray(b2at + 2), b2at + 2 + block.length);
    const decoded = decodeSave(withObjects, profile);
    assert.deepEqual(
      decoded.objects.map((o) => o.state.toString(16)),
      cases.map(([, portable]) => portable.toString(16)),
    );
    // Without the raw image, the portable word alone reproduces each native word.
    for (const o of decoded.objects) delete o.raw;
    const again = encodeSave(decoded, profile);
    cases.forEach(([native], i) =>
      assert.equal(
        u16be(again, b2at + 2 + i * 0x48 + 0x3e),
        native,
        `native ${native.toString(16)}`,
      ),
    );
  });

  test("an unknown native mode word runs as mode 0 and re-encodes unchanged", () => {
    const profile = PROFILES["amiga-2.202"];
    const { state } = amigaState();
    const record = newObjectRecord();
    record.raw = new Uint8Array(0x48);
    record.raw[0x39] = 9; // motion mode 9: no handler writes it
    record.raw[0x3b] = 7; // cycle mode 7: no handler writes it
    state.objects = [record];
    const image = encodeSave(state, profile);
    const b2at = DESC + 2 + 0x40a;
    assert.equal(u16be(image, b2at + 2 + 0x38), 9);
    assert.equal(u16be(image, b2at + 2 + 0x3a), 7);
    const decoded = decodeSave(image, profile);
    assert.equal(decoded.objects[0]!.motionMode, 0);
    assert.equal(decoded.objects[0]!.cycleMode, 0);
    assert.deepEqual(Array.from(encodeSave(decoded, profile)), Array.from(image));
    // A mode the engine changes is written through the table.
    decoded.objects[0]!.motionMode = 3; // wander: native 1
    assert.equal(u16be(encodeSave(decoded, profile), b2at + 2 + 0x38), 1);
  });

  test("an engine-written block 1 starts from the state hunk's load image", () => {
    // The 2.176+ hunk image is zero except 0x000f at +0x24 and the script
    // capacity 50 (0x32) at +0x26 (docs/fidelity.md "Save image").
    const profile = PROFILES["amiga-2.202"];
    const state = newSaveState(profile);
    state.replayCapacity = 50;
    const image = encodeSave(state, profile);
    assert.equal(u16be(image, DESC + 2 + 0x24), 0x000f);
    assert.equal(u16be(image, DESC + 2 + 0x26), 0x0032);
    // 2.082 sits two bytes later: 0x000f at +0x26, the capacity at +0x28.
    const sierra = PROFILES["amiga-2.082"];
    const early = newSaveState(sierra);
    early.replayCapacity = 50;
    const earlyImage = encodeSave(early, sierra);
    assert.equal(u16be(earlyImage, DESC + 2 + 0x26), 0x000f);
    assert.equal(u16be(earlyImage, DESC + 2 + 0x28), 0x0032);
  });

  test("a decoded record preserves its unmapped bytes on re-encode", () => {
    const { profile, state } = amigaState();
    const image = encodeSave(state, profile);
    const first = decodeSave(image, profile);
    // Point an unmapped runtime field (the view-data pointer at +0x0c) at a
    // plausible value and confirm it survives the next encode.
    const record = first.objects;
    assert.equal(record.length, 0, "no objects in the first state");
    // Round-trip with a record whose raw bytes carried a pointer field.
    const b2at = DESC + 2 + 0x40a;
    const image2 = Uint8Array.from(image);
    image2[b2at] = 0x48;
    image2[b2at + 1] = 0;
    const grown = new Uint8Array(image2.length + 0x48);
    // Rebuild: header + block1 + len 0x48 + record + rest.
    let at = 0;
    grown.set(image2.subarray(0, b2at + 2), at);
    at += b2at + 2;
    const rec = new Uint8Array(0x48);
    rec.set([0xde, 0xad, 0xbe, 0xef], 0x0c); // pointer field, unmapped
    rec.set([0x00, 0x40], 0x3e); // animated bit only
    grown.set(rec, at);
    at += 0x48;
    grown.set(image2.subarray(b2at + 2), at);
    const decoded = decodeSave(grown, profile);
    assert.equal(decoded.objects.length, 1);
    const again = encodeSave(decoded, profile);
    const againB2 = again.subarray(b2at + 2, b2at + 2 + 0x48);
    assert.deepEqual(Array.from(againB2.subarray(0x0c, 0x10)), [0xde, 0xad, 0xbe, 0xef]);
  });

  test("block 5 is big-endian records under a zero head, ended by 0xffff", () => {
    const { profile, state } = amigaState();
    const image = encodeSave(state, profile);
    const b5at =
      DESC + 2 + 0x40a + 2 + 0 + 2 + state.inventory.length + 2 + state.replayCapacity * 2;
    assert.equal(u16(image, b5at), (state.logicResume.length + 2) * 4);
    const b5 = image.subarray(b5at + 2, b5at + 2 + (state.logicResume.length + 2) * 4);
    assert.deepEqual(
      Array.from(b5),
      [
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3e, 0x00, 0x00, 0xff, 0xff, 0x00,
        0x00,
      ],
    );
    const decoded = decodeSave(image, profile);
    assert.deepEqual(decoded.logicResume, [
      { logic: 0, offset: 0 },
      { logic: 0x3e, offset: 0 },
    ]);
  });

  test("block 3 is the raw inventory payload without the v3 transform", () => {
    const { profile, state } = amigaState(PROFILES["amiga-2.316"]);
    const image = encodeSave(state, profile);
    const b3at = DESC + 2 + 0x414 + 2 + 0;
    assert.deepEqual(
      Array.from(image.subarray(b3at + 2, b3at + 2 + state.inventory.length)),
      Array.from(state.inventory),
      "identical bytes, no XOR",
    );
  });
});

describe("apple iigs save image (docs/fidelity.md, Apple IIgs interpreter)", () => {
  /**
   * The savegameseg writer emits the 31-byte description then six blocks,
   * each prefixed by a big-endian u16 byte count produced by its
   * divide-and-write-bytes helper:
   *
   *   block 0 = 0x38 bytes — the bank-0 globals image ($010d..$0144):
   *             horizon @+0x04, block rectangle @+0x08, control flag @+0x10,
   *             block enable @+0x14, replay capacity u16le @+0x1a
   *   block 1 = 0x3d0 main state: 8 opaque head bytes, key map 40*4 u16le
   *             @0x08, strings 13*40 @0xa8, vars @0x2b0, packed flags @0x3b0
   *   block 2 = N * 0x48 object records, little-endian fields
   *   block 3 = inventory payload
   *   block 4 = replay pairs, capacity * 2 bytes
   *   block 5 = logic-resume records
   */
  function u16be(bytes: Uint8Array, at: number): number {
    return (bytes[at]! << 8) | bytes[at + 1]!;
  }

  test("the iigs layout carries the verified block sizes and offsets", () => {
    const layout = block1Layout(PROFILES["iigs-1.014"]);
    assert.equal(layout.kind, "iigs");
    if (layout.kind !== "iigs") return;
    assert.equal(layout.lead, 0x38);
    assert.equal(layout.size, 0x3d0);
    assert.equal(layout.keyMap, 0x08);
    assert.equal(layout.keyMapEntries, 40);
    assert.equal(layout.strings, 0xa8);
    assert.equal(layout.stringSlots, 13);
    assert.equal(layout.vars, 0x2b0);
    assert.equal(layout.flags, 0x3b0);
  });

  test("the envelope is a 31-byte header plus six u16be-length blocks", () => {
    const profile = PROFILES["iigs-1.014"];
    const state = newSaveState(profile);
    state.description = "cell";
    state.vars[0] = 9;
    state.flags[0] = 1;
    state.keyMap[0] = { rawKey: 0x3b00, status: 2 };
    state.strings[0] = ">";
    state.replayCapacity = 3;
    state.horizon = 36;
    state.blockLeft = 0x52;
    state.blockTop = 0x51;
    state.blockRight = 0x74;
    state.blockBottom = 0x55;
    state.blockEnabled = 1;
    state.directionCoupling = 1;
    state.signature.set([0x53, 0x51, 0x32]); // "SQ2"
    state.timerTicks = 0x00012345;
    state.lastPicture = 9;
    state.replayActive = 2;
    state.replayCheckpoint = 1;
    state.textFg = 14;
    state.textBg = 1;
    state.inputEnabled = 1;
    state.promptChar = 0x5f;
    state.statusEnabled = 1;
    state.displayBaseRow = 1;
    state.displayBottomRow = 22;
    state.inputRow = 23;
    state.statusRow = 0;
    state.replay = [
      { kind: 2, value: 1 },
      { kind: 4, value: 2 },
      { kind: 3, value: 5 },
    ];
    state.logicResume = [{ logic: 1, offset: 0x10 }];
    const image = encodeSave(state, profile);
    let at = DESC;
    const lens: number[] = [];
    for (let i = 0; i < 6; i++) {
      const n = u16be(image, at);
      lens.push(n);
      at += 2 + n;
    }
    assert.equal(at, image.length, "six blocks consume the file");
    assert.deepEqual(lens, [0x38, 0x3d0, 0, state.inventory.length, 6, (1 + 2) * 4]);
    // Lead block (bank-0 globals $010d..$0144): horizon u16le @+0x04, the
    // block rectangle @+0x08..+0x0e, control flag @+0x10, block enable @+0x14
    // and the replay capacity @+0x1a.
    const lead = image.subarray(DESC + 2, DESC + 2 + 0x38);
    assert.equal(u16(lead, 0x04), 36, "horizon u16le");
    assert.deepEqual(
      Array.from(lead.subarray(0x08, 0x10)),
      [0x52, 0, 0x51, 0, 0x74, 0, 0x55, 0],
      "block rectangle u16le",
    );
    assert.equal(u16(lead, 0x10), 1, "player/program-control flag");
    assert.equal(u16(lead, 0x14), 1, "block enable");
    assert.equal(u16(lead, 0x1a), 3);
    // The ~globals words handlers write: timer u32 $010d, picture $011f,
    // active count $0129, checkpoint $0143, text colors $012b/$012d, input
    // enable $0131, cursor byte $0135, status enable $0137, rows $013b..$0141.
    assert.deepEqual(Array.from(lead.subarray(0x00, 0x04)), [0x45, 0x23, 0x01, 0x00], "timer");
    assert.equal(u16(lead, 0x12), 9, "last picture");
    assert.equal(u16(lead, 0x18), 0x000f, "load-image word ahead of the capacity");
    assert.equal(u16(lead, 0x1c), 2, "replay active");
    assert.equal(u16(lead, 0x36), 1, "replay checkpoint");
    assert.deepEqual([u16(lead, 0x1e), u16(lead, 0x20)], [14, 1], "text fg/bg");
    assert.equal(u16(lead, 0x24), 1, "input enable");
    assert.equal(lead[0x28], 0x5f, "cursor character");
    assert.equal(u16(lead, 0x2a), 1, "status enable");
    assert.deepEqual(
      [u16(lead, 0x2e), u16(lead, 0x30), u16(lead, 0x32), u16(lead, 0x34)],
      [1, 22, 23, 0],
      "configure.screen rows",
    );
    // State block: signature @0x00, key map @0x08, strings @0xa8, vars
    // @0x2b0, flags @0x3b0.
    const b1 = image.subarray(DESC + 2 + 0x38 + 2, DESC + 2 + 0x38 + 2 + 0x3d0);
    assert.deepEqual(Array.from(b1.subarray(0x00, 0x04)), [0x53, 0x51, 0x32, 0x00], "SQ2");
    assert.deepEqual(Array.from(b1.subarray(0x08, 0x10)), [0x00, 0x3b, 0x02, 0x00, 0, 0, 0, 0]);
    assert.equal(b1[0xa8], 0x3e);
    assert.equal(b1[0x2b0], 9);
    assert.equal(b1[0x3b0], 1);
    // Decode returns the same portable fields.
    const decoded = decodeSave(image, profile);
    assert.equal(decoded.vars[0], 9);
    assert.equal(decoded.flags[0], 1);
    assert.equal(decoded.keyMap[0]!.rawKey, 0x3b00);
    assert.equal(decoded.keyMap[0]!.status, 2);
    assert.equal(decoded.strings[0], ">");
    assert.equal(decoded.replayCapacity, 3);
    assert.equal(decoded.horizon, 36);
    assert.equal(decoded.blockLeft, 0x52);
    assert.equal(decoded.blockBottom, 0x55);
    assert.equal(decoded.blockEnabled, 1);
    assert.equal(decoded.directionCoupling, 1);
    assert.equal(decoded.timerTicks, 0x00012345);
    assert.equal(decoded.lastPicture, 9);
    assert.equal(decoded.replayActive, 2);
    assert.equal(decoded.replayCheckpoint, 1);
    assert.equal(decoded.promptChar, 0x5f);
    assert.equal(decoded.inputRow, 23);
    assert.deepEqual(decoded.logicResume, [{ logic: 1, offset: 0x10 }]);
  });

  test("iigs object records use the shared 0x48 map with little-endian words", () => {
    const profile = PROFILES["iigs-1.014"];
    const state = newSaveState(profile);
    const object = newObjectRecord();
    object.x = 0x52;
    object.y = 0x51;
    object.view = 7;
    object.direction = 3;
    object.motionMode = 1; // move.obj: IIgs mode 3 (verified, same as Amiga)
    object.cycleMode = 1; // reverse.cycle: native mode 3 (the PC order)
    // active|update|observeHorizon|observeObjects — the ignore bits stay clear.
    object.state = 1 | 2 | 0x10 | 0x40;
    state.objects = [object];
    const image = encodeSave(state, profile);
    const b2at = DESC + 2 + 0x38 + 2 + 0x3d0;
    assert.equal(u16be(image, b2at), 0x48);
    const r = image.subarray(b2at + 2, b2at + 2 + 0x48);
    assert.equal(u16(r, 0x06), 0x52, "x u16le");
    assert.equal(u16(r, 0x08), 0x51, "y u16le");
    assert.equal(u16(r, 0x0a), 7, "view u16le");
    assert.equal(u16(r, 0x36), 3, "direction u16le");
    assert.equal(u16(r, 0x38), 3, "move.obj is motion mode 3");
    assert.equal(u16(r, 0x3a), 3, "reverse.cycle is IIgs cycle mode 3 (PC order)");
    // drawn 0x01 + ignore.blocks 0x02 + update pass 0x10 (not stopped) +
    // animated 0x40 (portable update) = 0x53.
    assert.equal(u16(r, 0x3e), 0x53);
    const decoded = decodeSave(image, profile);
    assert.equal(decoded.objects[0]!.x, 0x52);
    assert.equal(decoded.objects[0]!.motionMode, 1);
    assert.equal(decoded.objects[0]!.cycleMode, 1);
  });

  test("iigs cycle modes use the PC order and ignore.blocks maps to 0x0002", () => {
    const profile = PROFILES["iigs-1.014"];
    const state = newSaveState(profile);
    // Portable {forward, reverse.cycle, end.of.loop, reverse.loop} -> the
    // verified native values {0, 3, 1, 2}, shared with the Amiga builds.
    state.objects = [0, 1, 2, 3].map((m) => {
      const o = newObjectRecord();
      o.cycleMode = m;
      o.state = 1 | 2 | 0x10 | 0x40;
      return o;
    });
    const blocking = newObjectRecord();
    blocking.cycleMode = 0;
    // active|update|observeHorizon|observeObjects — observeBlocks cleared.
    blocking.state = 1 | 2 | 0x10 | 0x40;
    state.objects.push(blocking);
    state.objects[4]!.state &= ~0x20;
    const image = encodeSave(state, profile);
    const b2at = DESC + 2 + 0x38 + 2 + 0x3d0;
    const modes = [0, 3, 1, 2];
    for (let i = 0; i < 4; i++) {
      assert.equal(
        u16(image, b2at + 2 + i * 0x48 + 0x3a),
        modes[i],
        `portable cycle ${i} encodes as IIgs mode ${modes[i]}`,
      );
    }
    // Record 4 cleared observeBlocks: native flag word carries 0x0002.
    assert.equal(u16(image, b2at + 2 + 4 * 0x48 + 0x3e) & 0x0002, 0x0002);
    const decoded = decodeSave(image, profile);
    assert.deepEqual(
      decoded.objects.map((o) => o.cycleMode),
      [0, 1, 2, 3, 0],
    );
    assert.equal(decoded.objects[4]!.state & 0x20, 0, "ignore.blocks decoded");
  });
});

describe("save names, signatures and logic resume", () => {
  test("the filename stem is the signature followed by SG. and the slot", () => {
    assert.equal(saveFileName("SQ2", 1), "SQ2SG.1");
    assert.equal(saveFileName("GR", 1), "GRSG.1");
    assert.equal(saveFileName("", 1), "SG.1");
  });

  test("candidate validation skips the first block length and compares seven bytes", () => {
    const profile = PROFILES["2.936"];
    const state = newSaveState(profile);
    state.signature.set([0x4b, 0x51, 0x31, 0, 0, 0, 0]);
    const image = encodeSave(state, profile);
    assert.ok(saveSignatureMatches(image, Uint8Array.from([0x4b, 0x51, 0x31, 0, 0, 0, 0])));
    assert.ok(!saveSignatureMatches(image, Uint8Array.from([0x4b, 0x51, 0x32, 0, 0, 0, 0])));
    // The comparison starts after the header and the first block's length word.
    assert.equal(image[DESC + 2], 0x4b);
  });

  test("the first matching logic-resume record wins and a miss means entry", () => {
    const records = [
      { logic: 0, offset: 0 },
      { logic: 5, offset: 0x30 },
      { logic: 5, offset: 0x99 },
    ];
    assert.equal(
      resumeOffsetFor(records, 5),
      0x30,
      "duplicates: only the first match is effective",
    );
    assert.equal(resumeOffsetFor(records, 0), 0, "the leading head record takes precedence");
    assert.equal(resumeOffsetFor(records, 7), 0, "no record leaves the logic at its entry");
  });
});

describe("malformed saves are rejected", () => {
  const profile = PROFILES["2.936"];

  test("a truncated file is refused rather than silently short-read", () => {
    const image = encodeSave(newSaveState(profile), profile);
    assert.throws(() => decodeSave(image.subarray(0, 20), profile), /shorter than its description/);
    assert.throws(() => decodeSave(image.subarray(0, DESC + 40), profile), /ends inside block 1/);
  });

  test("a block 1 of the wrong length is refused", () => {
    const state = newSaveState(profile);
    const image = encodeSave(state, profile);
    image[DESC] = 0x00; // claim a 0x0500-byte block 1
    image[DESC + 1] = 0x05;
    assert.throws(() => decodeSave(image, profile), /block 1 is 1280 bytes, expected 1505/);
  });

  test("a capacity that disagrees with the block-4 length is refused", () => {
    const state = newSaveState(profile);
    state.replayCapacity = 4;
    state.replay = [{ kind: 2, value: 1 }];
    const image = encodeSave(state, profile);
    // Block 1's capacity word sits at block-1 offset 0x013f.
    image[DESC + 2 + 0x013f] = 5;
    assert.throws(
      () => decodeSave(image, profile),
      /block 4 holds 4 pairs but block 1 configures 5/,
    );
  });

  test("more recorded pairs than the configured capacity is refused on encode", () => {
    const state = newSaveState(profile);
    state.replayCapacity = 1;
    state.replay = [
      { kind: 2, value: 1 },
      { kind: 4, value: 1 },
    ];
    assert.throws(() => encodeSave(state, profile), /capacity is 1/);
  });
});

// ---------- engine-level replay and restore semantics ----------

class RecordingHost implements EngineHost {
  prints: string[] = [];
  inputQueue: (string | null)[] = [];
  saved: Uint8Array | null = null;
  engine?: Engine;

  print(text: string): void {
    this.prints.push(text);
    this.engine?.ackPrint();
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return this.inputQueue.shift() ?? null;
  }
  takeKeys(): number[] {
    return [];
  }
  saveGame(bytes: Uint8Array): void {
    this.saved = bytes;
  }
  restoreGame(): Uint8Array | null {
    return this.saved;
  }
}

const DICT = new Map<string, number>([
  ["save", 200],
  ["restore", 201],
  ["mutate", 202],
  ["blank", 203],
]);

/** 1 loop, 1 cel: a 3x1 row of colour 5 with transparent colour 0. */
const VIEW_CEL = new Uint8Array([
  0,
  0,
  1,
  0,
  0,
  7,
  0, // header: 1 loop, loop table at offset 7
  1,
  3,
  0, // loop: 1 cel at loop + 3
  3,
  1,
  0,
  0x53,
  0, // cel: 3 wide, 1 high, transparent 0, run of 3 colour-5 pixels
]);

/** Visual colour 1, one absolute line box from (10,10) to (60,40). */
const PICTURE = new Uint8Array([
  0xf0, 0x01, 0xf6, 10, 10, 60, 10, 60, 40, 10, 40, 10, 10, 0xf1, 0xff,
]);

/** A visibly different picture: colour 6, a box from (80,80) to (140,140). */
const OTHER_PICTURE = new Uint8Array([
  0xf0, 0x06, 0xf6, 80, 80, 140, 80, 140, 140, 80, 140, 80, 80, 0xf1, 0xff,
]);

describe("engine replay recording", () => {
  function boot(source: string) {
    const container = createContainer();
    container.putResource("logic", 0, assembleLogic(source, { dictionary: DICT }).payload);
    container.putResource("picture", 1, PICTURE);
    container.putResource("picture", 2, PICTURE);
    container.putResource("view", 3, VIEW_CEL);
    container.putResource("view", 4, VIEW_CEL);
    container.putResource("view", 5, VIEW_CEL);
    const host = new RecordingHost();
    const engine = new Engine(container, host, DICT);
    host.engine = engine;
    return { engine, host };
  }

  /** The engine's live replay sequence, as (kind, value) tuples. */
  function pairs(engine: Engine): [number, number][] {
    const seq = (engine as unknown as { replay: { kind: number; value: number }[] }).replay;
    return seq.map((p) => [p.kind, p.value]);
  }

  test("load, draw, overlay, discard and add.to.pic append their specified kinds", () => {
    const { engine } = boot(`
      if (!isset(f200)) {
        set(f200);
        script.size(20);
        assignn(v50, 1);
        load.pic(v50);
        draw.pic(v50);
        load.view(3);
        assignn(v51, 2);
        load.pic(v51);
        overlay.pic(v51);
        add.to.pic(3, 0, 0, 20, 30, 2, 1);
        discard.view(3);
        discard.pic(v50);
      }
      return;
    `);
    engine.tick();
    assert.deepEqual(pairs(engine), [
      [2, 1], // load.pic 1
      [4, 1], // draw.pic 1
      [1, 3], // load.view 3
      [2, 2], // load.pic 2
      [8, 2], // overlay.pic 2
      [5, 0], // add.to.pic packet opener
      [3, 0], // (view, loop)
      [0, 20], // (cel, left_x)
      [30, 0x21], // (baseline_y, priority 2 << 4 | margin 1)
      [7, 3], // discard.view 3
      [6, 1], // discard.pic 1
    ]);
  });

  test("recording stops while f7 is set", () => {
    const { engine } = boot(`
      if (!isset(f200)) {
        set(f200);
        script.size(20);
        assignn(v50, 1);
        load.pic(v50);
        set(f7);
        draw.pic(v50);
        reset(f7);
        load.view(3);
      }
      return;
    `);
    engine.tick();
    assert.deepEqual(pairs(engine), [
      [2, 1],
      [1, 3],
    ]);
  });

  test("push.script saves the active count and pop.script rolls back to it", () => {
    const { engine } = boot(`
      if (!isset(f200)) {
        set(f200);
        script.size(20);
        assignn(v50, 1);
        load.pic(v50);
        push.script();
        load.view(3);
        load.view(4);
        pop.script();
        load.view(5);
      }
      return;
    `);
    engine.tick();
    // The checkpoint was taken after one pair; the two views recorded after it
    // fall outside the active sequence, and the next append lands at its end.
    assert.deepEqual(pairs(engine), [
      [2, 1],
      [1, 5],
    ]);
  });

  test("exceeding a configured capacity is an engine error", () => {
    const { engine } = boot(`
      if (!isset(f200)) {
        set(f200);
        script.size(2);
        assignn(v50, 1);
        load.pic(v50);
        draw.pic(v50);
        load.view(3);
      }
      return;
    `);
    assert.throws(() => engine.tick(), /exceeded its 2-pair capacity/);
  });
});

describe("ordered resource discard", () => {
  test("discarding a view also discards every view retained later", () => {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `
        if (!isset(f200)) {
          set(f200);
          script.size(20);
          load.view(3);
          load.view(4);
          load.view(5);
          discard.view(4);
        }
        return;
      `,
        { dictionary: DICT },
      ).payload,
    );
    container.putResource("view", 3, VIEW_CEL);
    container.putResource("view", 4, VIEW_CEL);
    container.putResource("view", 5, VIEW_CEL);
    const host = new RecordingHost();
    const engine = new Engine(container, host, DICT);
    host.engine = engine;
    engine.tick();
    // Views 3, 4 and 5 were first loaded in that order; discarding 4 leaves
    // only 3 retained (spec "Resource lifecycle").
    const views = (engine as unknown as { views: Map<number, unknown> }).views;
    assert.deepEqual([...views.keys()], [3]);
  });
});

describe("restore replays instead of re-entering the room", () => {
  test("the picture, ego position and item locations come back after a mutation", () => {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `
        #message 1 "init"
        if (!isset(f200)) {
          set(f200);
          script.size(30);
          assignn(v50, 1);
          load.pic(v50);
          draw.pic(v50);
          assignn(v51, 2);
          load.pic(v51);
          overlay.pic(v51);
          load.view(3);
          add.to.pic(3, 0, 0, 100, 120, 2, 1);
          animate.obj(o0);
          set.view(o0, 3);
          position(o0, 40, 60);
          draw(o0);
          accept.input();
          print(1);
        }
        if (said("save")) { save.game(); }
        if (said("mutate")) {
          assignn(v100, 99);
          erase(o0);
          assignn(v51, 2);
          load.pic(v51);
          draw.pic(v51);
        }
        if (said("blank")) { assignn(v50, 1); load.pic(v50); draw.pic(v50); }
        if (said("restore")) { restore.game(); }
        return;
      `,
        { dictionary: DICT },
      ).payload,
    );
    container.putResource("picture", 1, PICTURE);
    container.putResource("picture", 2, OTHER_PICTURE);
    container.putResource("view", 3, VIEW_CEL);
    const host = new RecordingHost();
    const engine = new Engine(container, host, DICT);
    host.engine = engine;

    engine.tick();
    assert.equal(host.prints.length, 1);
    const beforeVisual = Uint8Array.from(engine.surface.visual);
    const beforePriority = Uint8Array.from(engine.surface.priority);

    host.inputQueue.push("save");
    engine.tick();
    assert.ok(host.saved, "save.game handed a file image to the host");
    // The image really is the envelope, not a JSON blob.
    assert.equal(u16(host.saved!, DESC), 0x05e1, "block 1 is the 2.936 partition");

    host.inputQueue.push("mutate");
    engine.tick();
    assert.equal(engine.vars[100], 99);
    assert.notDeepEqual(
      Array.from(engine.surface.visual),
      Array.from(beforeVisual),
      "the mutation really changed the screen",
    );

    host.inputQueue.push("restore");
    engine.tick();
    assert.equal(engine.vars[100], 0, "the saved variables replaced the mutation");
    assert.equal(host.prints.length, 1, "the room's init block did not run again");
    assert.deepEqual(Array.from(engine.surface.visual), Array.from(beforeVisual));
    assert.deepEqual(Array.from(engine.surface.priority), Array.from(beforePriority));
    const ego = engine.readObjects().find((o) => o.num === 0);
    assert.deepEqual({ x: ego?.x, y: ego?.y, view: ego?.view }, { x: 40, y: 60, view: 3 });
  });

  test("restore rebinds object cel dimensions from the loaded view resource", () => {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `
        if (!isset(f200)) {
          set(f200);
          script.size(30);
          load.view(3);
          animate.obj(o0);
          set.view(o0, 3);
          position(o0, 10, 20);
          draw(o0);
          accept.input();
        }
        if (said("save")) { save.game(); }
        if (said("restore")) { restore.game(); }
        return;
      `,
        { dictionary: DICT },
      ).payload,
    );
    container.putResource("view", 3, VIEW_CEL);
    const host = new RecordingHost();
    const engine = new Engine(container, host, DICT);
    host.engine = engine;
    engine.tick();
    host.inputQueue.push("save");
    engine.tick();
    host.inputQueue.push("restore");
    engine.tick();
    const ego = engine.readObjects().find((o) => o.num === 0);
    // VIEW_CEL's only cel is 3 wide and 1 high; those dimensions are rebuilt
    // from the resource, not trusted from the file's reference tokens.
    assert.deepEqual({ width: ego?.width, height: ego?.height }, { width: 3, height: 1 });
  });
});

describe("restart", () => {
  function restartGame(source: string) {
    const container = createContainer();
    container.putResource("logic", 0, assembleLogic(source, { dictionary: DICT }).payload);
    container.putResource("picture", 1, PICTURE);
    container.putResource("view", 3, VIEW_CEL);
    const host = new RecordingHost();
    const engine = new Engine(container, host, DICT);
    host.engine = engine;
    return { engine, host };
  }

  const RESTART_SOURCE = `
    if (isset(f6)) {
      assignn(v101, 1);
      if (isset(f5)) { assignn(v102, 1); }
      return;
    }
    if (!isset(f200)) {
      set(f200);
      script.size(30);
      assignn(v50, 1);
      load.pic(v50);
      draw.pic(v50);
      load.view(3);
      animate.obj(o0);
      set.view(o0, 3);
      draw(o0);
      assignn(v100, 42);
      set(f9);
      set(f16);
      accept.input();
    }
    if (said("mutate")) { restart.game(); }
    return;
  `;

  test("f16 accepts restart, clearing state and setting f6 while f9 survives", () => {
    const { engine, host } = restartGame(RESTART_SOURCE);
    engine.tick();
    assert.equal(engine.vars[100], 42);
    assert.equal(engine.flags[9], 1);

    host.inputQueue.push("mutate");
    engine.tick();

    assert.equal(engine.vars[100], 0, "variables cleared");
    assert.equal(engine.flags[200], 0, "flags cleared");
    assert.equal(engine.flags[9], 1, "f9 is preserved across the reset");
    assert.equal(engine.vars[101], 1, "resumed logic observed f6");
    assert.equal(engine.vars[102], 1, "resumed logic observed f5");
    assert.equal(engine.flags[6], 0, "the resumed cycle cleared f6");
    assert.equal(engine.flags[5], 0, "the resumed cycle cleared f5");
    assert.equal(engine.horizon, 36, "horizon back to its startup value");
    const replay = (engine as unknown as { replay: unknown[] }).replay;
    assert.equal(replay.length, 0, "the replay sequence is cleared");
    assert.deepEqual(engine.readObjects(), [], "no object is still animated");
    // The picture surface is back to its startup fill (visual 15, priority 4).
    assert.deepEqual([...new Set(engine.surface.visual)], [15]);
    assert.deepEqual([...new Set(engine.surface.priority)], [4]);
  });

  test("2.411 never bypasses the prompt, so restart.game leaves state alone", () => {
    const container = createContainer();
    container.putResource("logic", 0, assembleLogic(RESTART_SOURCE, { dictionary: DICT }).payload);
    container.putResource("picture", 1, PICTURE);
    container.putResource("view", 3, VIEW_CEL);
    const host = new RecordingHost();
    const engine = new Engine(container, host, DICT, { profile: "2.411" });
    host.engine = engine;
    assert.equal(engine.profile.restartPromptBypassedByF16, false);
    engine.tick();
    host.inputQueue.push("mutate");
    engine.tick();
    assert.equal(engine.vars[100], 42, "state survives an unconfirmed restart");
    assert.equal(engine.flags[6], 0, "f6 was not set");
  });
});

test("an unconfigured game saves the default replay capacity and keeps recording after restore", () => {
  // The interpreters always hold a configured capacity (the save layout has no
  // unconfigured state); without script.size the engine's default applies and
  // travels in the image, so a restore neither caps the game at the pairs it
  // had recorded nor loses the limit.
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) { set(f200); load.view(1); load.view(2); }
       if (isset(f201)) { reset(f201); load.view(3); }
       return;`,
      { dictionary: new Map() },
    ).payload,
  );
  for (const n of [1, 2, 3])
    container.putResource(
      "view",
      n,
      buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [n] }] }] }),
    );
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  };
  const engine = new Engine(container, host);
  engine.tick();
  const image = engine.serialize();
  const saved = decodeSave(image, engine.profile);
  assert.equal(saved.replayCapacity, 200, "the default capacity is written");
  assert.equal(saved.replayActive, 2);
  const restored = new Engine(container, host);
  restored.restoreImage(image);
  restored.flags[201] = 1;
  assert.doesNotThrow(() => restored.tick(), "a load after restore records freely");
});

test("a configured replay buffer that is exactly full restores exactly full", () => {
  // script.size(2) with two recorded pairs saves capacity 2 and count 2; the
  // restored engine keeps the limit, so the next load fails as it would have
  // before the save. Only the bytes decide, never a guess from their equality.
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) { set(f200); script.size(2); load.view(1); load.view(2); }
       if (isset(f201)) { reset(f201); load.view(3); }
       return;`,
      { dictionary: new Map() },
    ).payload,
  );
  for (const n of [1, 2, 3])
    container.putResource(
      "view",
      n,
      buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [n] }] }] }),
    );
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  };
  const engine = new Engine(container, host);
  engine.tick();
  const image = engine.serialize();
  assert.equal(decodeSave(image, engine.profile).replayCapacity, 2);
  const restored = new Engine(container, host);
  restored.restoreImage(image);
  restored.flags[201] = 1;
  assert.throws(() => restored.tick(), /exceeded its 2-pair capacity/);
});

// ---------- original save/restart audit (docs/fidelity.md) ----------

describe("the RNG stream stays outside the authentic save and restart", () => {
  const RNG_DICT = new Map<string, number>([
    ["save", 200],
    ["restore", 201],
    ["mutate", 202],
    ["roll", 204],
  ]);

  /** The host RNG lane with an inspectable state and a counted clock read. */
  class RngHost extends RecordingHost {
    rng = { state: 0 };
    reseeds = 0;
    randomByte(): number {
      const draw = rngDraw(this.rng.state, () => {
        this.reseeds++;
        return 0x1234;
      });
      this.rng.state = draw.state;
      return draw.byte;
    }
  }

  function lifecycleGame() {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `if (!isset(f200)) {
           set(f200);
           assignn(v50, 1);
           load.pic(v50);
           draw.pic(v50);
           show.pic();
           set(f16);
           accept.input();
         }
         if (said("roll")) { random(0,255,v50); }
         if (said("save")) { save.game(); }
         if (said("restore")) { restore.game(); }
         if (said("mutate")) { restart.game(); }
         return;`,
        { dictionary: RNG_DICT },
      ).payload,
    );
    container.putResource("picture", 1, PICTURE);
    const host = new RngHost();
    const engine = new Engine(container, host, RNG_DICT);
    host.engine = engine;
    return { engine, host };
  }

  test("save and restore leave the live stream standing — the pinned vectors", () => {
    // Executed on SQ2 2.936 and GR1 3.002.149 (docs/fidelity.md, save/restart
    // audit): (RNG at save, RNG before restore, RNG after restore). The word
    // is no save block — restore never resurrects it.
    for (const [saved, current] of [
      [0, 1],
      [1, 0],
      [0xbeef, 0x1234],
      [0xffff, 0xbeef],
    ] as const) {
      const { engine, host } = lifecycleGame();
      engine.tick(); // the room's init draws its picture
      host.rng.state = saved;

      host.inputQueue.push("roll");
      engine.tick(); // consumes one draw of the stream
      host.inputQueue.push("save");
      engine.tick();
      assert.ok(host.saved, "save.game handed a file image to the host");

      host.inputQueue.push("roll");
      engine.tick(); // the stream moved on between save and restore
      host.rng.state = current;
      host.inputQueue.push("restore");
      engine.tick();
      assert.equal(
        host.rng.state,
        current,
        `saved ${saved}, current ${current}: restore left the stream untouched`,
      );

      host.inputQueue.push("roll");
      engine.tick();
      const want = rngDraw(current, () => 0x1234);
      assert.equal(engine.vars[50], want.byte, "the next draw continues the live stream");
      assert.equal(host.rng.state, want.state);
    }
  });

  test("accepted restart clears both timing words, keeps f9 and the RNG word", () => {
    // Executed for RNG [0,1,0xbeef,0xffff] with f9 clear and set: restart
    // preserves both, zeroes the two DS timing words (started at 123 and
    // 456) and sets f6. No clock read occurs in the reset path.
    for (const rng0 of [0, 1, 0xbeef, 0xffff]) {
      for (const f9 of [0, 1]) {
        const { engine, host } = lifecycleGame();
        host.rng.state = rng0;
        for (let i = 0; i < 123; i++) engine.tick(); // one timer tick per pass
        engine.advanceClock(456); // the millisecond-remainder word
        engine.flags[9] = f9;

        host.inputQueue.push("mutate");
        engine.tick();

        assert.equal(host.rng.state, rng0, `rng ${rng0} f9 ${f9}: stream untouched`);
        assert.equal(host.reseeds, 0, "restart consumed no clock read");
        assert.equal(engine.flags[9], f9, "f9 preserved");
        assert.equal(engine.flags[6], 0, "f6 was consumed by the immediate resumed cycle");
        assert.equal(
          decodeSave(engine.serialize(), engine.profile).timerTicks,
          0,
          "the tick word cleared",
        );

        // The same cycle re-ran init and drew the picture, so the resumable
        // snapshot already witnesses the other accumulator.
        assert.equal(
          engine.captureReplayState().clockRemainderMs,
          0,
          "the ms-remainder word cleared",
        );
      }
    }
  });

  test("a zero-state RNG reads the clock on the next draw, never during restart", () => {
    const { engine, host } = lifecycleGame();
    host.rng.state = 0;
    engine.tick();
    host.inputQueue.push("mutate");
    engine.tick();
    assert.equal(host.rng.state, 0);
    assert.equal(host.reseeds, 0, "restart never touched the clock");

    // The immediate re-run already re-armed input before the roll lands.
    host.inputQueue.push("roll");
    engine.tick();
    assert.equal(host.reseeds, 1, "exactly one clock read on the draw");
    const want = rngDraw(0, () => 0x1234);
    assert.equal(engine.vars[50], want.byte);
    assert.equal(host.rng.state, want.state);

    host.inputQueue.push("roll");
    engine.tick();
    assert.equal(host.reseeds, 1, "the reseeded stream does not read again");
  });
});

describe("the block-2 object record carries the shared parameter bank", () => {
  // docs/fidelity.md, motion audit: record offsets 0x27..0x2a are one bank —
  // move.obj's full four-byte write, end.of.loop's flag in byte 0,
  // follow.ego's captured threshold / flag / retry-255 with byte 3 preserved,
  // and wander's countdown in byte 0. Assertions are the executed bytes, not
  // a self-roundtrip.
  function bankedGame(): Engine {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `if (!isset(f200)) {
           set(f200);
           assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic();
           load.view(3);
           animate.obj(o1); set.view(o1, 3); ignore.objs(o1);
           position(o1, 10, 80); draw(o1); step.size(o1, v50); step.time(o1, v50);
           move.obj(o1, 30, 40, 0, f62);
           follow.ego(o1, 5, f63);
           animate.obj(o2); set.view(o2, 3); ignore.objs(o2);
           position(o2, 60, 80); draw(o2); step.size(o2, v50); step.time(o2, v50);
           move.obj(o2, 90, 80, 2, f64);
           end.of.loop(o2, f65);
           animate.obj(o3); set.view(o3, 3); ignore.objs(o3);
           position(o3, 40, 120); draw(o3); step.size(o3, v50); step.time(o3, v50);
           end.of.loop(o3, f66);
           move.obj(o3, 90, 80, 2, f67);
           animate.obj(o4); set.view(o4, 3); ignore.objs(o4);
           position(o4, 20, 120); draw(o4); step.size(o4, v50); step.time(o4, v50);
           move.obj(o4, 90, 80, 0, f68);
           wander(o4);
         }
         return;`,
        { dictionary: DICT },
      ).payload,
    );
    container.putResource("picture", 1, PICTURE);
    container.putResource("view", 3, VIEW_CEL);
    const host = new RecordingHost();
    const engine = new Engine(container, host, DICT);
    host.engine = engine;
    return engine;
  }

  test("the original opcode writes land at 0x27..0x2a in the 43-byte record", () => {
    const engine = bankedGame();
    engine.execute(0); // logic only — no object pass consumes the retry byte

    const image = engine.serialize();
    const b2at = DESC + 2 + 0x05e1;
    const b2len = u16(image, b2at);
    const b2 = image.subarray(b2at + 2, b2at + 2 + b2len);
    assert.equal(b2.length % OBJECT_RECORD_BYTES, 0);
    assert.equal(b2.length, 21 * OBJECT_RECORD_BYTES, "the profile's 21 records");
    const bank = (n: number) =>
      Array.from(b2.subarray(n * OBJECT_RECORD_BYTES + 0x27, n * OBJECT_RECORD_BYTES + 0x2b));

    // follow.ego after move.obj: [max(5, step 1), flag, 255, preserved byte].
    assert.deepEqual(bank(1), [5, 63, 255, 62]);
    // move.obj then end.of.loop: the flag byte overwrote the destination.
    assert.deepEqual(bank(2), [65, 80, 1, 64]);
    // end.of.loop then move.obj: the motion's full write followed.
    assert.deepEqual(bank(3), [90, 80, 1, 67]);
    // wander over a move-filled bank: only the countdown byte 0 is cleared.
    assert.deepEqual(bank(4), [0, 80, 1, 68]);
  });

  test("the bank bytes decode back through the record", () => {
    const engine = bankedGame();
    engine.execute(0);
    const decoded = decodeSave(engine.serialize(), engine.profile);
    assert.equal(decoded.objects.length, 21, "the profile's record count without OBJECT");
    assert.deepEqual(decoded.objects[1]!.motionParams, [5, 63, 255, 62]);
    assert.deepEqual(decoded.objects[2]!.motionParams, [65, 80, 1, 64]);
    assert.deepEqual(decoded.objects[3]!.motionParams, [90, 80, 1, 67]);
    assert.deepEqual(decoded.objects[4]!.motionParams, [0, 80, 1, 68]);
  });
});

describe("shipped Amiga save images (fixture-gated)", () => {
  /**
   * Every shipped Save/ image of an Amiga fixture must decode under the
   * fixture's profile and re-encode byte-identically — the layout claims in
   * docs/fidelity.md rest on these files. The F1 key-map entry
   * ({rawKey 0x3b00, status 2}), the signature stem, the replay capacity
   * that sizes block 4 and the logic-resume list are checked explicitly.
   */
  interface ShippedSaveCase {
    readonly alias: string;
    readonly profile: keyof typeof PROFILES;
    readonly signature: string;
    readonly replayCapacity: number;
  }

  const CASES: readonly ShippedSaveCase[] = [
    { alias: "sq1-amiga", profile: "amiga-2.082", signature: "SQ", replayCapacity: 50 },
    { alias: "sq2-amiga", profile: "amiga-2.202", signature: "SQ2", replayCapacity: 100 },
  ];

  function saveImages(alias: string): readonly { name: string; bytes: Uint8Array }[] {
    const fixture = findFixture(alias);
    if (!fixture) return [];
    const dir = fixture.files.get("save");
    if (!dir) return [];
    return readdirSync(join(fixture.dir, dir))
      .filter((name) => !name.endsWith(".info"))
      .sort()
      .map((name) => ({
        name,
        bytes: new Uint8Array(readFileSync(join(fixture.dir, dir, name))),
      }));
  }

  for (const c of CASES) {
    const reason = fixtureSkip(c.alias);
    test(`${c.alias}: every shipped Save/ image decodes and round-trips`, (t) => {
      if (reason) {
        t.skip(reason);
        return;
      }
      const images = saveImages(c.alias);
      assert.ok(images.length > 0, `${c.alias} ships no Save/ images`);
      const profile = PROFILES[c.profile];
      for (const image of images) {
        const state = decodeSave(image.bytes, profile);
        const stem = String.fromCharCode(...state.signature.subarray(0, c.signature.length));
        assert.equal(stem, c.signature, `${image.name} signature`);
        assert.deepEqual(
          state.keyMap[0],
          { rawKey: 0x3b00, status: 2 },
          `${image.name} F1 key-map entry`,
        );
        assert.equal(state.replayCapacity, c.replayCapacity, `${image.name} replay capacity`);
        assert.equal(
          state.replay.length,
          state.replayCapacity,
          `${image.name} block-4 length matches`,
        );
        assert.ok(state.replayActive <= state.replayCapacity, `${image.name} active count`);
        assert.ok(
          state.logicResume.every((r) => r.logic !== 0xffff),
          `${image.name} logic-resume list has no terminator inside`,
        );
        assert.deepEqual(
          Array.from(encodeSave(state, profile)),
          Array.from(image.bytes),
          `${image.name} re-encodes byte-identically`,
        );
      }
    });
  }
});

describe("native object flags and engine save round trips (fixture-gated)", () => {
  function u16be(bytes: Uint8Array, at: number): number {
    return (bytes[at]! << 8) | bytes[at + 1]!;
  }

  /** The edition's files under their on-disk names, as the app opens them. */
  function openFixture(alias: string): {
    container: ReturnType<typeof openContainer>;
    dict: Map<string, number>;
  } {
    const fixture = findFixture(alias)!;
    const files = new Map<string, Uint8Array>();
    let dict = new Map<string, number>();
    for (const actual of fixture.files.values()) {
      const path = join(fixture.dir, actual);
      if (!statSync(path).isFile()) continue;
      const bytes = new Uint8Array(readFileSync(path));
      if (actual.toLowerCase() === "words.tok")
        dict = new Map(parseWordsTok(bytes).map((e) => [e.word, e.id]));
      files.set(actual, bytes);
    }
    return { container: openContainer(files), dict };
  }

  class QuietHost implements EngineHost {
    prints = 0;
    keys: number[] = [];
    print(): void {
      this.prints++;
    }
    displayAt(): void {}
    statusLine(): void {}
    takeInputLine(): string | null {
      return null;
    }
    takeKeys(): number[] {
      return this.keys.splice(0);
    }
  }

  function boot(alias: string, profile: keyof typeof PROFILES, room: number) {
    const { container, dict } = openFixture(alias);
    const host = new QuietHost();
    const engine = new Engine(container, host, dict, { restarted: true, profile });
    for (let i = 0; i < 600 && engine.vars[0] !== room; i++) {
      if (host.keys.length === 0) host.keys.push(0x0d);
      engine.tick();
      if (host.prints > 0) {
        engine.ackPrint();
        host.prints = 0;
      }
    }
    assert.equal(engine.vars[0], room, `${alias} reaches room ${room}`);
    // Let the room's opening passes run (SQ2 IIgs accepts input ~150 in).
    for (let i = 0; i < 200; i++) {
      if (host.keys.length === 0) host.keys.push(0x0d);
      engine.tick();
      if (host.prints > 0) {
        engine.ackPrint();
        host.prints = 0;
      }
    }
    return { engine, container, dict };
  }

  test("sq2sg.1 decodes object 1 animated but stopped and slot 15 unanimated", (t) => {
    const reason = fixtureSkip("sq2-amiga");
    if (reason) return t.skip(reason);
    const fixture = findFixture("sq2-amiga")!;
    const bytes = new Uint8Array(
      readFileSync(join(fixture.dir, fixture.files.get("save")!, "sq2sg.1")),
    );
    const state = decodeSave(bytes, PROFILES["amiga-2.202"]);
    const flagsOf = (n: number) => u16be(state.objects[n]!.raw!, 0x3e);
    // Object 1's native word 0x6247 = drawn 0x0001 + ignore.blocks 0x0002 +
    // fixed priority 0x0004 + animated 0x0040 + ignore.objs 0x0200 +
    // fix.loop 0x2000 + stationary 0x4000, with the update-pass bit 0x0010
    // clear (stop.update). Portable: active 0x1 + update 0x2 + fixedPriority
    // 0x8 + observeHorizon 0x10 + loopFixed 0x80 + earlierPartition 0x400 +
    // stationary 0x2000 = 0x249b.
    assert.equal(flagsOf(1), 0x6247);
    assert.equal(state.objects[1]!.state, 0x249b);
    // Slot 15 is unused: only the update-pass bit, so neither drawn nor
    // animated nor stopped — it observes horizon, blocks and objects: 0x70.
    assert.equal(flagsOf(15), 0x0010);
    assert.equal(state.objects[15]!.state, 0x0070);
  });

  test("sq1-amiga: an engine save restores stopped, animated and stationary state", (t) => {
    const reason = fixtureSkip("sq1-amiga");
    if (reason) return t.skip(reason);
    const profile = PROFILES["amiga-2.082"];
    const { engine } = boot("sq1-amiga", "amiga-2.082", 2);
    const state = decodeSave(engine.serialize(), profile);
    // Portable 0x2413: active 0x1 + update 0x2 + observeHorizon 0x10 +
    // earlierPartition 0x400 + stationary 0x2000 — drawn, animated,
    // stop.update'd and stationary, ignoring blocks and objects. Object 1
    // borrows ego's loaded view so restore can rebind its cel.
    state.objects[1] = { ...state.objects[0]!, event: 1, state: 0x2413 };
    delete state.objects[1].raw;
    engine.restoreImage(encodeSave(state, profile));
    const saved = engine.serialize();
    // Native: drawn 0x0001 + ignore.blocks 0x0002 + animated 0x0040 +
    // ignore.objs 0x0200 + stationary 0x4000 = 0x4243 (update pass clear).
    const b2at = DESC + 2 + 0x2f4;
    assert.equal(u16be(saved, b2at + 2 + 0x48 + 0x3e), 0x4243);
    assert.equal(decodeSave(saved, profile).objects[1]!.state, 0x2413);
  });

  test("sq2-iigs: an engine save restores its picture, replay, text and input state", (t) => {
    const reason = fixtureSkip("sq2-iigs");
    if (reason) return t.skip(reason);
    const profile = PROFILES["iigs-1.014"];
    const { engine, container, dict } = boot("sq2-iigs", "iigs-1.014", 2);
    const image = engine.serialize();
    const before = decodeSave(image, profile);
    // Room 2 drew its picture through the replay buffer and turned on the
    // status line and input — the ~globals words the lead block now carries.
    assert.ok(before.replayActive > 0, "replay pairs recorded");
    assert.ok(before.lastPicture > 0, "a picture was drawn");
    assert.equal(before.statusEnabled, 1);
    assert.equal(before.inputEnabled, 1);
    assert.equal(String.fromCharCode(...before.signature.subarray(0, 3)), "SQ2");
    const restored = new Engine(container, new QuietHost(), dict, { profile: "iigs-1.014" });
    restored.restoreImage(image);
    assert.deepEqual(
      Array.from(restored.surface.visual),
      Array.from(engine.surface.visual),
      "the replay redraws the saved screen",
    );
    const after = decodeSave(restored.serialize(), profile);
    for (const field of [
      "timerTicks",
      "lastPicture",
      "replayActive",
      "replayCheckpoint",
      "textFg",
      "textBg",
      "inputEnabled",
      "inputRow",
      "promptChar",
      "statusEnabled",
      "statusRow",
      "displayBaseRow",
      "displayBottomRow",
    ] as const)
      assert.equal(after[field], before[field], field);
  });
});
