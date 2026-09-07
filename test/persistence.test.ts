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
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildView } from "../src/view/view.ts";

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
    assert.equal(layout.keyMapEntries, 39);
    assert.equal(layout.keyMapReserved, 10);
    assert.equal(layout.stringSlots, 12);
    assert.equal(layout.stringReserved, 12);
    assert.equal(layout.checkpoint, true);
  });

  test("3.002.149's 49-slot key map consumes the ten inactive records", () => {
    const layout = block1Layout(PROFILES["3.002.149"]);
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
    assert.equal(engine.flags[6], 1, "f6 marks the restart");
    assert.equal(engine.flags[5], 1, "f5 marks the new room");
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
