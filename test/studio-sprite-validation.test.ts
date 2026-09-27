import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { openSprite, type SpriteDocument } from "../src/view/spriteDocument.ts";
import { applySpriteEdit, type SpriteEdit } from "../src/studio/sprite/spriteOperations.ts";
import { validateSpriteEdit } from "../src/studio/sprite/spriteValidation.ts";
import { mirroredView } from "./studio-sprite-fixture.ts";

const open = () => openSprite(mirroredView(), DEFAULT_V2_PROFILE);

function applied(document: SpriteDocument, op: SpriteEdit): SpriteDocument {
  const result = applySpriteEdit(document, op);
  if ("error" in result) assert.fail(result.error);
  return result.document;
}

const paintLoop0 = (propagate: boolean): SpriteEdit => ({
  type: "setPixels",
  loop: 0,
  cel: 0,
  changes: [{ x: 0, y: 0, color: 7 }],
  propagate,
});

describe("sprite edit validation", () => {
  it("passes a copy-on-write edit and reports the loop it split off", () => {
    const before = open();
    const after = applied(before, paintLoop0(false));
    const result = validateSpriteEdit(before, after, { protectMirrors: true, targetLoops: [0] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedCels, [{ loop: 0, cel: 0, pixels: 1 }]);
    // Loop 0's new block carries no mirror bit; loop 1, alone now, stores its
    // rows as displayed under plain metadata instead of flipped behind it.
    assert.deepEqual(result.metadata, [
      { kind: "mirror-bit", loop: 0, cel: 0, before: true, after: false },
      { kind: "mirror-bit", loop: 0, cel: 1, before: true, after: false },
      { kind: "alias", loop: 1, before: 0, after: null },
      { kind: "mirror-bit", loop: 1, cel: 0, before: true, after: false },
      { kind: "mirror-bit", loop: 1, cel: 1, before: true, after: false },
    ]);
  });

  it("catches an accidental propagation into the mirror", () => {
    const before = open();
    const after = applied(before, paintLoop0(true));
    const result = validateSpriteEdit(before, after, { protectMirrors: true, targetLoops: [0] });
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.violations.map((violation) => violation.constraint),
      ["outside-target", "mirror-propagation"],
    );
    assert.deepEqual(result.violations[0], {
      constraint: "outside-target",
      loop: 1,
      cel: 0,
      pixels: 1,
      message: "1 pixel changed in loop 1, cel 0, outside the edited loop",
    });
    const propagation = result.violations[1];
    assert.ok(propagation?.constraint === "mirror-propagation");
    assert.deepEqual(propagation.loops, [0, 1]);
    assert.deepEqual(result.metadata, []);
  });

  it("reports protected cels and loops, sizes and counts", () => {
    const before = open();
    const painted = applied(before, paintLoop0(true));
    const cel = validateSpriteEdit(before, painted, { protectedCels: [{ loop: 1, cel: 0 }] });
    assert.deepEqual(
      cel.violations.map((violation) => violation.message),
      ["1 pixel changed in protected loop 1, cel 0"],
    );
    // 3x2 grown to 5x3: every pixel of the larger cel counts.
    const resized = applied(before, { type: "resizeCel", loop: 2, cel: 1, width: 5, height: 3 });
    const loop = validateSpriteEdit(before, resized, { protectedLoops: [2] });
    assert.deepEqual(loop.changedCels, [{ loop: 2, cel: 1, pixels: 15 }]);
    assert.equal(loop.violations[0]!.constraint, "protected-loop");
    const deleted = applied(before, { type: "deleteCel", loop: 2, cel: 0 });
    const counts = validateSpriteEdit(before, deleted, { protectedLoops: [2] });
    assert.deepEqual(counts.metadata, [
      { kind: "cel-count", loop: 2, before: 2, after: 1 },
      { kind: "transparent", loop: 2, cel: 0, before: 15, after: 0 },
    ]);
    assert.deepEqual(
      counts.violations.map((violation) => violation.message),
      [
        // Cel 0 is now the old 3x2 cel 1; cel 1 is gone.
        "6 pixels changed in loop 2, cel 0 of protected loop 2",
        "6 pixels changed in loop 2, cel 1 of protected loop 2",
        "protected loop 2 changed cel-count",
        "protected loop 2 changed cel 0's transparent",
      ],
    );
    const added = applied(before, { type: "addLoop", at: 3 });
    assert.deepEqual(validateSpriteEdit(before, added).metadata, [
      { kind: "loop-count", before: 3, after: 4 },
    ]);
  });

  it("counts transparency, not the transparent colour's value", () => {
    const before = open();
    const after = applied(before, { type: "setTransparent", loop: 2, cel: 0, color: 3 });
    const result = validateSpriteEdit(before, after, { protectedCels: [{ loop: 2, cel: 0 }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedCels, []);
    assert.deepEqual(result.metadata, [
      { kind: "transparent", loop: 2, cel: 0, before: 15, after: 3 },
    ]);
  });
});
