import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AMIGA_FONT } from "../src/render/fontAmiga.ts";

/**
 * Provenance rule (AGENTS.md, docs/fidelity.md "Amiga screen, font and
 * pointer"): the Amiga font is this project's own design to Topaz 8's
 * metrics, never the ROM's bitmaps. With a contributor's Kickstart 1.3 ROM
 * at hand the test decodes the ROM's 8 px Topaz strike and asserts that no
 * printable glyph beyond single-stroke marks coincides with ours. Without
 * the ROM it skips; the ROM is never read at runtime.
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

/** Marks a single stroke draws the same way in any 8×8 font of these metrics. */
const TRIVIAL = new Set([" ", ".", ",", "-", "|", "_", "'", ":", ";", "`", '"', "!", "="]);

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

test("the Amiga font shares no glyph beyond single-stroke marks with the Kickstart Topaz strike", (t) => {
  if (!existsSync(ROM)) return t.skip("no local Kickstart 1.3 ROM");
  const rom = new Uint8Array(readFileSync(ROM));
  assert.equal(rom.length, 262144, "Kickstart 1.3 is 256 KiB");
  const same: string[] = [];
  for (let code = 0x20; code <= 0x7e; code++) {
    const ours = Array.from(AMIGA_FONT.subarray(code * 8, code * 8 + 8));
    if (ours.every((row, y) => row === romGlyph(rom, code)[y]))
      same.push(String.fromCharCode(code));
  }
  assert.deepEqual(
    same.filter((ch) => !TRIVIAL.has(ch)),
    [],
    `glyphs identical to the ROM strike: ${JSON.stringify(same)}`,
  );
});
