import assert from "node:assert/strict";
import { test } from "node:test";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../src/types.ts";
import { loadAppearance, PC_APPEARANCE } from "../src/render/appearance.ts";
import { celRgba } from "../src/render/palette.ts";
import { createPresentation } from "../src/play/usePresentation.ts";
import { cropFrameRgba } from "../src/inspector/debugView.ts";
import { paintLayer } from "../src/studio/studioView.ts";
import { swatchInk } from "../src/studio/sprite/spriteView.ts";
import { paletteCss, paletteVars } from "../src/studio/studioLook.ts";
import type { Frame } from "../src/engine/useEngine.ts";

// Studio draws a game with the colours Play draws it with: a player editing an
// Amiga or Apple IIgs game sees the same picture colours in both places.
// Expected values are hand-computed from docs/fidelity.md's colour tables:
// Amiga 2.202 colour 13 is nibbles d,0,f (x 0x11) and IIgs colour 12 is
// SetColorTable word ff9988; EGA 13 is ff55ff and 12 is ff5555.
const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;

function pane(colour: number, palette?: Parameters<typeof paintLayer>[4]): number[] {
  const out = new Uint8ClampedArray(CELLS * 4);
  paintLayer(
    "art",
    new Uint8Array(CELLS).fill(colour),
    new Uint8Array(CELLS).fill(4),
    out,
    palette,
  );
  return [...out.subarray(0, 4)];
}

test("a picture pane paints PC colours by default and the Amiga table for an Amiga game", async () => {
  const amiga = await loadAppearance("amiga-2.202");
  assert.deepEqual(pane(13), [0xff, 0x55, 0xff, 255]);
  assert.deepEqual(pane(13, amiga.palette), [0xdd, 0x00, 0xff, 255]);
  const early = await loadAppearance("amiga-2.082");
  assert.deepEqual(pane(13, early.palette), [0xff, 0x77, 0x00, 255]);
});

test("a picture pane paints an Apple IIgs game with its own table", async () => {
  const iigs = await loadAppearance("iigs-1.014");
  assert.deepEqual(pane(12, iigs.palette), [0xff, 0x99, 0x88, 255]);
  assert.deepEqual(pane(12), [0xff, 0x55, 0x55, 255]);
});

test("the depth view blends each band's colour from the game's palette", async () => {
  const amiga = await loadAppearance("amiga-2.202");
  const out = new Uint8ClampedArray(CELLS * 4);
  // Depth band 13 only: no art, the band's own colour.
  paintLayer(
    "depth-only",
    new Uint8Array(CELLS).fill(0),
    new Uint8Array(CELLS).fill(13),
    out,
    amiga.palette,
  );
  assert.deepEqual([...out.subarray(0, 4)], [0xdd, 0x00, 0xff, 255]);
});

test("a sprite cel previews in the game's colours", async () => {
  const amiga = await loadAppearance("amiga-2.202");
  const cel = { pixels: new Uint8Array([13, 2]), transparent: 2 };
  const out = new Uint8ClampedArray(8);
  celRgba(cel, out, undefined, amiga.palette);
  assert.deepEqual([...out], [0xdd, 0x00, 0xff, 255, 0, 0, 0, 0]);
  celRgba(cel, out);
  assert.deepEqual([...out.subarray(0, 4)], [0xff, 0x55, 0xff, 255]);
});

test("the inspector magnifier crops in the game's colours", async () => {
  const amiga = await loadAppearance("amiga-2.202");
  const frame = { visual: new Uint8Array(CELLS).fill(13) } as unknown as Frame;
  const crop = cropFrameRgba(frame, 40, 50, 1, frame.visual, amiga.palette);
  assert.deepEqual([...crop.data.subarray(0, 4)], [0xdd, 0x00, 0xff, 255]);
});

test("Studio's colour tokens carry the palette's sixteen entries", async () => {
  const amiga = await loadAppearance("amiga-2.202");
  const vars = paletteVars(amiga.palette);
  assert.equal(Object.keys(vars).length, 16);
  assert.equal(vars["--agi-13"], "rgb(221 0 255)");
  assert.equal(vars["--agi-15"], "rgb(255 255 255)");
  assert.equal(paletteCss(PC_APPEARANCE.palette, 13), "rgb(255 85 255)");
});

test("swatch labels stay legible on every colour of a platform table", async () => {
  const luminance = ([r, g, b]: readonly number[]): number => {
    const lin = (c: number): number =>
      c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4;
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  };
  for (const id of ["amiga-2.202", "amiga-2.310", "iigs-1.014"]) {
    const { palette } = await loadAppearance(id);
    palette.forEach((rgb, colour) => {
      const ink = swatchInk(colour, palette) === "var(--agi-0)" ? 0 : 1;
      const l = luminance(rgb);
      const ratio = ink === 0 ? (l + 0.05) / 0.05 : 1.05 / (l + 0.05);
      assert.ok(ratio >= 4.5, `${id} colour ${colour}: ${ratio.toFixed(2)}`);
    });
  }
});

test("Studio's look follows the presentation when Play selects a platform profile", async () => {
  const presentation = createPresentation();
  assert.equal(presentation.look.value, PC_APPEARANCE);
  presentation.setProfile("iigs-1.014");
  assert.deepEqual(presentation.look.value.palette[12], [0xff, 0x99, 0x88]);
  presentation.setProfile("amiga-2.202");
  const amiga = await loadAppearance("amiga-2.202");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(presentation.look.value, amiga);
  presentation.setProfile(null);
  assert.equal(presentation.look.value, PC_APPEARANCE);
});
