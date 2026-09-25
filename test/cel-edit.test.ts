import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { flipHorizontal, patchedView } from "../src/view/celEdit.ts";
import { buildView, parseView, readViewCel, type BuildCelInput } from "../src/view/view.ts";

const replacement = (pixels: readonly number[]): BuildCelInput => ({
  width: 2,
  height: 1,
  transparentColor: 0,
  pixels,
});

/** Loop 0 carries one 2x1 cel; loop 1 mirrors it. */
const mirroredActor = () =>
  buildView(
    {
      loops: [
        { cels: [{ width: 2, height: 1, transparentColor: 0, pixels: [1, 2] }] },
        { mirrorLoop: 0 },
      ],
    },
    DEFAULT_V2_PROFILE,
  );

describe("cel edit helpers", () => {
  it("flips a cel horizontally, keeping its geometry and transparent color", () => {
    const flipped = flipHorizontal({
      width: 3,
      height: 2,
      transparentColor: 7,
      pixels: [1, 2, 3, 4, 5, 6],
    });
    assert.deepEqual([...flipped.pixels], [3, 2, 1, 6, 5, 4]);
    assert.equal(flipped.width, 3);
    assert.equal(flipped.height, 2);
    assert.equal(flipped.transparentColor, 7);
  });

  it("isolates a mirrored loop before patching it", () => {
    const adjustments: string[] = [];
    const { payload } = patchedView(
      mirroredActor(),
      DEFAULT_V2_PROFILE,
      new Map([[1, new Map([[0, replacement([7, 8])]])]]),
      adjustments,
    );
    const view = parseView(payload, DEFAULT_V2_PROFILE);
    assert.deepEqual([...view.loops[0]!.cels[0]!.pixels], [1, 2]);
    assert.deepEqual([...readViewCel(view, 1, 0)!.pixels], [7, 8]);
    assert.deepEqual([...view.loops[1]!.cels[0]!.pixels], [7, 8]);
    assert.equal(adjustments.length, 1);
    assert.match(adjustments[0]!, /isolated/i);
  });

  it("keeps the untouched alias's pixels when the carrier loop is patched", () => {
    const adjustments: string[] = [];
    const { payload } = patchedView(
      mirroredActor(),
      DEFAULT_V2_PROFILE,
      new Map([[0, new Map([[0, replacement([7, 8])]])]]),
      adjustments,
    );
    const view = parseView(payload, DEFAULT_V2_PROFILE);
    assert.deepEqual([...view.loops[0]!.cels[0]!.pixels], [7, 8]);
    // Copy-on-write: loop 1 keeps the original block's pixels, still rendered
    // mirrored (stored [1,2], displayed flipped).
    assert.deepEqual([...readViewCel(view, 1, 0)!.pixels], [1, 2]);
    assert.deepEqual([...view.loops[1]!.cels[0]!.pixels], [2, 1]);
  });
});
