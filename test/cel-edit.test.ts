import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_V2_PROFILE, PROFILES } from "../src/runtime/profile.ts";
import { flipHorizontal, patchedView, viewSpec } from "../src/view/celEdit.ts";
import {
  buildView,
  parseView,
  readViewCel,
  type BuildCelInput,
  type BuildViewInput,
} from "../src/view/view.ts";

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

type LoopProfile = Parameters<typeof parseView>[1];

/** Every loop's displayed cels: geometry, transparent colour, then the pixels. */
const shown = (payload: Uint8Array, profile: LoopProfile) =>
  parseView(payload, profile).loops.map((loop) =>
    loop.cels.map((cel) => [cel.width, cel.height, cel.transparentColor, ...cel.pixels]),
  );

/** A 3x1 cel [1,2,3], transparent 0, as the RLE runs 0x11 0x21 0x31. */
const ROW_123 = [3, 1, 0x11, 0x21, 0x31, 0x00] as const;
const cel321 = { width: 3, height: 1, transparentColor: 0, mirror: false, pixels: [3, 2, 1] };
const cel123 = { ...cel321, pixels: [1, 2, 3] };

/**
 * Two loops sharing one block at 9 whose one cel stores [1,2,3]. `header` is
 * the loop header byte (packed: count | flags), `control` the cel control.
 */
const sharedPair = (header: number, control: number) =>
  // prettier-ignore
  Uint8Array.of(
    0, 0, 2, 0, 0, 9, 0, 9, 0, // two loops, both at 9
    header, 3, 0, // one cel at +3
    ROW_123[0], ROW_123[1], control, ...ROW_123.slice(2),
  );

/**
 * Loops 0 and 1 own 1x1 cels; loops 2 and 3 share the block at 29, whose
 * 3x1 cel stores [1,2,3] under `control` (orientation nibble 0: loop 0).
 */
const sharedLatePair = (control: number) =>
  // prettier-ignore
  Uint8Array.of(
    0, 0, 4, 0, 0, 13, 0, 21, 0, 29, 0, 29, 0,
    1, 3, 0, 1, 1, 0x00, 0x51, 0x00, // loop 0 at 13: [5]
    1, 3, 0, 1, 1, 0x10, 0x61, 0x00, // loop 1 at 21: [6]
    1, 3, 0, ROW_123[0], ROW_123[1], control, ...ROW_123.slice(2), // loops 2, 3 at 29
  );

describe("viewSpec", () => {
  it("rebuilds a payload's stored blocks, aliases as mirror loops", () => {
    const profile = DEFAULT_V2_PROFILE;
    const cel = { width: 2, height: 1, transparentColor: 13, pixels: [1, 13] };
    const input = {
      description: "Pair",
      loops: [{ cels: [cel] }, { mirrorLoop: 0 }, { cels: [{ ...cel, pixels: [4, 5] }] }],
    };
    const payload = buildView(input, profile);
    const spec = viewSpec(payload, profile);
    assert.equal(spec.description, "Pair");
    assert.deepEqual(spec.loops[1], { mirrorLoop: 0 });
    assert.deepEqual([...spec.loops[2]!.cels![0]!.pixels], [4, 5]);
    // The spec builds the same display the payload shows.
    const again = parseView(buildView(spec, profile), profile);
    const shown = parseView(payload, profile);
    assert.deepEqual(
      again.loops.map((loop) => loop.cels.map((c) => [...c.pixels])),
      shown.loops.map((loop) => loop.cels.map((c) => [...c.pixels])),
    );
  });

  it("records a block whose orientation names the member as the owner's display (v2)", () => {
    // Control 0x90: mirrorable, orientation loop 1. Loop 0 shows [3,2,1].
    const payload = sharedPair(1, 0x90);
    assert.deepEqual(shown(payload, DEFAULT_V2_PROFILE), [
      [[3, 1, 0, 3, 2, 1]],
      [[3, 1, 0, 1, 2, 3]],
    ]);
    const spec = viewSpec(payload, DEFAULT_V2_PROFILE);
    assert.deepEqual(spec.loops, [{ cels: [cel321] }, { mirrorLoop: 0 }]);
    const rebuilt = buildView(spec, DEFAULT_V2_PROFILE);
    assert.deepEqual(shown(rebuilt, DEFAULT_V2_PROFILE), shown(payload, DEFAULT_V2_PROFILE));
  });

  it("records a block whose orientation names the member as the owner's display (packed)", () => {
    // Header 0xd1: one cel, mutable and mirrorable, orientation loop 1.
    const packed = PROFILES["2.230"];
    const payload = sharedPair(0xd1, 0x00);
    assert.deepEqual(shown(payload, packed), [[[3, 1, 0, 3, 2, 1]], [[3, 1, 0, 1, 2, 3]]]);
    const spec = viewSpec(payload, packed);
    assert.deepEqual(spec.loops, [{ cels: [cel321] }, { mirrorLoop: 0 }]);
    assert.deepEqual(shown(buildView(spec, packed), packed), shown(payload, packed));
  });

  it("gives loops sharing a block without relative mirroring their own cels", () => {
    // Control 0x00: loops 2 and 3 share the block unmirrored, as several
    // original views do; a mirror loop would flip loop 3.
    const plain = sharedLatePair(0x00);
    const plainSpec = viewSpec(plain, DEFAULT_V2_PROFILE);
    assert.deepEqual(plainSpec.loops.slice(2), [{ cels: [cel123] }, { cels: [cel123] }]);
    assert.deepEqual(
      shown(buildView(plainSpec, DEFAULT_V2_PROFILE), DEFAULT_V2_PROFILE),
      shown(plain, DEFAULT_V2_PROFILE),
    );
    // Control 0x80: mirrorable with orientation loop 0, so both members show
    // the block flipped, again the same way.
    const flipped = sharedLatePair(0x80);
    assert.deepEqual(shown(flipped, DEFAULT_V2_PROFILE).slice(2), [
      [[3, 1, 0, 3, 2, 1]],
      [[3, 1, 0, 3, 2, 1]],
    ]);
    const flippedSpec = viewSpec(flipped, DEFAULT_V2_PROFILE);
    assert.deepEqual(flippedSpec.loops.slice(2), [{ cels: [cel321] }, { cels: [cel321] }]);
    assert.deepEqual(
      shown(buildView(flippedSpec, DEFAULT_V2_PROFILE), DEFAULT_V2_PROFILE),
      shown(flipped, DEFAULT_V2_PROFILE),
    );
  });

  it("is what patchedView records for the bytes it writes", () => {
    // Patching loop 1 isolates it; loop 0 keeps the block and its
    // orientation nibble (loop 1), so it still shows [3,2,1].
    const { payload, spec } = patchedView(
      sharedPair(1, 0x90),
      DEFAULT_V2_PROFILE,
      new Map([[1, new Map([[0, { width: 3, height: 1, pixels: [7, 8, 9] }]])]]),
      [],
    );
    assert.deepEqual(shown(payload, DEFAULT_V2_PROFILE), [
      [[3, 1, 0, 3, 2, 1]],
      [[3, 1, 0, 7, 8, 9]],
    ]);
    const expected: BuildViewInput = viewSpec(payload, DEFAULT_V2_PROFILE);
    assert.deepEqual(spec, expected);
    assert.deepEqual(
      shown(buildView(spec, DEFAULT_V2_PROFILE), DEFAULT_V2_PROFILE),
      shown(payload, DEFAULT_V2_PROFILE),
    );
  });
});
