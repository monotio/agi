import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseView, selectViewCel } from "../src/view/view.ts";
import { EGA_PALETTE } from "../src/view/spritesheet.ts";
import { convertCharacterSheet, type SheetBitmap } from "../src/view/characterSheet.ts";

/**
 * Hand-drawn sheets: 4 poses x 1 row, 16x12 cells (64x12 total). A pure
 * magenta key background with a solid figure per pose; the figure is a
 * bright-red block bottom-aligned in each cell unless noted.
 *
 * Hand-computed EGA indices (weighted metric 2dR^2+4dG^2+3dB^2, see
 * test/spritesheet.test.ts): #ff00ff -> 13, #ff0000 -> 4.
 *
 * Union bounding box of the default figure: cell-local x 5..10, y 2..11 —
 * 6x10 source pixels. With celHeight 10 and pixelAspect 2 the cels are
 * round(6 * (10/10) / 2) = 3 x 10 logical pixels.
 */

function sheetBitmap(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
): SheetBitmap {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rgba.set(paint(x, y), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

const MAGENTA: readonly [number, number, number, number] = [0xff, 0x00, 0xff, 0xff];
const RED: readonly [number, number, number, number] = [0xff, 0x00, 0x00, 0xff];

interface PoseFigure {
  /** Cell-local left edge of the 6px-wide figure. */
  left: number;
  /** Cell-local top edge; the default figure is 10px tall to the cell bottom. */
  top: number;
  width: number;
  height: number;
}

const DEFAULT_FIGURE: PoseFigure = { left: 5, top: 2, width: 6, height: 10 };

/** A 4-pose row on a magenta key, one figure per 16x12 cell. */
function poseRow(figures: readonly (PoseFigure | null)[] = []): SheetBitmap {
  return sheetBitmap(64, 12, (x, y) => {
    const cell = Math.floor(x / 16);
    const figure = figures[cell] ?? DEFAULT_FIGURE;
    const lx = x - cell * 16;
    if (
      lx >= figure.left &&
      lx < figure.left + figure.width &&
      y >= figure.top &&
      y < figure.top + figure.height
    )
      return [...RED];
    return [...MAGENTA];
  });
}

const SPEC = { poses: 4, celHeight: 10 } as const;

describe("convertCharacterSheet", () => {
  it("rejects a manifest outside the four-to-six pose contract", () => {
    for (const poses of [3, 7, 4.5])
      assert.throws(
        () => convertCharacterSheet({ right: poseRow() }, { poses }),
        /four to six poses/,
      );
  });

  it("requires at least one facing's pose row", () => {
    assert.throws(() => convertCharacterSheet({}, SPEC), /at least one facing/);
  });

  it("rejects a row that does not divide evenly into poses", () => {
    const odd = sheetBitmap(50, 12, () => [...MAGENTA]);
    assert.throws(() => convertCharacterSheet({ right: odd }, SPEC), /does not divide evenly/);
  });

  it("cuts hand-computed cels in right/left/down/up loop order", () => {
    const out = convertCharacterSheet(
      {
        right: poseRow(),
        left: poseRow(),
        down: poseRow(),
        up: poseRow(),
      },
      SPEC,
    );
    assert.equal(out.substitutions.length, 0);
    assert.deepEqual(
      out.loops.map((loop) => loop.facing),
      ["right", "left", "down", "up"],
    );
    for (const loop of out.loops) {
      assert.equal(loop.cels.length, 4);
      for (const cel of loop.cels) assert.deepEqual(cel, { width: 3, height: 10 });
    }
    const parsed = parseView(out.view);
    assert.equal(parsed.loops.length, 4);
    for (const loop of parsed.loops) {
      assert.equal(loop.cels.length, 4);
      assert.equal(loop.cels[0]!.width, 3);
      assert.equal(loop.cels[0]!.height, 10);
      // The key colour encodes as the cel's transparent colour.
      assert.equal(loop.cels[0]!.transparentColor, 13);
      // Every cel pixel is the figure's EGA red.
      assert.ok(loop.cels[0]!.pixels.every((p) => p === 4));
    }
  });

  it("mirrors a missing left facing from the right row only when symmetric", () => {
    const symmetric = convertCharacterSheet({ right: poseRow() }, { ...SPEC, symmetric: true });
    assert.deepEqual(
      symmetric.substitutions.map((s) => s.split(" ")[1]),
      ["left-facing", "down-facing", "up-facing"],
    );
    assert.match(symmetric.substitutions[0]!, /mirrored/);
    assert.match(symmetric.substitutions[1]!, /unmirrored/);
    const parsed = parseView(symmetric.view);
    // Loop 1 reuses loop 0's cel data with the mirror flag — drawn flipped.
    const rightCel = selectViewCel(parsed, 0, 0)!;
    const leftCel = selectViewCel(parsed, 1, 0)!;
    assert.equal(leftCel.mirrored, true);
    assert.equal(leftCel.width, rightCel.width);
    assert.equal(leftCel.height, rightCel.height);

    const asymmetric = convertCharacterSheet({ right: poseRow() }, SPEC);
    const parsedAsymmetric = parseView(asymmetric.view);
    const leftAsym = selectViewCel(parsedAsymmetric, 1, 0)!;
    assert.equal(leftAsym.mirrored ?? false, false);
    assert.ok(asymmetric.substitutions.every((s) => /unmirrored/.test(s)));
  });

  it("reuses the opposite facing unmirrored for missing down/up", () => {
    const out = convertCharacterSheet({ down: poseRow(), up: poseRow() }, SPEC);
    assert.match(out.substitutions[0]!, /right-facing.*unmirrored|No right-facing/);
    assert.match(out.substitutions[1]!, /left-facing/);
    assert.deepEqual(
      out.loops.map((loop) => loop.facing),
      ["right", "left", "down", "up"],
    );
  });

  it("segments alpha-first: real transparency keys nothing, colour-key applies only to opaque input", () => {
    // Alpha-transparent background with a stray magenta figure corner.
    const alpha = sheetBitmap(64, 12, (x, y) => {
      const cell = Math.floor(x / 16);
      const lx = x - cell * 16;
      if (lx >= 5 && lx < 11 && y >= 2 && y < 12) return [0xff, 0x00, 0x00, 0xff];
      return [0x22, 0x22, 0x22, 0x00];
    });
    const out = convertCharacterSheet({ right: alpha }, SPEC);
    const parsed = parseView(out.view);
    const cel = parsed.loops[0]!.cels[0]!;
    assert.notEqual(cel.transparentColor, 4);
    assert.ok(cel.pixels.every((p) => p === 4 || p === cel.transparentColor));
  });

  it("refuses a cel whose opaque pixels use all sixteen colours", () => {
    // Alpha-segmented input: no colour key, so a 4x4 patch covering all 16
    // EGA indices stays fully opaque — no colour is left for transparency.
    const allColors = sheetBitmap(64, 12, (x, y) => {
      const cell = Math.floor(x / 16);
      const lx = x - cell * 16;
      if (lx < 4 && y < 4) {
        const idx = (y * 4 + lx) % 16;
        const [r, g, b] = EGA_PALETTE[idx]!;
        return [r, g, b, 0xff];
      }
      return [0x22, 0x22, 0x22, 0x00];
    });
    assert.throws(() => convertCharacterSheet({ right: allColors }, SPEC), /all 16 EGA colours/);
  });

  it("diagnoses sideways drift, height change and ground-line departure", () => {
    const drifted = poseRow([null, { ...DEFAULT_FIGURE, left: 9 }, null, null]);
    const out = convertCharacterSheet({ right: drifted }, SPEC);
    assert.ok(out.warnings.some((w) => /drifts sideways/.test(w)));

    // 10px vs 6px figures — a 4px spread trips the height diagnostic while
    // the feet stay on the ground line (bottoms 11 vs 11).
    const shorter = poseRow([null, null, { ...DEFAULT_FIGURE, top: 6, height: 6 }, null]);
    const outHeight = convertCharacterSheet({ right: shorter }, SPEC);
    assert.ok(outHeight.warnings.some((w) => /changes height/.test(w)));

    const lifted = poseRow([null, null, null, { ...DEFAULT_FIGURE, top: 0, height: 9 }]);
    const outGround = convertCharacterSheet({ right: lifted }, SPEC);
    assert.ok(outGround.warnings.some((w) => /ground line/.test(w)));
  });
});
