import assert from "node:assert/strict";
import { test } from "node:test";
import { appearanceForProfile, loadAppearance } from "../src/render/appearance.ts";
import { isPlayableFileName } from "../../src/container/playableFiles.ts";

await loadAppearance("iigs-1.014");

test("IIgs colours use the binary's sixteen RGB words in AGI index order", () => {
  const appearance = appearanceForProfile("iigs-1.014")!;
  assert.deepEqual(appearance.palette, [
    [0, 0, 0],
    [0, 0, 255],
    [0, 136, 0],
    [0, 221, 187],
    [204, 0, 0],
    [187, 119, 221],
    [136, 85, 0],
    [187, 187, 187],
    [119, 119, 119],
    [0, 187, 255],
    [0, 238, 0],
    [0, 255, 221],
    [255, 153, 136],
    [221, 153, 255],
    [238, 238, 0],
    [255, 255, 255],
  ]);
  assert.equal(appearanceForProfile("2.936").layout, "pc");
  assert.equal(
    appearanceForProfile("amiga-2.202").layout,
    "pc",
    "an Amiga look is PC until loaded",
  );
});

test("system fonts never enter the canonical playable file set", () => {
  assert.equal(isPlayableFileName("AgiFont"), false);
});

test("IIgs supplies a compact project font without game font files", () => {
  const { font } = appearanceForProfile("iigs-1.014")!;
  assert.equal(font.byteLength, 2048);
  // Own A drawing: seven rows above the baseline, one descender row below.
  assert.deepEqual([...font.subarray(65 * 8, 66 * 8)], [56, 68, 68, 124, 68, 68, 68, 0]);
  assert.equal(font[103 * 8 + 7], 56, "g descends below baseline 7");
  // SQ2 AGIFONT metrics: defined blank glyphs and missing-character coverage.
  const blank = [0, 9, 13, 32, 37, 127, 202, 216];
  const defined = (ch: number) =>
    [0, 9, 13, 17, 18, 19, 20].includes(ch) || (ch >= 32 && ch <= 216);
  const missing = [126, 66, 90, 90, 66, 66, 126, 0]; // project-drawn replacement box
  for (let ch = 0; ch < 256; ch++) {
    const rows = [...font.subarray(ch * 8, (ch + 1) * 8)];
    if (blank.includes(ch)) assert.deepEqual(rows, Array(8).fill(0), `blank ${ch}`);
    else if (!defined(ch)) assert.deepEqual(rows, missing, `missing ${ch}`);
    else assert.ok(rows.some(Boolean), `defined glyph ${ch}`);
  }
});

test("IIgs uses the player's optional font strike with fixed cells and missing glyphs", async () => {
  const { iigsFontFixture } = await import("./iigsFontFixture.ts");
  const bytes = iigsFontFixture();
  const appearance = appearanceForProfile("iigs-1.014", new Map([["AGIFONT", bytes]]))!;
  assert.deepEqual([...appearance.font.subarray(65 * 8, 66 * 8)], [64, 32, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...appearance.font.subarray(66 * 8, 67 * 8)], Array(8).fill(0));
  assert.deepEqual([...appearance.font.subarray(67 * 8, 68 * 8)], [128, 64, 0, 0, 0, 0, 0, 0]);
});

test("missing, truncated and unsupported game fonts fall back without refusing the game", async () => {
  const { iigsFontFixture } = await import("./iigsFontFixture.ts");
  const { readIigsFont } = await import("../src/render/readIigsFont.ts");
  const fallback = appearanceForProfile("iigs-1.014");
  for (let length = 0; length < 70; length++) {
    assert.equal(readIigsFont(iigsFontFixture().subarray(0, length)), undefined);
  }
  // Bad record pointer, unsupported metrics, invalid table offsets and descending locations.
  for (const [at, value] of [
    [0, 0xffff],
    [14, 67],
    [16, 256],
    [18, 9],
    [26, 9],
    [28, 0xffff],
    [30, 8],
    [32, 0],
    [34, 1],
    [36, 0],
    [56, 17],
    [58, 1],
    [66, 0xffff],
  ]) {
    const bytes = iigsFontFixture();
    new DataView(bytes.buffer).setUint16(at!, value!, true);
    assert.equal(readIigsFont(bytes), undefined, `bad field ${at}`);
    assert.equal(appearanceForProfile("iigs-1.014", new Map([["AGIFONT", bytes]])), fallback);
  }
});

test("oversized optional fonts fall back while a 64 KiB strike remains readable", async () => {
  const { iigsFontFixture } = await import("./iigsFontFixture.ts");
  const { readIigsFont } = await import("../src/render/readIigsFont.ts");
  const bytes = new Uint8Array(65_537);
  bytes.set(iigsFontFixture());
  assert.ok(readIigsFont(bytes.subarray(0, 65_536)));
  assert.equal(readIigsFont(bytes), undefined);
});
