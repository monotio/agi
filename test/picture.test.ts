import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPicture } from "../src/picture/renderer.ts";
import { createPictureSurface, SCREEN_WIDTH, type PictureSurface } from "../src/types.ts";

function render(
  bytes: readonly number[],
  surface: PictureSurface,
  opts?: { overlay?: boolean },
): void {
  renderPicture(new Uint8Array(bytes), surface, opts);
}

/** Visual value at logical (x, y). */
function v(surface: PictureSurface, x: number, y: number): number | undefined {
  return surface.visual[y * SCREEN_WIDTH + x];
}

/** Priority/control value at logical (x, y). */
function p(surface: PictureSurface, x: number, y: number): number | undefined {
  return surface.priority[y * SCREEN_WIDTH + x];
}

test("prepare resets the surface; overlay decodes over existing cells", () => {
  const s = createPictureSurface();
  render([0xf0, 0x03, 0xf6, 0x01, 0x01, 0xff], s);
  assert.equal(v(s, 1, 1), 3);
  // Second render without overlay resets first: (1,1) returns to 15.
  render([0xf0, 0x04, 0xf6, 0x02, 0x02, 0xff], s);
  assert.equal(v(s, 1, 1), 15);
  assert.equal(v(s, 2, 2), 4);
  // Overlay preserves existing cells.
  render([0xf0, 0x05, 0xf6, 0x03, 0x03, 0xff], s, { overlay: true });
  assert.equal(v(s, 2, 2), 4);
  assert.equal(v(s, 3, 3), 5);
});

test("channel enable/disable interplay and raw color operands", () => {
  const s = createPictureSurface();
  render(
    [
      // Raw operand >= 0xf0 is still consumed; low nibble selects the color.
      0xf0,
      0xfa,
      0xf6,
      0x01,
      0x01, // visual 10 at (1,1)
      0xf1, // disable visual
      0xf2,
      0xf9,
      0xf6,
      0x02,
      0x02, // priority 9 at (2,2); visual preserved
      0xf3, // disable priority
      0xf6,
      0x03,
      0x03, // neither channel enabled: no write
      0xff,
    ],
    s,
  );
  assert.equal(v(s, 1, 1), 10);
  assert.equal(p(s, 1, 1), 4); // priority untouched while only visual enabled
  assert.equal(p(s, 2, 2), 9);
  assert.equal(v(s, 2, 2), 15); // visual preserved while disabled
  assert.equal(v(s, 3, 3), 15);
  assert.equal(p(s, 3, 3), 4);
});

test("bytes below 0xf0 at command boundaries are ignored", () => {
  const s = createPictureSurface();
  render([0x09, 0x09, 0xf0, 0x02, 0x07, 0xf6, 0x03, 0x03, 0xff], s);
  assert.equal(v(s, 3, 3), 2);
  // Only the single plotted point changed.
  assert.equal(v(s, 0, 0), 15);
});

test("partial pair draws nothing and leaves the command byte pending", () => {
  const s = createPictureSurface();
  render(
    [
      0xf0,
      0x00, // visual 0
      0xf6,
      0x05, // absolute line: X=5 accepted, next byte 0xf2 ends the command
      0xf2,
      0x06, // pending command: enable priority 6
      0xf6,
      0x05,
      0x05, // plot (5,5): both channels now enabled
      0xff,
    ],
    s,
  );
  // The partial pair drew nothing: no visual-0 pixel anywhere along the way.
  assert.equal(v(s, 5, 0), 15);
  assert.equal(v(s, 5, 5), 0);
  assert.equal(p(s, 5, 5), 6);
});

test("diagonal (0,0)->(3,1) plots exactly (0,0),(1,0),(2,1),(3,1)", () => {
  const s = createPictureSurface();
  render([0xf0, 0x00, 0xf6, 0x00, 0x00, 0x03, 0x01, 0xff], s);
  assert.equal(v(s, 0, 0), 0);
  assert.equal(v(s, 1, 0), 0);
  assert.equal(v(s, 2, 1), 0);
  assert.equal(v(s, 3, 1), 0);
  // The cells a Bresenham variant would choose differently stay untouched.
  assert.equal(v(s, 2, 0), 15);
  assert.equal(v(s, 1, 1), 15);
  assert.equal(v(s, 3, 0), 15);
});

test("absolute polyline connects successive points", () => {
  const s = createPictureSurface();
  render([0xf0, 0x01, 0xf6, 0x00, 0x00, 0x03, 0x00, 0x03, 0x02, 0xff], s);
  for (const x of [0, 1, 2, 3]) assert.equal(v(s, x, 0), 1);
  for (const y of [0, 1, 2]) assert.equal(v(s, 3, y), 1);
  assert.equal(v(s, 2, 1), 15);
  assert.equal(v(s, 4, 0), 15);
});

test("y-corner and x-corner alternate vertical/horizontal segments", () => {
  const s = createPictureSurface();
  render(
    [
      // y-corner: plot (5,5), then Y=10 (vertical), X=12 (horizontal), Y=2 (vertical down).
      0xf0, 0x00, 0xf4, 0x05, 0x05, 0x0a, 0x0c, 0x02,
      // x-corner: plot (1,1), then X=4 (horizontal), Y=3 (vertical).
      0xf0, 0x01, 0xf5, 0x01, 0x01, 0x04, 0x03, 0xff,
    ],
    s,
  );
  // y-corner expectations (color 0).
  for (let y = 5; y <= 10; y++) assert.equal(v(s, 5, y), 0);
  for (let x = 5; x <= 12; x++) assert.equal(v(s, x, 10), 0);
  for (let y = 2; y <= 10; y++) assert.equal(v(s, 12, y), 0);
  assert.equal(v(s, 12, 11), 15);
  assert.equal(v(s, 12, 1), 15);
  assert.equal(v(s, 6, 5), 15);
  // x-corner expectations (color 1).
  for (let x = 1; x <= 4; x++) assert.equal(v(s, x, 1), 1);
  for (let y = 1; y <= 3; y++) assert.equal(v(s, 4, y), 1);
  assert.equal(v(s, 4, 4), 15);
  assert.equal(v(s, 5, 1), 15);
});

test("relative line: subtraction wraps modulo 256 then upper-clamps", () => {
  const s = createPictureSurface();
  render(
    [
      0xf0, 0x00,
      // From (0,0): delta 0x90 = subtract X by 1, Y by 0.
      // X becomes (0-1) mod 256 = 255, clamped to 159: horizontal line across row 0.
      0xf7, 0x00, 0x00, 0x90,
      // From (159,0) back to (0,0), then delta 0x09 = subtract Y by 1:
      // Y becomes 255, clamped to 167: vertical line down column 0.
      0xf7, 0x00, 0x00, 0x09, 0xff,
    ],
    s,
  );
  for (let x = 0; x <= 159; x++) assert.equal(v(s, x, 0), 0);
  for (let y = 0; y <= 167; y++) assert.equal(v(s, 0, y), 0);
  assert.equal(v(s, 1, 1), 15);
});

test("positive relative deltas move by the packed magnitudes", () => {
  const s = createPictureSurface();
  // From (10,10): delta 0x32 = +3 X, +2 Y -> line to (13,12).
  render([0xf0, 0x02, 0xf7, 0x0a, 0x0a, 0x32, 0xff], s);
  assert.equal(v(s, 10, 10), 2);
  assert.equal(v(s, 13, 12), 2);
  assert.equal(v(s, 14, 12), 15);
  assert.equal(v(s, 13, 13), 15);
});

test("seed fill fills a bounded region with the visual channel enabled", () => {
  const s = createPictureSurface();
  render(
    [
      // Visual 2 rectangle outline (2,2)-(6,5).
      0xf0, 0x02, 0xf6, 0x02, 0x02, 0x06, 0x02, 0x06, 0x05, 0x02, 0x05, 0x02, 0x02,
      // Fill the interior from seed (4,3).
      0xf8, 0x04, 0x03, 0xff,
    ],
    s,
  );
  for (let y = 2; y <= 5; y++) {
    for (let x = 2; x <= 6; x++) assert.equal(v(s, x, y), 2, `(${x},${y})`);
  }
  assert.equal(v(s, 1, 1), 15);
  assert.equal(v(s, 7, 3), 15);
  assert.equal(v(s, 4, 1), 15);
  assert.equal(v(s, 4, 6), 15);
});

test("seed fill with both channels enabled: visual connectivity, both written", () => {
  const s = createPictureSurface();
  render(
    [
      // Visual-only border (2,2)-(6,5) in color 2.
      0xf0, 0x02, 0xf6, 0x02, 0x02, 0x06, 0x02, 0x06, 0x05, 0x02, 0x05, 0x02, 0x02,
      // Now visual 3 AND priority 6; fill from (4,3).
      0xf0, 0x03, 0xf2, 0x06, 0xf8, 0x04, 0x03, 0xff,
    ],
    s,
  );
  // Interior: both channels written.
  assert.equal(v(s, 4, 3), 3);
  assert.equal(p(s, 4, 3), 6);
  assert.equal(v(s, 3, 4), 3);
  assert.equal(p(s, 3, 4), 6);
  // Border: visual 2, priority never written (fill connectivity is visual,
  // so the fill does not leak past the border into the priority-4 outside).
  assert.equal(v(s, 2, 2), 2);
  assert.equal(p(s, 2, 2), 4);
  assert.equal(v(s, 0, 0), 15);
  assert.equal(p(s, 0, 0), 4);
  assert.equal(v(s, 7, 3), 15);
  assert.equal(p(s, 7, 3), 4);
});

test("seed fill no-effect cases", () => {
  // Neither channel enabled: no effect.
  const s1 = createPictureSurface();
  render([0xf8, 0x00, 0x00, 0xff], s1);
  assert.equal(v(s1, 0, 0), 15);
  assert.equal(p(s1, 0, 0), 4);

  // Selected visual value equals the target (15): no effect.
  const s2 = createPictureSurface();
  render([0xf0, 0x0f, 0xf8, 0x00, 0x00, 0xff], s2);
  assert.equal(v(s2, 0, 0), 15);

  // Selected priority value equals the target (4): no effect.
  const s3 = createPictureSurface();
  render([0xf2, 0x04, 0xf8, 0x00, 0x00, 0xff], s3);
  assert.equal(p(s3, 0, 0), 4);

  // Seed not on the target value: border cell holds 2, not 15.
  const s4 = createPictureSurface();
  render(
    [
      0xf0,
      0x02,
      0xf6,
      0x02,
      0x02,
      0x06,
      0x02,
      0x06,
      0x05,
      0x02,
      0x05,
      0x02,
      0x02,
      0xf8,
      0x02,
      0x02, // seed on the border itself
      0xff,
    ],
    s4,
  );
  assert.equal(v(s4, 4, 3), 15); // interior untouched
});

test("pattern radius 1 (v2) produces a 2 wide by 3 tall block", () => {
  const s = createPictureSurface();
  render([0xf0, 0x04, 0xf9, 0x01, 0xfa, 0x0a, 0x0a, 0xff], s);
  // doubled_x = 20-1 = 19 -> start_x = 9; start_y = 10-1 = 9.
  for (const y of [9, 10, 11]) {
    for (const x of [9, 10]) assert.equal(v(s, x, y), 4, `(${x},${y})`);
  }
  for (const [x, y] of [
    [8, 9],
    [11, 9],
    [9, 8],
    [10, 8],
    [9, 12],
    [10, 12],
  ] as const) {
    assert.equal(v(s, x, y), 15, `(${x},${y}) untouched`);
  }
});

test("stipple is deterministic per seed and restarts for every plot", () => {
  // Hand-computed LFSR from seed 0x04 (state = 5), six candidates of a
  // radius-1 plot in row-major order:
  //   5 -> ba (write) -> 5d -> 96 (write) -> 4b -> 9d -> f6 (write)
  // Writes land on candidates 0, 2, 5: (x0,y0), (x0,y0+1), (x0+1,y0+2).
  const s = createPictureSurface();
  render(
    [
      0xf0,
      0x04,
      0xf9,
      0x21, // visual 4; mode 0x21 = radius 1 + stipple
      0xfa,
      0x04,
      0x0a,
      0x0a, // seed 4, plot at (10,10) -> start (9,9)
      0x04,
      0x14,
      0x14, // seed 4, plot at (20,20) -> start (19,19)
      0xff,
    ],
    s,
  );
  for (const [sx, sy] of [
    [9, 9],
    [19, 19],
  ] as const) {
    assert.equal(v(s, sx, sy), 4, `(${sx},${sy})`);
    assert.equal(v(s, sx + 1, sy), 15);
    assert.equal(v(s, sx, sy + 1), 4);
    assert.equal(v(s, sx + 1, sy + 1), 15);
    assert.equal(v(s, sx, sy + 2), 15);
    assert.equal(v(s, sx + 1, sy + 2), 4);
  }
});

test("raw 0xf9 mode byte >= 0xf0 is consumed (stipple + bypass, radius 0)", () => {
  const s = createPictureSurface();
  // Mode 0xf0: radius 0, bypass mask, stipple. Seed 0x04 -> state 5 -> 0xba:
  // bit0 clear, bit1 set -> the single radius-0 candidate at (5,5) is written.
  render([0xf0, 0x06, 0xf9, 0xf0, 0xfa, 0x04, 0x05, 0x05, 0xff], s);
  assert.equal(v(s, 5, 5), 6);
});

test("pattern candidate at calculated X=160 wraps to the next row's X 0", () => {
  const s = createPictureSurface();
  render(
    [
      0xf0,
      0x07,
      0xf9,
      0x12, // visual 7; mode 0x12 = radius 2 + bypass mask
      // Plot at (159,5): doubled_x = 316 (at the 320-2r limit), start_x = 158,
      // start_y = 3. Each row's third candidate has calculated X 160 and wraps
      // to logical (0, row+1).
      0xfa,
      0x9f,
      0x05,
      // Plot at (159,167): start_y clamps to 163; the last row's wrapped
      // candidate lands at linear index 160*168, beyond the surface: no effect.
      0x9f,
      0xa7,
      0xff,
    ],
    s,
  );
  // First plot: normal candidates.
  for (let y = 3; y <= 7; y++) {
    assert.equal(v(s, 158, y), 7, `(158,${y})`);
    assert.equal(v(s, 159, y), 7, `(159,${y})`);
  }
  // Wrapped candidates: (0,4)..(0,8).
  for (let y = 4; y <= 8; y++) assert.equal(v(s, 0, y), 7, `(0,${y})`);
  // The wrap hits exactly column 0: no smear to (1,y), no same-row write.
  assert.equal(v(s, 1, 4), 15);
  assert.equal(v(s, 0, 3), 15);
  assert.equal(v(s, 157, 3), 15);
  // Second plot: last row's in-bounds candidates written; the beyond-surface
  // wrap candidate silently dropped (no crash, no stray write).
  assert.equal(v(s, 158, 167), 7);
  assert.equal(v(s, 159, 167), 7);
  for (let y = 164; y <= 167; y++) assert.equal(v(s, 0, y), 7, `(0,${y})`);
});

test("miniature room: walls, floor line, and interior fill", () => {
  const s = createPictureSurface();
  render(
    [
      // Walls: visual 1 rectangle outline (10,10)-(40,30).
      0xf0, 0x01, 0xf6, 0x0a, 0x0a, 0x28, 0x0a, 0x28, 0x1e, 0x0a, 0x1e, 0x0a, 0x0a,
      // Interior fill: visual 14 from seed (25,20).
      0xf0, 0x0e, 0xf8, 0x19, 0x14,
      // Floor line: visual 5, horizontal y=25 from x=10 to x=40.
      0xf0, 0x05, 0xf6, 0x0a, 0x19, 0x28, 0x19, 0xff,
    ],
    s,
  );
  for (let y = 10; y <= 30; y++) {
    for (let x = 10; x <= 40; x++) {
      const onFloor = y === 25;
      const onWall = !onFloor && (y === 10 || y === 30 || x === 10 || x === 40);
      const expected = onFloor ? 5 : onWall ? 1 : 14;
      assert.equal(v(s, x, y), expected, `(${x},${y})`);
    }
  }
  // Outside the room everything stays at the prepared 15.
  for (const [x, y] of [
    [0, 0],
    [9, 20],
    [41, 20],
    [20, 9],
    [20, 31],
  ] as const) {
    assert.equal(v(s, x, y), 15, `(${x},${y}) outside`);
  }
});
