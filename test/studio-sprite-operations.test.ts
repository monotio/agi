import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_V2_PROFILE, PROFILES } from "../src/runtime/profile.ts";
import { buildView, parseView } from "../src/view/view.ts";
import { openSprite, type SpriteDocument } from "../src/studio/sprite/spriteDocument.ts";
import {
  applySpriteEdit,
  type SpriteEdit,
  type SpriteEditResult,
} from "../src/studio/sprite/spriteOperations.ts";
import { mirroredView } from "./studio-sprite-fixture.ts";

const V2 = DEFAULT_V2_PROFILE;
const open = () => openSprite(mirroredView(), V2);

function applied(document: SpriteDocument, op: SpriteEdit): SpriteDocument {
  const result = applySpriteEdit(document, op);
  if ("error" in result) assert.fail(result.error);
  return result.document;
}

function refused(document: SpriteDocument, op: SpriteEdit, pattern: RegExp): void {
  const result: SpriteEditResult = applySpriteEdit(document, op);
  assert.ok("error" in result, `expected a refusal for ${op.type}`);
  assert.match(result.error, pattern);
}

/** A cel's displayed pixels, both from the document and from its encoded payload. */
function pixels(document: SpriteDocument, loop: number, cel: number): number[] {
  const shown = [...document.loops[loop]!.cels[cel]!.pixels];
  const decoded = parseView(document.payload, V2).loops[loop]!.cels[cel]!;
  assert.deepEqual([...decoded.pixels], shown, `loop ${loop}, cel ${cel} payload`);
  return shown;
}

function size(document: SpriteDocument, loop: number, cel: number): [number, number, number] {
  const { width, height, transparent } = document.loops[loop]!.cels[cel]!;
  return [width, height, transparent];
}

describe("sprite pixel operations", () => {
  it("setPixels paints colours and erases with null", () => {
    const after = applied(open(), {
      type: "setPixels",
      loop: 2,
      cel: 0,
      changes: [
        { x: 0, y: 0, color: 4 },
        { x: 1, y: 1, color: null },
      ],
    });
    // [5,15 / 5,5] with transparent 15.
    assert.deepEqual(pixels(after, 2, 0), [4, 15, 5, 15]);
    assert.deepEqual(pixels(after, 2, 1), [1, 2, 3, 4, 1, 6]);
  });

  it("fillCel floods the 4-connected region only", () => {
    // [1,2,3 / 4,1,6]: the 1 at (1,1) touches (0,0) only diagonally.
    const after = applied(open(), { type: "fillCel", loop: 2, cel: 1, x: 0, y: 0, color: 5 });
    assert.deepEqual(pixels(after, 2, 1), [5, 2, 3, 4, 1, 6]);
    const erased = applied(open(), { type: "fillCel", loop: 2, cel: 0, x: 0, y: 0, color: null });
    // [5,15 / 5,5]: the three 5s are connected through (0,1).
    assert.deepEqual(pixels(erased, 2, 0), [15, 15, 15, 15]);
  });

  it("recolors listed cels, a loop or the whole view", () => {
    const listed = applied(open(), {
      type: "recolor",
      scope: [{ loop: 2, cel: 1 }],
      from: 1,
      to: 6,
    });
    assert.deepEqual(pixels(listed, 2, 1), [6, 2, 3, 4, 6, 6]);
    const loop = applied(open(), { type: "recolor", scope: "loop", loop: 2, from: 5, to: 7 });
    assert.deepEqual(pixels(loop, 2, 0), [7, 15, 7, 7]);
    assert.deepEqual(pixels(loop, 2, 1), [1, 2, 3, 4, 1, 6]);
    // Every member of the mirror pair is recoloured alike, so they keep sharing.
    const result = applySpriteEdit(open(), { type: "recolor", scope: "view", from: 1, to: 9 });
    assert.ok("document" in result);
    const view = result.document;
    assert.deepEqual(result.isolated, []);
    assert.equal(view.loops[1]!.alias, 0);
    assert.deepEqual(pixels(view, 0, 0), [9, 2, 3, 0]);
    assert.deepEqual(pixels(view, 1, 0), [2, 9, 0, 3]);
    assert.deepEqual(pixels(view, 2, 1), [9, 2, 3, 4, 9, 6]);
  });

  it("flips a cel horizontally and vertically", () => {
    const h = applied(open(), { type: "flipCel", loop: 2, cel: 1, axis: "h" });
    assert.deepEqual(pixels(h, 2, 1), [3, 2, 1, 6, 1, 4]);
    const v = applied(open(), { type: "flipCel", loop: 2, cel: 1, axis: "v" });
    assert.deepEqual(pixels(v, 2, 1), [4, 1, 6, 1, 2, 3]);
  });

  it("shifts with wrap-around", () => {
    const right = applied(open(), { type: "shiftCel", loop: 2, cel: 1, dx: 1, dy: 0 });
    assert.deepEqual(pixels(right, 2, 1), [3, 1, 2, 6, 4, 1]);
    const down = applied(open(), { type: "shiftCel", loop: 2, cel: 1, dx: 0, dy: 1 });
    assert.deepEqual(pixels(down, 2, 1), [4, 1, 6, 1, 2, 3]);
    const back = applied(right, { type: "shiftCel", loop: 2, cel: 1, dx: -1, dy: 0 });
    assert.deepEqual(pixels(back, 2, 1), [1, 2, 3, 4, 1, 6]);
  });

  it("resizes around an anchor, bottom-center by default", () => {
    const grown = applied(open(), { type: "resizeCel", loop: 2, cel: 1, width: 5, height: 3 });
    assert.deepEqual(size(grown, 2, 1), [5, 3, 0]);
    // prettier-ignore
    assert.deepEqual(pixels(grown, 2, 1), [
      0, 0, 0, 0, 0,
      0, 1, 2, 3, 0,
      0, 4, 1, 6, 0,
    ]);
    // Bottom-center crop of 3x2 to 1x1 keeps the bottom row's middle pixel.
    const cropped = applied(open(), { type: "resizeCel", loop: 2, cel: 1, width: 1, height: 1 });
    assert.deepEqual(pixels(cropped, 2, 1), [1]);
    const corner = applied(open(), {
      type: "resizeCel",
      loop: 2,
      cel: 1,
      width: 2,
      height: 1,
      anchor: "top-left",
    });
    assert.deepEqual(pixels(corner, 2, 1), [1, 2]);
  });

  it("changes the transparent colour, refusing an opaque clash without remap", () => {
    refused(
      open(),
      { type: "setTransparent", loop: 2, cel: 0, color: 5 },
      /opaque pixels already use colour 5/,
    );
    const remapped = applied(open(), {
      type: "setTransparent",
      loop: 2,
      cel: 0,
      color: 5,
      remap: 7,
    });
    assert.deepEqual(size(remapped, 2, 0), [2, 2, 5]);
    assert.deepEqual(pixels(remapped, 2, 0), [7, 5, 7, 7]);
    const unused = applied(open(), { type: "setTransparent", loop: 2, cel: 0, color: 3 });
    assert.deepEqual(pixels(unused, 2, 0), [5, 3, 5, 5]);
  });
});

describe("sprite cel and loop structure", () => {
  it("adds blank and copied cels", () => {
    const blank = applied(open(), { type: "addCel", loop: 2, at: 1 });
    assert.equal(blank.loops[2]!.cels.length, 3);
    assert.deepEqual(size(blank, 2, 1), [3, 2, 0]);
    assert.deepEqual(pixels(blank, 2, 1), [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(pixels(blank, 2, 2), [1, 2, 3, 4, 1, 6]);
    const copied = applied(open(), { type: "addCel", loop: 2, at: 0, from: { loop: 1, cel: 0 } });
    assert.deepEqual(pixels(copied, 2, 0), [2, 1, 0, 3]);
    assert.deepEqual(pixels(copied, 2, 1), [5, 15, 5, 5]);
  });

  it("deletes and moves cels, refusing to delete the last", () => {
    const deleted = applied(open(), { type: "deleteCel", loop: 2, cel: 0 });
    assert.equal(deleted.loops[2]!.cels.length, 1);
    assert.deepEqual(pixels(deleted, 2, 0), [1, 2, 3, 4, 1, 6]);
    refused(deleted, { type: "deleteCel", loop: 2, cel: 0 }, /last cel/);
    const moved = applied(open(), { type: "moveCel", loop: 2, cel: 0, to: 1 });
    assert.deepEqual(pixels(moved, 2, 0), [1, 2, 3, 4, 1, 6]);
    assert.deepEqual(pixels(moved, 2, 1), [5, 15, 5, 5]);
  });

  it("adds blank, copied and mirrored loops", () => {
    const blank = applied(open(), { type: "addLoop", at: 3 });
    assert.deepEqual(size(blank, 3, 0), [2, 2, 15]);
    assert.deepEqual(pixels(blank, 3, 0), [15, 15, 15, 15]);
    const copy = applied(open(), { type: "addLoop", at: 0, from: 2 });
    assert.equal(copy.loops[0]!.alias, null);
    assert.equal(copy.loops[2]!.alias, 1);
    assert.deepEqual(pixels(copy, 0, 1), [1, 2, 3, 4, 1, 6]);
    assert.deepEqual(pixels(copy, 2, 0), [2, 1, 0, 3]);
    const mirror = applied(open(), { type: "addLoop", at: 3, mirrorOf: 2 });
    assert.equal(mirror.loops[3]!.alias, 2);
    assert.deepEqual(pixels(mirror, 3, 0), [15, 5, 5, 5]);
    assert.deepEqual(pixels(mirror, 3, 1), [3, 2, 1, 6, 1, 4]);
    assert.deepEqual(pixels(mirror, 2, 1), [1, 2, 3, 4, 1, 6]);
  });

  it("deletes a loop, keeping every other loop's display, but never the last", () => {
    // Deleting the carrier leaves its mirror as loop 0, still shown mirrored.
    const after = applied(open(), { type: "deleteLoop", loop: 0 });
    assert.equal(after.loops.length, 2);
    assert.deepEqual(pixels(after, 0, 0), [2, 1, 0, 3]);
    assert.deepEqual(pixels(after, 0, 1), [6, 5, 4, 8, 7, 0]);
    assert.deepEqual(pixels(after, 1, 0), [5, 15, 5, 5]);
    const single = openSprite(
      buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [3] }] }] }),
      V2,
    );
    refused(single, { type: "deleteLoop", loop: 0 }, /last loop/);
  });

  it("unlinks a mirror and links it back to the original bytes", () => {
    const unlinked = applySpriteEdit(open(), { type: "unlinkMirror", loop: 1 });
    assert.ok("document" in unlinked);
    assert.deepEqual(unlinked.isolated, [1]);
    const loose = unlinked.document;
    assert.equal(loose.loops[1]!.alias, null);
    assert.deepEqual(pixels(loose, 1, 0), [2, 1, 0, 3]);
    assert.deepEqual(pixels(loose, 0, 0), [1, 2, 3, 0]);
    refused(loose, { type: "unlinkMirror", loop: 2 }, /does not share/);
    const linked = applied(loose, { type: "linkMirror", loop: 1, of: 0 });
    assert.equal(linked.loops[1]!.alias, 0);
    assert.deepEqual(linked.payload, mirroredView());
  });

  it("links only exact mirror images unless forced", () => {
    refused(open(), { type: "linkMirror", loop: 2, of: 0 }, /not exact mirror images/);
    refused(open(), { type: "linkMirror", loop: 1, of: 0 }, /already shares/);
    const forced = applied(open(), { type: "linkMirror", loop: 2, of: 0, force: true });
    assert.equal(forced.loops[2]!.alias, 0);
    assert.deepEqual(pixels(forced, 2, 0), [2, 1, 0, 3]);
    assert.deepEqual(pixels(forced, 2, 1), [6, 5, 4, 8, 7, 0]);
  });
});

describe("sprite copy-on-write", () => {
  const paint = (loop: number, propagate?: boolean): SpriteEdit => ({
    type: "setPixels",
    loop,
    cel: 0,
    changes: [{ x: 0, y: 0, color: 7 }],
    ...(propagate === undefined ? {} : { propagate }),
  });

  it("isolates an edited mirror and leaves its carrier unchanged", () => {
    const result = applySpriteEdit(open(), paint(1));
    assert.ok("document" in result);
    assert.deepEqual(result.isolated, [1]);
    const after = result.document;
    assert.equal(after.loops[1]!.alias, null);
    assert.deepEqual(pixels(after, 1, 0), [7, 1, 0, 3]);
    assert.deepEqual(pixels(after, 1, 1), [6, 5, 4, 8, 7, 0]);
    assert.deepEqual(pixels(after, 0, 0), [1, 2, 3, 0]);
  });

  it("isolates an edited carrier and leaves its mirror unchanged", () => {
    const result = applySpriteEdit(open(), paint(0));
    assert.ok("document" in result);
    assert.deepEqual(result.isolated, [0]);
    assert.deepEqual(pixels(result.document, 0, 0), [7, 2, 3, 0]);
    assert.deepEqual(pixels(result.document, 1, 0), [2, 1, 0, 3]);
    assert.equal(result.document.loops[1]!.alias, null);
  });

  it("propagates to every alias only when asked, mirrored where the alias mirrors", () => {
    const result = applySpriteEdit(open(), paint(0, true));
    assert.ok("document" in result);
    assert.deepEqual(result.isolated, []);
    const after = result.document;
    assert.equal(after.loops[1]!.alias, 0);
    assert.deepEqual(pixels(after, 0, 0), [7, 2, 3, 0]);
    assert.deepEqual(pixels(after, 1, 0), [2, 7, 0, 3]);
    // Painting the mirror with propagate shows up flipped on the carrier.
    const fromMirror = applied(open(), paint(1, true));
    assert.deepEqual(pixels(fromMirror, 1, 0), [7, 1, 0, 3]);
    assert.deepEqual(pixels(fromMirror, 0, 0), [1, 7, 3, 0]);
  });

  it("propagates structure edits to the shared block", () => {
    const added = applied(open(), { type: "addCel", loop: 1, at: 2, propagate: true });
    assert.equal(added.loops[0]!.cels.length, 3);
    assert.equal(added.loops[1]!.alias, 0);
    const flipped = applied(open(), {
      type: "flipCel",
      loop: 0,
      cel: 1,
      axis: "v",
      propagate: true,
    });
    assert.deepEqual(pixels(flipped, 0, 1), [0, 7, 8, 4, 5, 6]);
    assert.deepEqual(pixels(flipped, 1, 1), [8, 7, 0, 6, 5, 4]);
  });

  it("keeps sharing and mirroring in the packed 2.230 loop header", () => {
    const profile = PROFILES["2.230"];
    const payload = buildView(
      {
        loops: [
          { cels: [{ width: 2, height: 1, transparentColor: 0, pixels: [1, 2] }] },
          { mirrorLoop: 0 },
        ],
      },
      profile,
    );
    const document = openSprite(payload, profile);
    assert.deepEqual([...document.loops[1]!.cels[0]!.pixels], [2, 1]);
    const result = applySpriteEdit(document, paint(0, true));
    assert.ok("document" in result);
    const decoded = parseView(result.document.payload, profile);
    assert.deepEqual([...decoded.loops[0]!.cels[0]!.pixels], [7, 2]);
    assert.deepEqual([...decoded.loops[1]!.cels[0]!.pixels], [2, 7]);
  });

  it("returns the same document for an edit that changes nothing", () => {
    const document = open();
    const result = applySpriteEdit(document, {
      type: "setPixels",
      loop: 1,
      cel: 0,
      changes: [{ x: 0, y: 0, color: 2 }],
    });
    assert.ok("document" in result);
    assert.equal(result.document, document);
  });
});

describe("sprite refusals", () => {
  const cases: [string, SpriteEdit, RegExp][] = [
    ["a loop out of range", { type: "flipCel", loop: 3, cel: 0, axis: "h" }, /loop must be/],
    ["a cel out of range", { type: "flipCel", loop: 2, cel: 2, axis: "h" }, /cel must be/],
    [
      "a pixel outside the cel",
      { type: "setPixels", loop: 2, cel: 0, changes: [{ x: 2, y: 0, color: 1 }] },
      /x must be an integer in 0..1/,
    ],
    [
      "a colour outside 0..15",
      { type: "setPixels", loop: 2, cel: 0, changes: [{ x: 0, y: 0, color: 16 }] },
      /color must be an integer in 0..15/,
    ],
    [
      "an opaque pixel in the transparent colour",
      { type: "setPixels", loop: 2, cel: 0, changes: [{ x: 0, y: 0, color: 15 }] },
      /transparent colour/,
    ],
    [
      "a recolor into the transparent colour",
      { type: "recolor", scope: [{ loop: 2, cel: 1 }], from: 1, to: 0 },
      /transparent colour/,
    ],
    ["a width over 160", { type: "resizeCel", loop: 2, cel: 0, width: 161, height: 1 }, /width/],
    ["a height over 168", { type: "resizeCel", loop: 2, cel: 0, width: 1, height: 169 }, /height/],
    ["a zero width", { type: "resizeCel", loop: 2, cel: 0, width: 0, height: 1 }, /width/],
    [
      "an unknown anchor",
      {
        type: "resizeCel",
        loop: 2,
        cel: 0,
        width: 1,
        height: 1,
        anchor: "feet" as "bottom-center",
      },
      /anchor/,
    ],
    ["both from and mirrorOf", { type: "addLoop", at: 0, from: 1, mirrorOf: 0 }, /not both/],
    ["a self mirror", { type: "linkMirror", loop: 2, of: 2 }, /itself/],
  ];
  for (const [name, op, pattern] of cases)
    it(`refuses ${name}`, () => refused(open(), op, pattern));
});
