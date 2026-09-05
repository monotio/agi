import assert from "node:assert/strict";
import { test } from "node:test";
import {
  annotatePictureSource,
  analyzePictureStructure,
  comparePictureStructure,
  compilePictureSource,
  disassemblePicture,
  PictureSourceSyntaxError,
  readPictureSource,
} from "../src/picture/source.ts";
import { fixtureSkip } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

function bytes(source: string): number[] {
  return Array.from(compilePictureSource(source).bytes);
}

test("primitives compile to the spec byte values", () => {
  assert.deepEqual(
    bytes("vis 3\nvis off\npri 12\npri off\nend"),
    [0xf0, 3, 0xf1, 0xf2, 12, 0xf3, 0xff],
  );
  assert.deepEqual(bytes("line 1,2 3,4 5,6"), [0xf6, 1, 2, 3, 4, 5, 6, 0xff]);
  assert.deepEqual(bytes("ycorner 10,20 30 40 50"), [0xf4, 10, 20, 30, 40, 50, 0xff]);
  assert.deepEqual(bytes("xcorner 10,20 30 40"), [0xf5, 10, 20, 30, 40, 0xff]);
  assert.deepEqual(bytes("fill 7,8 9,10"), [0xf8, 7, 8, 9, 10, 0xff]);
  // Relative deltas: dx in bits 4..6 (0x80 = negative), dy in bits 0..2 (0x08 = negative).
  assert.deepEqual(bytes("rel 50,60 3,-2 -7,7 0,0"), [
    0xf7,
    50,
    60,
    0x30 | 0x08 | 2,
    0x80 | 0x70 | 7,
    0x00,
    0xff,
  ]);
  assert.deepEqual(bytes("pen 2\nplot 4,5"), [0xf9, 2, 0xfa, 4, 5, 0xff]);
  assert.deepEqual(
    bytes("pen 3 stipple bypass\nplot 17 4,5 99 6,7"),
    [0xf9, 0x33, 0xfa, 17, 4, 5, 99, 6, 7, 0xff],
  );
  assert.deepEqual(bytes("pen raw 200"), [0xf9, 200, 0xff]);
  // A stipple seed carries over to following pairs until the next seed.
  assert.deepEqual(
    bytes("pen 1 stipple\nplot 17 1,2 3,4 9 5,6"),
    [0xf9, 0x21, 0xfa, 17, 1, 2, 17, 3, 4, 9, 5, 6, 0xff],
  );
  assert.deepEqual(bytes("raw 240 5 255"), [0xf0, 5, 0xff]);
});

test("sugar compiles to absolute-line primitives", () => {
  assert.deepEqual(bytes("polyline 1,1 2,2"), [0xf6, 1, 1, 2, 2, 0xff]);
  assert.deepEqual(bytes("polygon 0,0 10,0 5,5"), [0xf6, 0, 0, 10, 0, 5, 5, 0, 0, 0xff]);
  assert.deepEqual(bytes("rect 2,3 8,9"), [0xf6, 2, 3, 8, 3, 8, 9, 2, 9, 2, 3, 0xff]);
});

test("comments, blank lines, case, and the implied terminator", () => {
  const r = compilePictureSource("# sky\n\n  VIS 1  # colour\n\nLINE 0,0 159,0\n");
  assert.deepEqual(Array.from(r.bytes), [0xf0, 1, 0xf6, 0, 0, 159, 0, 0xff]);
  assert.equal(r.commandCount, 2);
  assert.deepEqual(r.warnings, ["missing 'end'; terminator appended"]);
  assert.deepEqual(compilePictureSource("vis 1\nend\n").warnings, []);
});

test("errors carry line numbers and are collected across the file", () => {
  const src =
    "vis 1\nline 0,0 160,5\nbogus 1,2\nrel 0,0 8,1\npen 1\nplot 3 4,5\nvis 16\nend\nvis 2";
  assert.throws(
    () => compilePictureSource(src),
    (e: unknown) => {
      assert.ok(e instanceof PictureSourceSyntaxError);
      const lines = e.errors.map((x) => x.line);
      assert.deepEqual(lines, [2, 3, 4, 6, 7, 9]);
      assert.match(e.errors[0]!.message, /160,5 out of range/);
      assert.match(e.errors[1]!.message, /unknown command 'bogus'/);
      assert.match(e.errors[2]!.message, /8,1 out of range -7\.\.7/);
      assert.match(e.errors[3]!.message, /expected x,y pair, got '3'/);
      assert.match(e.errors[4]!.message, /colour 0\.\.15/);
      assert.match(e.errors[5]!.message, /after 'end'/);
      return true;
    },
  );
  assert.throws(() => compilePictureSource("pen 1 stipple\nplot 4,5"), /stipple pen is active/);
  assert.throws(() => compilePictureSource("polygon 1,1 2,2"), /at least 3/);
});

test("lenient mode admits raw colour operands and guarded off-surface coordinates", () => {
  assert.throws(() => compilePictureSource("vis 250"));
  assert.deepEqual(
    Array.from(compilePictureSource("vis 250\nline 200,239", { lenient: true }).bytes),
    [0xf0, 250, 0xf6, 200, 239, 0xff],
  );
});

test("disassembler emits primitives and raw escapes for malformed data", () => {
  const dis = disassemblePicture(
    new Uint8Array([
      0xf0, 4, 0xf2, 0xfa, 0xf6, 1, 2, 3, 4, 0xf7, 5, 6, 0x12, 0x80, 0xf9, 0x21, 0xfa, 9, 1, 2,
      0xf8, 7, 8, 9, 0xf1, 0x33, 0xfb, 0xff, 0x11,
    ]),
  );
  assert.equal(
    dis,
    [
      "vis 4",
      "pri 250",
      "line 1,2 3,4",
      "rel 5,6 1,2",
      "raw 128",
      "pen 1 stipple",
      "plot 9 1,2",
      "fill 7,8",
      "raw 9",
      "vis off",
      "raw 51",
      "raw 251",
      "raw 255 17",
    ].join("\n") + "\n",
  );
  const back = compilePictureSource(dis, { lenient: true }).bytes;
  assert.deepEqual(
    Array.from(back),
    [
      0xf0, 4, 0xf2, 0xfa, 0xf6, 1, 2, 3, 4, 0xf7, 5, 6, 0x12, 0x80, 0xf9, 0x21, 0xfa, 9, 1, 2,
      0xf8, 7, 8, 9, 0xf1, 0x33, 0xfb, 0xff, 0x11,
    ],
  );
});

for (const slug of ["kq1", "kq2", "kq3"]) {
  test(
    `${slug}: every PICDIR entry round-trips through source byte for byte`,
    { skip: fixtureSkip(slug) },
    () => {
      const { container } = loadGame(slug);
      let count = 0;
      let commands = 0;
      for (let num = 0; num < 256; num++) {
        const original = container.getResource("picture", num);
        if (!original) continue;
        count++;
        const source = disassemblePicture(original);
        const result = compilePictureSource(source, { lenient: true });
        commands += result.commandCount;
        assert.deepEqual(
          Array.from(result.bytes),
          Array.from(original),
          `${slug} picture ${num} did not round-trip`,
        );
      }
      assert.ok(count > 0, "fixture has pictures");
      console.log(`  ${slug}: ${count} pictures, ${commands} commands round-tripped`);
    },
  );
}

test("analyzePictureStructure counts a hand-built stream", () => {
  const { bytes } = compilePictureSource(
    [
      "vis 1",
      "pri 4",
      "rect 0,0 159,40",
      "fill 80,20 10,10",
      "vis off",
      "pri 9",
      "line 0,50 159,50", // priority-only pass
      "vis 2",
      "rel 5,5 1,1 1,-1",
      "xcorner 3,3 10 12",
      "pen 1 stipple",
      "plot 7 1,1 9 2,2",
      "end",
    ].join("\n"),
  );
  const st = analyzePictureStructure(bytes);
  assert.equal(st.commands, 13); // 12 drawing/state commands + end
  assert.equal(st.lines, 2);
  assert.equal(st.relLines, 1);
  assert.equal(st.cornerLines, 1);
  assert.equal(st.fills, 1);
  assert.equal(st.fillSeeds, 2);
  assert.equal(st.plots, 2);
  // rect: 5 points -> 4 segments; line: 2 points -> 1; rel: 2 deltas; xcorner: 2 steps.
  assert.equal(st.segments, 4 + 1 + 2 + 2);
  assert.deepEqual(st.visualColours, [1, 2]);
  assert.deepEqual(st.priorityValues, [4, 9]);
  // Drawing commands: rect(both) fill(both) line(pri only) rel(both) xcorner(both) plot(both) = 6.
  assert.ok(Math.abs(st.bothChannelsFraction - 5 / 6) < 1e-9);
  assert.ok(Math.abs(st.priorityOnlyFraction - 1 / 6) < 1e-9);
  assert.equal(st.passOrder, "vis pri pri vis");
  assert.equal(st.visualEnables, 2);
  assert.equal(st.priorityEnables, 2);

  const cmp = comparePictureStructure(
    st,
    analyzePictureStructure(compilePictureSource("vis 1\nvis 5\nline 0,0 1,1").bytes),
  );
  assert.equal(cmp.deltas["commands"], 4 - 13);
  assert.equal(cmp.deltas["fillSeeds"], -2);
  assert.ok(Math.abs(cmp.visualColourOverlap - 1 / 3) < 1e-9); // {1,2} vs {1,5}
  assert.equal(cmp.priorityValueOverlap, 0);
});

test("readPictureSource returns null for absent entries and source for present ones", () => {
  const stub = {
    getResource: (_k: string, n: number) => (n === 3 ? new Uint8Array([0xf0, 2, 0xff]) : null),
  };
  assert.equal(readPictureSource(stub, 4), null);
  assert.equal(readPictureSource(stub, 3), "vis 2\nend\n");
});

for (const slug of ["kq1", "kq2", "kq3"]) {
  test(
    `${slug}: readPictureSource on the first room picture recompiles to the stored bytes`,
    { skip: fixtureSkip(slug) },
    () => {
      const { container } = loadGame(slug);
      const num = slug === "kq3" ? 7 : 1;
      const src = readPictureSource(container, num);
      assert.ok(src && src.length > 1000);
      assert.deepEqual(
        Array.from(compilePictureSource(src, { lenient: true }).bytes),
        Array.from(container.getResource("picture", num)!),
      );
    },
  );
}

test("copy sugar re-emits an earlier range with absolute coordinates shifted", () => {
  const src = [
    "vis 6", // 1
    "pri 12", // 2
    "line 10,20 14,26", // 3
    "rel 12,30 1,1 -2,0", // 4
    "xcorner 10,40 20 45 30", // 5
    "pen 1 stipple", // 6
    "plot 7 11,41 12,42", // 7
    "fill 12,22", // 8
    "copy 1-8 100,-10", // 9
    "end",
  ].join("\n");
  const r = compilePictureSource(src);
  const once = compilePictureSource(src.split("\n").slice(0, 8).join("\n")).bytes;
  const body = Array.from(once.subarray(0, once.length - 1));
  const shifted = [
    0xf0,
    6,
    0xf2,
    12,
    0xf6,
    110,
    10,
    114,
    16,
    0xf7,
    112,
    20,
    0x11,
    0x80 | 0x20,
    0xf5,
    110,
    30,
    120,
    35,
    130,
    0xf9,
    0x21,
    0xfa,
    7,
    111,
    31,
    7,
    112,
    32,
    0xf8,
    112,
    12,
  ];
  assert.deepEqual(Array.from(r.bytes), [...body, ...shifted, 0xff]);
  assert.equal(r.commandCount, 17); // 8 + 8 copied + end
  assert.throws(() => compilePictureSource("line 1,1\ncopy 1-2 0,0"), /earlier lines/);
  assert.throws(
    () => compilePictureSource("line 150,1\ncopy 1-1 20,0"),
    /copy of line 1: line point 1: coordinate 170,1/,
  );
  assert.throws(
    () => compilePictureSource("line 1,1\ncopy 1-1 0,0\ncopy 1-2 1,1"),
    /cannot itself contain a copy/,
  );
});

test("annotatePictureSource groups outline + inner fill and separates a far line", () => {
  const { bytes } = compilePictureSource(
    [
      "vis 1",
      "line 10,10 20,10 20,20 10,20 10,10",
      "vis 4",
      "line 100,100 110,100",
      "vis 2",
      "fill 15,15",
      "end",
    ].join("\n"),
  );
  const annotated = annotatePictureSource(bytes);
  assert.equal(
    annotated,
    [
      "# element 1: lines 4-5, 10-11  bbox x10-20 y10-20  colours 1,2",
      "# element 2: lines 7-8  bbox x100-110 y100-100  colours 4",
      "# --- element 1",
      "vis 1",
      "line 10,10 20,10 20,20 10,20 10,10",
      "# --- element 2",
      "vis 4",
      "line 100,100 110,100",
      "# --- element 1",
      "vis 2",
      "fill 15,15",
      "end",
    ].join("\n") + "\n",
  );
  // Pure comments: recompiles to the identical stream.
  assert.deepEqual(Array.from(compilePictureSource(annotated).bytes), Array.from(bytes));
});

for (const slug of ["kq1", "kq2", "kq3"]) {
  test(
    `${slug}: annotated first-room picture recompiles byte-identically`,
    { skip: fixtureSkip(slug) },
    () => {
      const { container } = loadGame(slug);
      const num = slug === "kq3" ? 7 : 1;
      const bytes = container.getResource("picture", num)!;
      const annotated = annotatePictureSource(bytes);
      assert.ok((annotated.match(/^# element \d+:/gm) ?? []).length >= 5);
      assert.deepEqual(
        Array.from(compilePictureSource(annotated, { lenient: true }).bytes),
        Array.from(bytes),
      );
    },
  );
}
