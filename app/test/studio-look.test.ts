import assert from "node:assert/strict";
import { test } from "node:test";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../src/types.ts";
import { loadAppearance, PC_APPEARANCE } from "../src/render/appearance.ts";
import { celRgba } from "../src/render/palette.ts";
import { createPresentation } from "../src/play/usePresentation.ts";
import { cropFrameRgba } from "../src/inspector/debugView.ts";
import { paintLayer } from "../src/studio/studioView.ts";
import { thumbRgba } from "../src/world/nodeThumbs.ts";
import { frameToRgb } from "../src/studio/share/shareFrame.ts";
import { pictureReviewPixels } from "../src/agent/workspaceImageReview.ts";
import { drawFrameInto } from "../../src/agent/frames.ts";
import { pictureComparisonPng } from "../../src/agent/pictureFeedback.ts";
import { EGA_TABLE, colourTableForProfile } from "../../src/runtime/colourTables.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { snapImageToEga } from "../../src/creative/imageStyle.ts";
import { nearestEgaIndex, quantizeToEga } from "../../src/view/spritesheet.ts";
import { swatchInk } from "../src/studio/sprite/spriteView.ts";
import { applyPaletteVars, paletteCss, paletteVars } from "../src/render/useGamePalette.ts";
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

test("leaving Create hands Play's chrome back the default colour tokens", async () => {
  const amiga = await loadAppearance("amiga-2.202");
  const style = new Map<string, string>();
  const fake = {
    setProperty: (name: string, value: string) => void style.set(name, value),
    removeProperty: (name: string) => style.delete(name),
  };
  applyPaletteVars(fake, amiga.palette);
  assert.equal(style.size, 16);
  assert.equal(style.get("--agi-13"), "rgb(221 0 255)");
  applyPaletteVars(fake, null);
  assert.equal(style.size, 0);
});

test("map thumbnails show a picture in the game's colours", async () => {
  const amiga = await loadAppearance("amiga-2.202");
  const pixels = new Uint8Array(320 * 168).fill(13);
  assert.deepEqual([...thumbRgba(pixels, amiga.palette).subarray(0, 4)], [0xdd, 0x00, 0xff, 255]);
  assert.deepEqual(
    [...thumbRgba(pixels, PC_APPEARANCE.palette).subarray(0, 4)],
    [0xff, 0x55, 0xff, 255],
  );
});

test("a traced image snaps to the game's own colours, so its nearest colour is what the game shows", async () => {
  const amiga = await loadAppearance("amiga-2.202");
  // Hand-computed: (220, 2, 250) is nearest Amiga 13, d0f, which is (221, 0, 255).
  const source = Uint8Array.of(220, 2, 250, 255, 0, 0, 0, 0);
  assert.deepEqual([...snapImageToEga(source, amiga.palette).subarray(0, 4)], [221, 0, 255, 255]);
  assert.equal(nearestEgaIndex(220, 2, 250, amiga.palette), 13);
  // An Amiga-only colour (0,187,255 is Amiga 9 = 0bf) maps to 9 under the Amiga table, and to a different EGA entry.
  assert.equal(nearestEgaIndex(0, 0xbb, 0xff, amiga.palette), 9);
  assert.notEqual(nearestEgaIndex(0, 0xbb, 0xff), 9);
  const sheet = quantizeToEga(Uint8Array.of(0xbb, 0x77, 0xdd, 255), 1, 1, {
    palette: amiga.palette,
    keyColor: null,
  });
  assert.equal(sheet.pixels[0], 5, "Amiga 5 is b7d");
});

// Exports and the agent's images show what the player sees: Amiga 13 is
// (221, 0, 255), EGA 13 is (255, 85, 255).
test("a shared picture frame is drawn in the game's colours", async () => {
  const amiga = await loadAppearance("amiga-2.202");
  const frame = new Uint8Array(320 * 200).fill(13);
  assert.deepEqual([...frameToRgb(frame, 1, 3, amiga.palette).subarray(0, 3)], [221, 0, 255]);
  assert.deepEqual([...frameToRgb(frame, 1).subarray(0, 3)], [255, 85, 255]);
});

test("the agent's review picture and frames use the game's colours", async () => {
  const amiga = await loadAppearance("amiga-2.202");
  const visual = new Uint8Array(160 * 168).fill(13);
  assert.deepEqual(
    [...pictureReviewPixels(visual, {}, "picture:1", amiga.palette).subarray(0, 4)],
    [221, 0, 255, 255],
  );
  const frame = {
    visual: new Uint8Array(160 * 168).fill(13),
    priority: new Uint8Array(160 * 168),
    picRow: 1,
  };
  const rgb = new Uint8Array(320 * 200 * 3);
  drawFrameInto(frame as never, "visual", rgb, 320, 0, 0, amiga.palette);
  assert.deepEqual([...rgb.subarray(8 * 320 * 3, 8 * 320 * 3 + 3)], [221, 0, 255]);
});

test("agent pictures follow the profile: Amiga bytes differ from EGA, EGA is unchanged", () => {
  const visual = new Uint8Array(160 * 168).fill(13);
  const priority = new Uint8Array(160 * 168).fill(4);
  const plain = pictureComparisonPng(visual, priority);
  assert.deepEqual(pictureComparisonPng(visual, priority, undefined, EGA_TABLE), plain);
  const amiga = pictureComparisonPng(
    visual,
    priority,
    undefined,
    colourTableForProfile(PROFILES["amiga-2.202"]),
  );
  assert.notDeepEqual(amiga, plain);
  assert.deepEqual(colourTableForProfile(PROFILES["amiga-2.202"])[13], [221, 0, 255]);
  assert.deepEqual(colourTableForProfile(PROFILES["iigs-1.014"])[12], [255, 153, 136]);
  assert.deepEqual(colourTableForProfile(PROFILES["2.936"])[13], [255, 85, 255]);
});
