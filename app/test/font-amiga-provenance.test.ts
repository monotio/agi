import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AMIGA_FONT } from "../src/render/fontAmiga.ts";

/**
 * Fidelity rule (AGENTS.md, docs/fidelity.md "Amiga screen, font and
 * pointer"): the Amiga font is a recreation of the Topaz 8 bitmap design,
 * kept as this project's own table and matched pixel for pixel. With a
 * contributor's Kickstart 1.3 ROM at hand the test decodes the ROM's 8 px
 * Topaz strike and asserts that every printable glyph equals ours. Without
 * the ROM it skips; the ROM is never read at build or run time.
 */
const ROM = join(
  fileURLToPath(new URL("../../games/_roms/roms/a500n/", import.meta.url)),
  "315093-02.u2",
);
/** Kickstart 1.3 (315093-02): the topaz 8 strike, its byte stride and its CharLoc table. */
const STRIKE = 0x9134;
const STRIDE = 0xc0;
const CHAR_LOC = 0x9734;
const LO_CHAR = 32;

function romGlyph(rom: Uint8Array, code: number): number[] {
  const at = CHAR_LOC + 4 * (code - LO_CHAR);
  const offset = (rom[at]! << 8) | rom[at + 1]!;
  const width = (rom[at + 2]! << 8) | rom[at + 3]!;
  const rows: number[] = [];
  for (let y = 0; y < 8; y++) {
    let bits = 0;
    for (let x = 0; x < Math.min(width, 8); x++) {
      const bit = offset + x;
      if (rom[STRIKE + y * STRIDE + (bit >> 3)]! & (0x80 >> (bit & 7))) bits |= 0x80 >> x;
    }
    rows.push(bits);
  }
  return rows;
}

test("the Amiga font matches the Kickstart Topaz 8 strike pixel for pixel", (t) => {
  if (!existsSync(ROM)) return t.skip("no local Kickstart 1.3 ROM");
  const rom = new Uint8Array(readFileSync(ROM));
  assert.equal(rom.length, 262144, "Kickstart 1.3 is 256 KiB");
  const differing: string[] = [];
  for (let code = 0x20; code <= 0x7e; code++) {
    const ours = Array.from(AMIGA_FONT.subarray(code * 8, code * 8 + 8));
    const theirs = romGlyph(rom, code);
    if (!ours.every((row, y) => row === theirs[y]))
      differing.push(
        `${JSON.stringify(String.fromCharCode(code))}: ours ${ours.map((b) => b.toString(16).padStart(2, "0")).join("")}, ROM ${theirs.map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      );
  }
  assert.deepEqual(differing, [], "glyphs that differ from the ROM strike");
});
