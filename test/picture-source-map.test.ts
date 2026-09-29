import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePictureSource, pictureSpanAt } from "../src/picture/source.ts";

// Offsets below are derived by hand from the opcode encodings in source.ts:
// vis c = f0 c (2), line = f6 + 2 bytes per point, rect = f6 + 5 corners,
// fill = f8 + 2 bytes per seed, end = ff.
const SOURCE = [
  "# sky", //                    1: comment, no bytes
  "vis 1", //                    2: f0 01                        [0, 2)
  "line 0,0 3,0", //             3: f6 00 00 03 00               [2, 7)
  "rect 10,10 12,12", //         4: f6 + 10 corner bytes          [7, 18)
  "", //                         5: blank, no bytes
  "copy 2-3 0,5", //             6: f0 01 f6 00 05 03 05          [18, 25)
  "fill 11,11", //               7: f8 0b 0b                     [25, 28)
  "end", //                      8: ff                           [28, 29)
].join("\n");

test("spans map each byte-emitting source line to its byte range", () => {
  const { bytes, spans } = compilePictureSource(SOURCE);
  assert.deepEqual(
    Array.from(bytes),
    [
      0xf0, 1, 0xf6, 0, 0, 3, 0, 0xf6, 10, 10, 12, 10, 12, 12, 10, 12, 10, 10, 0xf0, 1, 0xf6, 0, 5,
      3, 5, 0xf8, 11, 11, 0xff,
    ],
  );
  assert.deepEqual(spans, [
    { line: 2, start: 0, end: 2 },
    { line: 3, start: 2, end: 7 },
    { line: 4, start: 7, end: 18 },
    { line: 6, start: 18, end: 25 },
    { line: 7, start: 25, end: 28 },
    { line: 8, start: 28, end: 29 },
  ]);
});

test("the implied terminator has no span", () => {
  const { bytes, spans } = compilePictureSource("vis 2\n# note\nline 1,1\n");
  assert.deepEqual(Array.from(bytes), [0xf0, 2, 0xf6, 1, 1, 0xff]);
  assert.deepEqual(spans, [
    { line: 1, start: 0, end: 2 },
    { line: 3, start: 2, end: 5 },
  ]);
});

test("pictureSpanAt finds the span containing a byte offset", () => {
  const { spans } = compilePictureSource(SOURCE);
  assert.equal(pictureSpanAt(spans, 0)?.line, 2);
  assert.equal(pictureSpanAt(spans, 1)?.line, 2);
  assert.equal(pictureSpanAt(spans, 2)?.line, 3);
  assert.equal(pictureSpanAt(spans, 17)?.line, 4);
  assert.equal(pictureSpanAt(spans, 18)?.line, 6);
  assert.equal(pictureSpanAt(spans, 24)?.line, 6);
  assert.equal(pictureSpanAt(spans, 28)?.line, 8);
  assert.equal(pictureSpanAt(spans, 29), undefined);
  assert.equal(pictureSpanAt(spans, -1), undefined);
  // Offsets past the last span (the implied terminator) have no line.
  const implied = compilePictureSource("vis 2\nline 1,1");
  assert.equal(pictureSpanAt(implied.spans, 5), undefined);
});
