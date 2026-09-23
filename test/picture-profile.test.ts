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
