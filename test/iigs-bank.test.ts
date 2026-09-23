import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIigsInstrument, readIigsBank } from "../src/sound/iigsBank.ts";
import { findFixture, fixtureSkip } from "./fixtures.ts";

/**
 * The IIgs instrument bank reader. Hand-built records and a minimal OMF file
 * prove the format handling; the fixture tests decode the real SQ2.SYS16 bank
 * against values recorded in the IIgs sound reverse engineering
 * (docs/fidelity.md "IIgs sound").
 */

// ---------------------------------------------------------------- builders

const u16le = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const u32le = (v: number): number[] => [
  v & 0xff,
  (v >> 8) & 0xff,
  (v >> 16) & 0xff,
  (v >> 24) & 0xff,
];

// OMF body records: DS zero fill, LCONST data, cRELOC pointer patch, END.
const ds = (count: number): number[] => [0xf1, ...u32le(count)];
const lconst = (data: ArrayLike<number>): number[] => [
  0xf2,
  ...u32le(data.length),
  ...Array.from(data),
];
const creloc = (offset: number, value: number): number[] => [
  0xf5,
  4,
  0,
  ...u16le(offset),
  ...u16le(value),
];

/** One OMF segment record with the v2 header fields the reader uses. */
function omfFile(segments: { name: string; length: number; body: number[] }[]): Uint8Array {
  const bytes: number[] = [];
  segments.forEach((seg, segnum) => {
    const bytecnt = 55 + seg.body.length; // 44-byte header + 10-byte name + pad + body
    bytes.push(
      ...u32le(bytecnt),
      ...u32le(0), // respc
      ...u32le(seg.length),
      0,
      0,
      4,
      2, // unused, lablen, numlen, version
      ...u32le(0x10000), // banksize
      ...u16le(0), // kind
      ...u16le(0), // unused
      ...u32le(0), // org
      ...u32le(0), // align
      0,
      0, // numsex, unused
      ...u16le(segnum + 1),
      ...u32le(0), // entry
      ...u16le(44), // dispname
      ...u16le(55), // dispdata
      ...Array.from({ length: 10 }, (_, i) => seg.name.charCodeAt(i) || 0x20),
      0,
      ...seg.body,
    );
  });
  bytes.push(0, 0, 0, 0); // bytecnt 0 terminates the segment list
  return Uint8Array.from(bytes);
}

/**
 * A synthetic instrument record: fixed valid envelope, `marker` in the
 * vibratoDepth byte and the wave page, wave counts as given, topKeys
 * increasing to 127.
 */
function synthInstrument(aCount: number, bCount: number, marker: number): number[] {
  const bytes: number[] = [];
  const envelope: [number, number][] = [
    [127, 32512],
    [112, 276],
    [0, 48],
    [0, 1300],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  for (const [breakpoint, increment] of envelope) bytes.push(breakpoint, ...u16le(increment));
  // releaseSegment, priorityIncrement, pitchBendRange, vibratoDepth,
  // vibratoSpeed, spare, aWaveCount, bWaveCount
  bytes.push(3, 32, 2, marker, 0, 0, aCount, bCount);
  const waves = aCount + bCount;
  for (let i = 0; i < waves; i++) {
    const topKey = i === waves - 1 ? 127 : Math.round((127 * (i + 1)) / waves);
    bytes.push(topKey, 0x20 + marker, 0x12, 0, ...u16le(-2500 & 0xffff));
  }
  return bytes;
}

const RECORDS_AT = 0x04bc;
const RECORDS_END = 0x09c8;
const MAP_AT = 0x0a08;

/**
 * A ~globals segment laid out like 1.014's: 28 records tiling
 * 0x04bc..0x09c8 (27 of 44 bytes + one of 104), the zero-filled pointer
 * regions, then cRELOC records resolving the 50 program-map slots.
 * `targets[i]` is program i's within-segment record offset.
 */
function synthGlobals(targets: number[]): number[] {
  const recordStarts: number[] = [];
  const region: number[] = [];
  for (let i = 0; i < 28; i++) {
    recordStarts.push(RECORDS_AT + region.length);
    region.push(...synthInstrument(i === 27 ? 6 : 1, i === 27 ? 6 : 1, i));
  }
  assert.equal(RECORDS_AT + region.length, RECORDS_END, "test records must tile the window");
  const body = [
    ...ds(RECORDS_AT),
    ...lconst(region),
    ...ds(MAP_AT + 50 * 4 - RECORDS_END), // channel pointers + zeroed program map
  ];
  for (let i = 0; i < targets.length; i++) body.push(...creloc(MAP_AT + i * 4, targets[i]!));
  body.push(0x00);
  return body;
}

// Record i starts at 0x04bc + 44·i; the 12-wave record 27 starts at 0x960
// and ends on 0x09c8.
const STARTS = Array.from({ length: 28 }, (_, i) => RECORDS_AT + i * 44);

// ---------------------------------------------------------------- tests

test("parseIigsInstrument decodes the record layout and reports its length", () => {
  const record = Uint8Array.of(
    // 8 envelope segments {breakpoint u8, increment u16le}
    127,
    0x00,
    0x0f, // {127, 3840}
    120,
    0x0a,
    0x00, // {120, 10}
    120,
    0x00,
    0x00, // {120, 0} sustain
    0,
    0x14,
    0x05, // {0, 1300}
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    3, // releaseSegment
    32, // priorityIncrement
    4, // pitchBendRange
    75, // vibratoDepth
    50, // vibratoSpeed
    0xaa, // spare
    2, // aWaveCount
    1, // bWaveCount
    // A waves: {topKey, waveAddr, waveSize, docMode, relPitch i16le}
    60,
    0x20,
    0x2d,
    0x06,
    0x00,
    0x0c, // relPitch +3072
    127,
    0x70,
    0x24,
    0x06,
    0x00,
    0xff, // relPitch -256
    // B wave
    127,
    0x7f,
    0x00,
    0x01,
    0x00,
    0x00,
    0xde,
    0xad, // trailing bytes belong to the next record
  );
  const { instrument, length } = parseIigsInstrument(record, 0);
  assert.equal(length, 8 * 3 + 8 + 3 * 6);
  assert.deepEqual(instrument.envelope, [
    { breakpoint: 127, increment: 3840 },
    { breakpoint: 120, increment: 10 },
    { breakpoint: 120, increment: 0 },
    { breakpoint: 0, increment: 1300 },
    { breakpoint: 0, increment: 0 },
    { breakpoint: 0, increment: 0 },
    { breakpoint: 0, increment: 0 },
    { breakpoint: 0, increment: 0 },
  ]);
  assert.equal(instrument.releaseSegment, 3);
  assert.equal(instrument.priorityIncrement, 32);
  assert.equal(instrument.pitchBendRange, 4);
  assert.equal(instrument.vibratoDepth, 75);
  assert.equal(instrument.vibratoSpeed, 50);
  assert.deepEqual(instrument.a, [
    { topKey: 60, waveAddr: 0x20, waveSize: 0x2d, docMode: 0x06, relPitch: 3072 },
    { topKey: 127, waveAddr: 0x70, waveSize: 0x24, docMode: 0x06, relPitch: -256 },
  ]);
  assert.deepEqual(instrument.b, [
    { topKey: 127, waveAddr: 0x7f, waveSize: 0x00, docMode: 0x01, relPitch: 0 },
  ]);
  assert.throws(() => parseIigsInstrument(record.subarray(0, 40), 0));
});

test("a synthetic ~globals segment resolves the map through its cRELOC records", () => {
  // Program 0 points at the second record, program 1 at the first; the rest
  // cycle through the 28 record starts.
  const targets = Array.from(
    { length: 50 },
    (_, i) => STARTS[(i === 0 ? 1 : i === 1 ? 0 : i) % 28]!,
  );
  const file = omfFile([
    { name: "~globals", length: MAP_AT + 50 * 4, body: synthGlobals(targets) },
  ]);
  const bank = readIigsBank(file);
  assert.ok(bank);
  assert.equal(bank.programs.length, 50);
  // The map slots hold zeros in the image; only the relocation records tie
  // program 0 to record 1 (marker byte 1, wave page 0x21).
  assert.equal(bank.programs[0]!.vibratoDepth, 1);
  assert.equal(bank.programs[0]!.a[0]!.waveAddr, 0x21);
  assert.equal(bank.programs[1]!.vibratoDepth, 0);
  assert.equal(bank.programs[49]!.vibratoDepth, 21); // STARTS[21]
  assert.equal(bank.programs[27]!.a.length, 6); // the 104-byte record
  // The channel default is the record at ~globals+0x05c4: with 44-byte
  // records that is record 6.
  assert.equal(bank.defaultInstrument.vibratoDepth, 6);
});

test("the map must resolve to record starts", () => {
  const targets = Array.from({ length: 50 }, (_, i) => STARTS[i % 28]!);
  // A slot pointing into the middle of a record is not the 1.014 layout.
  targets[7] = STARTS[3]! + 2;
  const file = omfFile([
    { name: "~globals", length: MAP_AT + 50 * 4, body: synthGlobals(targets) },
  ]);
  assert.equal(readIigsBank(file), null);
  // A slot with no relocation record stays zero and resolves nothing.
  const partial = omfFile([
    { name: "~globals", length: MAP_AT + 50 * 4, body: synthGlobals(targets.slice(0, 49)) },
  ]);
  assert.equal(readIigsBank(partial), null);
  // A file without a ~globals segment has no bank.
  const other = omfFile([{ name: "main", length: MAP_AT + 50 * 4, body: synthGlobals(targets) }]);
  assert.equal(readIigsBank(other), null);
});

test("malformed input returns null rather than throwing", () => {
  assert.equal(readIigsBank(new Uint8Array(100)), null);
  assert.equal(readIigsBank(new Uint8Array(0)), null);
});

// ------------------------------------------------- real SQ2.SYS16 fixture

const sys16Skip = fixtureSkip("sq2-iigs", ["SQ2.SYS16"], { resourceFiles: false });

function readSys16(): Uint8Array {
  const fixture = findFixture("sq2-iigs");
  assert.ok(fixture);
  const name = fixture.files.get("sq2.sys16") ?? "SQ2.SYS16";
  return new Uint8Array(readFileSync(join(fixture.dir, name)));
}

test(
  "SQ2.SYS16 decodes the 1.014 bank and its loader-resolved program map",
  { skip: sys16Skip },
  () => {
    const bank = readIigsBank(readSys16());
    assert.ok(bank);
    assert.equal(bank.programs.length, 50);

    // Program 0 -> ~globals+0x0894 (record 21).
    assert.deepEqual(bank.programs[0], {
      envelope: [
        { breakpoint: 127, increment: 32512 },
        { breakpoint: 127, increment: 0 },
        { breakpoint: 0, increment: 48 },
        { breakpoint: 0, increment: 20 },
        { breakpoint: 0, increment: 0 },
        { breakpoint: 0, increment: 0 },
        { breakpoint: 0, increment: 0 },
        { breakpoint: 0, increment: 0 },
      ],
      releaseSegment: 3,
      priorityIncrement: 32,
      pitchBendRange: 2,
      vibratoDepth: 0,
      vibratoSpeed: 0,
      a: [{ topKey: 127, waveAddr: 72, waveSize: 27, docMode: 18, relPitch: 512 }],
      b: [{ topKey: 127, waveAddr: 0, waveSize: 0, docMode: 1, relPitch: 0 }],
    });

    // Programs 6..9 and 44..49, and every channel before a program change,
    // use the record at ~globals+0x05c4: four A waves split at 59/71/83/127.
    const dflt = bank.defaultInstrument;
    assert.deepEqual(
      dflt.a.map((w) => w.topKey),
      [59, 71, 83, 127],
    );
    assert.deepEqual(
      dflt.a.map((w) => w.waveAddr),
      [32, 96, 64, 112],
    );
    assert.deepEqual(
      dflt.a.map((w) => w.waveSize),
      [45, 36, 45, 36],
    );
    assert.deepEqual(
      dflt.a.map((w) => w.docMode),
      [6, 6, 6, 6],
    );
    assert.deepEqual(
      dflt.a.map((w) => w.relPitch),
      [3072, 0, 3072, 0],
    );
    assert.deepEqual(
      dflt.b.map((w) => ({ topKey: w.topKey, waveAddr: w.waveAddr, docMode: w.docMode })),
      [
        { topKey: 59, waveAddr: 63, docMode: 1 },
        { topKey: 71, waveAddr: 111, docMode: 1 },
        { topKey: 83, waveAddr: 95, docMode: 1 },
        { topKey: 127, waveAddr: 127, docMode: 1 },
      ],
    );
    assert.deepEqual(dflt.envelope.slice(0, 4), [
      { breakpoint: 127, increment: 32512 },
      { breakpoint: 112, increment: 276 },
      { breakpoint: 0, increment: 48 },
      { breakpoint: 0, increment: 1300 },
    ]);
    for (const program of [6, 7, 8, 9, 44, 45, 46, 47, 48, 49]) {
      assert.equal(bank.programs[program], dflt, `program ${program} is the default`);
    }

    // Program 30 -> ~globals+0x04bc (record 0).
    assert.deepEqual(bank.programs[30], {
      envelope: [
        { breakpoint: 127, increment: 3840 },
        { breakpoint: 120, increment: 10 },
        { breakpoint: 120, increment: 0 },
        { breakpoint: 0, increment: 1300 },
        { breakpoint: 0, increment: 0 },
        { breakpoint: 0, increment: 0 },
        { breakpoint: 0, increment: 0 },
        { breakpoint: 0, increment: 0 },
      ],
      releaseSegment: 3,
      priorityIncrement: 32,
      pitchBendRange: 2,
      vibratoDepth: 75,
      vibratoSpeed: 50,
      a: [{ topKey: 127, waveAddr: 80, waveSize: 18, docMode: 0, relPitch: -2500 }],
      b: [{ topKey: 127, waveAddr: 80, waveSize: 18, docMode: 0, relPitch: -2500 }],
    });

    // Program 10 -> ~globals+0x0614 (record 7): a two-way key split.
    assert.deepEqual(bank.programs[10]!.a, [
      { topKey: 88, waveAddr: 36, waveSize: 18, docMode: 0, relPitch: -3072 },
      { topKey: 127, waveAddr: 40, waveSize: 27, docMode: 0, relPitch: -8112 },
    ]);
    assert.deepEqual(bank.programs[10]!.b, [
      { topKey: 88, waveAddr: 36, waveSize: 18, docMode: 16, relPitch: -3070 },
      { topKey: 127, waveAddr: 40, waveSize: 27, docMode: 16, relPitch: -8114 },
    ]);

    // Program 2 -> ~globals+0x0918 (record 24): 16 KiB tables, one-shot mode.
    assert.deepEqual(bank.programs[2]!.a, [
      { topKey: 127, waveAddr: 128, waveSize: 54, docMode: 2, relPitch: -2560 },
    ]);
    assert.deepEqual(bank.programs[2]!.b, [
      { topKey: 127, waveAddr: 128, waveSize: 54, docMode: 2, relPitch: -2560 },
    ]);
    assert.deepEqual(bank.programs[2]!.envelope[2], { breakpoint: 0, increment: 1 });
  },
);

test("a truncated SQ2.SYS16 has no readable bank", { skip: sys16Skip }, () => {
  const sys16 = readSys16();
  // Cut inside the ~globals segment's body: its header's bytecnt then
  // overruns the file.
  const marker = [0x7e, 0x67, 0x6c, 0x6f, 0x62, 0x61, 0x6c, 0x73]; // "~globals"
  const name = sys16.findIndex((_, i) => marker.every((b, j) => sys16[i + j] === b));
  assert.ok(name > 0, "fixture carries a ~globals segment name");
  assert.equal(readIigsBank(sys16.subarray(0, name + 0x100)), null);
  assert.equal(readIigsBank(sys16.subarray(0, 100)), null);
});
