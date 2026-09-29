import assert from "node:assert/strict";
import { test } from "node:test";
import { FONT, HAS_GLYPH } from "../src/render/font8x8.ts";
import { wordmarkRaster } from "../src/ui/wordmark.ts";

/**
 * The boot card draws the wordmark with the interpreter's own 8×8 font: every
 * lit pixel is the font's, and the full stop — the brand's cyan square — is
 * the only accent.
 */
test("the wordmark raster is the engine font, glyph for glyph, with the full stop as accent", () => {
  const text = "AGI IS HERE.";
  const raster = wordmarkRaster(text);
  assert.equal(raster.width, text.length * 8);
  assert.equal(raster.height, 8);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const lit = (FONT[code * 8 + y]! & (0x80 >> x)) !== 0;
        const at = y * raster.width + i * 8 + x;
        const expected = !lit ? 0 : text[i] === "." ? 2 : 1;
        assert.equal(raster.pixels[at], expected, `"${text[i]}" at (${x},${y})`);
      }
    }
  }
  // The full stop is a solid square: 2×2 in font pixels, nothing else accent.
  const accent = [...raster.pixels.entries()].filter(([, v]) => v === 2).map(([i]) => i);
  const xs = new Set(accent.map((i) => i % raster.width));
  const ys = new Set(accent.map((i) => Math.floor(i / raster.width)));
  assert.equal(accent.length, xs.size * ys.size, "accent pixels fill a rectangle");
  assert.equal(xs.size, ys.size, "the rectangle is a square");
});

test("a line without a full stop has no accent, and unknown codes draw blank", () => {
  const blank = HAS_GLYPH.findIndex((has, code) => !has && code > 0x20);
  const raster = wordmarkRaster(`OK${String.fromCharCode(blank)}`);
  assert.equal(raster.width, 24);
  assert.ok(!raster.pixels.includes(2));
  for (let y = 0; y < 8; y++)
    for (let x = 16; x < 24; x++) assert.equal(raster.pixels[y * 24 + x], 0);
});
