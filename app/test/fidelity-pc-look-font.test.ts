import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { FONT } from "../src/render/font8x8.ts";

test("PC text recreates BIOS glyph pixels with an eight-pixel advance", () => {
  assert.deepEqual(
    [...FONT.subarray(65 * 8, 66 * 8)],
    [0x1c, 0x36, 0x63, 0x63, 0x7f, 0x63, 0x63, 0],
  );
  assert.deepEqual([...FONT.subarray(103 * 8, 104 * 8)], [0, 0, 0x3b, 0x66, 0x66, 0x3e, 6, 0x7c]);
  assert.deepEqual([...FONT.subarray(95 * 8, 96 * 8)], [0, 0, 0, 0, 0, 0, 0, 255]);
});

// Optional evidence check only. Production and build code never load a ROM.
test("the PC recreation matches every printable BIOS glyph in the local reference", (t) => {
  const path = new URL("../../games/_roms/roms/t1000sx/8040328.u41", import.meta.url);
  if (!existsSync(path)) return t.skip("no local PC BIOS reference");
  const rom = readFileSync(path);
  assert.equal(
    createHash("sha256").update(rom).digest("hex"),
    "4efe075dced3e39616327a0e61b2c59cc48f9d1c0ac2e1ef236bb7cb9f070f46",
  );
  for (let code = 32; code < 128; code++)
    assert.deepEqual(
      [...FONT.subarray(code * 8, code * 8 + 8)],
      [...rom.subarray(0x7a6e + code * 8, 0x7a6e + code * 8 + 8)],
      `character ${code}`,
    );
});

test("PC box characters recreate the double-width BIOS strokes", () => {
  assert.deepEqual([...FONT.subarray(0xb3 * 8, 0xb3 * 8 + 8)], Array(8).fill(0x18));
  assert.deepEqual([...FONT.subarray(0xc4 * 8, 0xc4 * 8 + 8)], [0, 0, 0, 0, 255, 0, 0, 0]);
  assert.deepEqual(
    [...FONT.subarray(0xd6 * 8, 0xd6 * 8 + 8)],
    [0, 0, 0, 0, 0x3f, 0x36, 0x36, 0x36],
  );
});

test("the extended recreation matches the local PC character-generator reference", (t) => {
  const path = new URL("../../games/_roms/roms/t1000sx/bigblue.chr", import.meta.url);
  if (!existsSync(path)) return t.skip("no local PC character reference");
  const rom = readFileSync(path);
  assert.equal(
    createHash("sha256").update(rom).digest("hex"),
    "95481817e59795adf6bc25f817cbbf96b8bc3da7949517638a185c0ad9b5481f",
  );
  const codes = [0xb3, 0xb7, 0xba, 0xbd, 0xc1, 0xc2, 0xc4, 0xd0, 0xd2, 0xd3, 0xd6, 0xff];
  for (const code of codes)
    assert.deepEqual(
      [...FONT.subarray(code * 8, code * 8 + 8)],
      Array.from({ length: 8 }, (_, row) => rom[code + row * 256]),
      `character ${code}`,
    );
});
