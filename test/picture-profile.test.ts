import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPicture } from "../src/picture/renderer.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { createPictureSurface } from "../src/types.ts";

// Peter Kelly's agi-re, "Picture Resources and Rendering": profile-specific
// command vocabulary, point plots, radius-one masks and horizontal edge limit.
for (const id of ["2.089", "2.230", "2.272"] as const) {
  test(`${id}: ignored f9 does not consume the following command`, () => {
    const surface = createPictureSurface();
    renderPicture(new Uint8Array([0xf0, 1, 0xf9, 0xf0, 2, 0xf6, 5, 5, 0xff]), surface, {
      profile: PROFILES[id],
    });
    const expected = new Uint8Array(160 * 168).fill(15);
    expected[5 * 160 + 5] = 2;
    assert.deepEqual(surface.visual, expected);
  });
}

test("2.411 ignores mode fields and plots each pair without seeds", () => {
  const surface = createPictureSurface();
  renderPicture(new Uint8Array([0xf0, 3, 0xf9, 0x27, 0xfa, 10, 20, 30, 40, 0xff]), surface, {
    profile: PROFILES["2.411"],
  });
  const expected = new Uint8Array(160 * 168).fill(15);
  expected[20 * 160 + 10] = 3;
  expected[40 * 160 + 30] = 3;
  assert.deepEqual(surface.visual, expected);
});

for (const id of ["3.002.086", "3.002.102", "3.002.149"] as const) {
  test(`${id}: radius one draws only two center-row pixels`, () => {
    const surface = createPictureSurface();
    renderPicture(new Uint8Array([0xf0, 3, 0xf9, 1, 0xfa, 10, 20, 0xff]), surface, {
      profile: PROFILES[id],
    });
    const expected = new Uint8Array(160 * 168).fill(15);
    expected[20 * 160 + 9] = 3;
    expected[20 * 160 + 10] = 3;
    assert.deepEqual(surface.visual, expected);
  });
}

test("v3 right edge clamps to 159 without next-row wrapping", () => {
  const surface = createPictureSurface();
  // Radius 2 bypasses its mask: start x=157, columns157..159 on rows8..12.
  renderPicture(new Uint8Array([0xf0, 3, 0xf9, 0x12, 0xfa, 159, 10, 0xff]), surface, {
    profile: PROFILES["3.002.149"],
  });
  const expected = new Uint8Array(160 * 168).fill(15);
  for (let y = 8; y <= 12; y++) {
    for (let x = 157; x <= 159; x++) expected[y * 160 + x] = 3;
  }
  assert.deepEqual(surface.visual, expected);
});

// docs/fidelity.md "Original Amiga and IIgs pattern brushes": the Amiga and
// IIgs plotters keep the 320 limit; 2.31x and the IIgs draw the center-row
// radius 1, 2.176/2.202 read radius 1's third row from radius 2's table.
for (const id of ["amiga-2.316", "iigs-1.014"] as const) {
  test(`${id}: radius one draws only two center-row pixels`, () => {
    const surface = createPictureSurface();
    renderPicture(new Uint8Array([0xf0, 3, 0xf9, 1, 0xfa, 10, 20, 0xff]), surface, {
      profile: PROFILES[id],
    });
    const expected = new Uint8Array(160 * 168).fill(15);
    expected[20 * 160 + 9] = 3;
    expected[20 * 160 + 10] = 3;
    assert.deepEqual(surface.visual, expected);
  });

  test(`${id}: the 320 limit lets a right-edge plot wrap into the next row`, () => {
    const surface = createPictureSurface();
    // Radius 2 bypasses its mask: 2*159-2 = 316 <= 320-4, so x starts at 158
    // and its third column is the next row's x=0 on rows 8..12.
    renderPicture(new Uint8Array([0xf0, 3, 0xf9, 0x12, 0xfa, 159, 10, 0xff]), surface, {
      profile: PROFILES[id],
    });
    const expected = new Uint8Array(160 * 168).fill(15);
    for (let y = 8; y <= 12; y++) {
      expected[y * 160 + 158] = 3;
      expected[y * 160 + 159] = 3;
      expected[(y + 1) * 160] = 3;
    }
    assert.deepEqual(surface.visual, expected);
  });
}

for (const id of ["amiga-2.176", "amiga-2.202"] as const) {
  test(`${id}: radius one's third row is radius two's first word`, () => {
    const surface = createPictureSurface();
    // Rows e000, e000, 7000 through column masks 8000/2000: both columns on
    // rows 19 and 20, only the second column on row 21.
    renderPicture(new Uint8Array([0xf0, 3, 0xf9, 1, 0xfa, 10, 20, 0xff]), surface, {
      profile: PROFILES[id],
    });
    const expected = new Uint8Array(160 * 168).fill(15);
    for (const [x, y] of [
      [9, 19],
      [10, 19],
      [9, 20],
      [10, 20],
      [10, 21],
    ] as const)
      expected[y * 160 + x] = 3;
    assert.deepEqual(surface.visual, expected);
  });
}

test("amiga-2.082: ignores 0xf9 and 0xfa like early PC profiles", () => {
  const surface = createPictureSurface();
  renderPicture(new Uint8Array([0xf0, 1, 0xf9, 0xf0, 2, 0xf6, 5, 5, 0xff]), surface, {
    profile: PROFILES["amiga-2.082"],
  });
  const expected = new Uint8Array(160 * 168).fill(15);
  expected[5 * 160 + 5] = 2;
  assert.deepEqual(surface.visual, expected);
});

// docs/fidelity.md F-picture-09: PC drawline uses 8-bit error accumulators
// (wrapping modulo 256 when error + delta >= 256 on long diagonals such as
// MH2 pic 75's (159, 105) -> (1, 0)), whereas Amiga (68000 add.w/cmp.w/sub.w)
// and IIgs (65816 16-bit adc/sbc) use 16-bit word error accumulators that
// reach the endpoint (1, 0).
test("drawLine error accumulator: 8-bit wrap on PC vs 16-bit exact on Amiga and IIgs", () => {
  const stream = new Uint8Array([0xf0, 4, 0xf6, 159, 105, 1, 0, 0xff]);
  const pcSurface = createPictureSurface();
  renderPicture(stream, pcSurface, { profile: PROFILES["2.936"] });
  // Total Y error is 79 + 158 * 105 = 16669 = 105 * 158 + 79. On 8-bit PC,
  // yerror reaches 157 and wraps (157 + 105) & 0xff = 6 at steps 82, 107, 132
  // and 157 (period 25), leaving 16669 - 4 * 256 = 15645 = 99 * 158 + 3
  // (99 Y steps instead of 105), so the line ends at (1, 6) instead of (1, 0).
  assert.equal(pcSurface.visual[6 * 160 + 1], 4);
  assert.equal(pcSurface.visual[0 * 160 + 1], 15);

  for (const id of ["amiga-2.082", "amiga-2.333", "iigs-1.014"] as const) {
    const surface = createPictureSurface();
    renderPicture(stream, surface, { profile: PROFILES[id] });
    assert.equal(surface.visual[0 * 160 + 1], 4, `${id} reaches endpoint (1, 0)`);
    assert.equal(surface.visual[6 * 160 + 1], 15, `${id} does not stop at (1, 6)`);
  }
});

// docs/fidelity.md F-picture-09: 0xf7 relativeDraw clamps wrapped/overflowed Y
// (> 0xa7) to 0xa7 (167) on PC and IIgs, but to 0x9f (159) on all six Amiga
// builds (cmpi.b #$a7, d2; bls ...; move.b #$9f, d2).
test("relativeDraw (0xf7) Y upper clamp: 167 on PC and IIgs vs 159 on Amiga", () => {
  // Start at (10, 0), delta 0x09 (dx = 0, dy = -1 -> (0 - 1) & 0xff = 255 > 167).
  const stream = new Uint8Array([0xf0, 2, 0xf7, 10, 0, 0x09, 0xff]);
  for (const id of ["2.936", "iigs-1.014"] as const) {
    const surface = createPictureSurface();
    renderPicture(stream, surface, { profile: PROFILES[id] });
    assert.equal(surface.visual[159 * 160 + 10], 2, `${id} row 159`);
    assert.equal(surface.visual[167 * 160 + 10], 2, `${id} reaches row 167`);
  }
  for (const id of ["amiga-2.082", "amiga-2.202", "amiga-2.333"] as const) {
    const surface = createPictureSurface();
    renderPicture(stream, surface, { profile: PROFILES[id] });
    assert.equal(surface.visual[159 * 160 + 10], 2, `${id} clamps at row 159`);
    assert.equal(surface.visual[160 * 160 + 10], 15, `${id} stops before row 160`);
    assert.equal(surface.visual[167 * 160 + 10], 15, `${id} does not reach row 167`);
  }
});

// docs/fidelity.md F-picture-09 and the MAME cross-check of SQ2 Amiga picture 2:
// the Amiga clamp (`cmpi.b #$a7,d2; bls; move.b #$9f,d2`) fires only when the
// wrapped y exceeds 167, so a relative step ending on rows 160..167 keeps its row.
test("relativeDraw on Amiga keeps rows 160..167 and clamps only beyond 167", () => {
  // Start (10, 158), delta 0x03 (dx = 0, dy = +3) -> (10, 161).
  const stream = new Uint8Array([0xf0, 2, 0xf7, 10, 158, 0x03, 0xff]);
  const surface = createPictureSurface();
  renderPicture(stream, surface, { profile: PROFILES["amiga-2.202"] });
  for (const y of [158, 159, 160, 161]) assert.equal(surface.visual[y * 160 + 10], 2, `row ${y}`);
  assert.equal(surface.visual[162 * 160 + 10], 15);
});
