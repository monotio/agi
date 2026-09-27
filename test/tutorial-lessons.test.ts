import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTutorial } from "../games/adventure-department/game.ts";
import {
  TUTORIAL_LESSONS,
  verifyMirrorEdit,
  verifyMuralObject,
  verifyStandDepth,
} from "../games/adventure-department/lessons.ts";
import { TUTORIAL_PICTURES } from "../games/adventure-department/sceneArt.ts";
import type { LessonVerifyInput } from "../app/src/lessons/types.ts";
import { openContainer } from "../src/container/container.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { applyEdit, type EditOperation } from "../src/studio/editOperations.ts";
import { compileEditDocument } from "../src/studio/editValidation.ts";
import {
  parsePictureDocument,
  serializePictureDocument,
  type PictureDocument,
} from "../src/studio/pictureDocument.ts";
import { openSprite } from "../src/studio/sprite/spriteDocument.ts";
import { applySpriteEdit, type SpriteEdit } from "../src/studio/sprite/spriteOperations.ts";

const profile = DEFAULT_V2_PROFILE;
const tutorial = openContainer(new Map(Object.entries(buildTutorial().files)));

/** The shipped picture `num` as Room Studio opens it, and the result of editing it with `ops`. */
function pictureEdit(num: number, ...ops: EditOperation[]): LessonVerifyInput {
  const source = TUTORIAL_PICTURES[num]!;
  let document: PictureDocument = parsePictureDocument(source).document;
  for (const op of ops) {
    const result = applyEdit(document, op, { profile });
    if ("error" in result) assert.fail(result.error);
    document = result.document;
  }
  const before = tutorial.getResource("picture", num)!;
  return {
    kind: "picture",
    num,
    before,
    after: compileEditDocument(document, profile).bytes,
    beforeSource: source,
    afterSource: serializePictureDocument(document),
    profile,
  };
}

/** The shipped view `num` as Sprite Studio opens it, and the result of `ops`. */
function viewEdit(num: number, ...ops: SpriteEdit[]): LessonVerifyInput {
  const before = tutorial.getResource("view", num)!;
  let document = openSprite(before, profile);
  for (const op of ops) {
    const result = applySpriteEdit(document, op);
    if ("error" in result) assert.fail(result.error);
    document = result.document;
  }
  return { kind: "view", num, before, after: document.payload, profile };
}

/**
 * A filled depth rectangle added as its own Depth item right after Counter
 * depth, so the walk barriers drawn later still sit on top of it.
 */
function depthRect(num: number, priority: number, x1: number, y1: number, x2: number, y2: number) {
  const { items } = parsePictureDocument(TUTORIAL_PICTURES[num]!).document;
  const counter = items.find(({ id }) => id === "counter-depth")!;
  return {
    type: "insertShape",
    atLine: counter.closeLine + 1,
    shape: { kind: "rect", color: null, priority, filled: true, x1, y1, x2, y2 },
    id: "stand-depth",
    label: "Stand depth",
    kind: "depth",
  } as const satisfies EditOperation;
}

describe("Adventure Department lessons", () => {
  it("one lesson per exhibit, each opening the Studio on the resource behind it", () => {
    assert.equal(TUTORIAL_LESSONS.catalogId, "adventure-department");
    assert.deepEqual(
      TUTORIAL_LESSONS.lessons.map(({ id, open }) => [id, open]),
      [
        ["ad-gallery-recipe", { studio: "room", picture: 4 }],
        ["ad-lab-mirror", { studio: "sprite", view: 2, loop: 1, cel: 0 }],
        ["ad-archive-depth", { studio: "room", picture: 3 }],
      ],
    );
    for (const lesson of TUTORIAL_LESSONS.lessons) {
      assert.ok(lesson.steps.length >= 3, lesson.id);
      assert.ok(lesson.challenge, `${lesson.id} has a challenge`);
    }
    // The picture a lesson opens has the named objects its challenge speaks of.
    const mural = parsePictureDocument(TUTORIAL_PICTURES[4]!).document.items.map(({ id }) => id);
    assert.ok(mural.includes("sun"));
    const archive = parsePictureDocument(TUTORIAL_PICTURES[3]!).document.items;
    assert.ok(archive.some(({ id, kind }) => id === "counter-depth" && kind === "depth"));
    assert.ok(archive.some(({ id, kind }) => id === "ledger-stand" && kind === "art"));
  });

  describe("the mural: change one named object", () => {
    it("passes a new colour for the sun", () => {
      const input = pictureEdit(4, {
        type: "setItemColor",
        itemId: "sun",
        plane: "visual",
        value: 12,
      });
      assert.deepEqual(verifyMuralObject(input), { ok: true });
    });

    it("passes the sun moved across the sky", () => {
      assert.deepEqual(
        verifyMuralObject(pictureEdit(4, { type: "moveItem", itemId: "sun", dx: 3, dy: 0 })),
        {
          ok: true,
        },
      );
    });

    it("fails a sun moved so close to a cloud that it leaves a hole in the sky", () => {
      const verdict = verifyMuralObject(
        pictureEdit(4, { type: "moveItem", itemId: "sun", dx: 5, dy: 1 }),
      );
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /outside Sun changed too/);
    });

    it("fails an edit that also touches another object, naming it", () => {
      const verdict = verifyMuralObject(
        pictureEdit(
          4,
          { type: "setItemColor", itemId: "sun", plane: "visual", value: 12 },
          { type: "setItemColor", itemId: "cottage", plane: "visual", value: 5 },
        ),
      );
      assert.equal(verdict.ok, false);
      assert.equal(verdict.hint, "Only the sun should change — this also changed Cottage.");
    });

    it("fails a change to another object alone", () => {
      const verdict = verifyMuralObject(
        pictureEdit(4, { type: "setItemColor", itemId: "cottage", plane: "visual", value: 5 }),
      );
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /^Only the sun should change, but this changed Cottage\./);
    });

    it("fails a new shape drawn in the meadow", () => {
      const verdict = verifyMuralObject(
        pictureEdit(4, {
          type: "insertShape",
          atLine: parsePictureDocument(TUTORIAL_PICTURES[4]!).document.lines.indexOf("end") + 1,
          shape: {
            kind: "rect",
            color: 4,
            priority: null,
            filled: true,
            x1: 60,
            y1: 66,
            x2: 66,
            y2: 70,
          },
          id: "red-rect",
          label: "Red rect",
          kind: "art",
        }),
      );
      assert.equal(verdict.ok, false);
      assert.equal(verdict.hint, "Only the sun should change — this also added a new shape.");
    });

    it("fails a copy of the sun", () => {
      const verdict = verifyMuralObject(
        pictureEdit(4, {
          type: "duplicateItem",
          itemId: "sun",
          dx: 30,
          dy: 0,
          newId: "sun-2",
          newLabel: "Sun 2",
        }),
      );
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /added a new shape/);
    });

    it("fails the sun deleted", () => {
      const verdict = verifyMuralObject(pictureEdit(4, { type: "deleteItem", itemId: "sun" }));
      assert.equal(verdict.ok, false);
      assert.equal(
        verdict.hint,
        "The sun needs to stay in the sky — change its colour, size or place.",
      );
    });

    it("fails no edit", () => {
      const verdict = verifyMuralObject(pictureEdit(4));
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /Nothing has changed yet/);
    });
  });

  describe("the robot: repaint the mirrored loop only", () => {
    it("passes a new eye colour in loop 1, which becomes its own copy", () => {
      const verdict = verifyMirrorEdit(
        viewEdit(2, { type: "recolor", scope: "loop", loop: 1, from: 14, to: 10 }),
      );
      assert.deepEqual(verdict, { ok: true });
    });

    it("passes one pencil pixel in loop 1's first cel", () => {
      const cel = openSprite(tutorial.getResource("view", 2)!, profile).loops[1]!.cels[0]!;
      const x = cel.width >> 1;
      const y = cel.height >> 1;
      const colour = [4, 2].find((value) => value !== cel.pixels[y * cel.width + x])!;
      const verdict = verifyMirrorEdit(
        viewEdit(2, { type: "setPixels", loop: 1, cel: 0, changes: [{ x, y, color: colour }] }),
      );
      assert.deepEqual(verdict, { ok: true });
    });

    it("fails a blank cel added to loop 1, which repaints nothing", () => {
      const verdict = verifyMirrorEdit(viewEdit(2, { type: "addCel", loop: 1, at: 4 }));
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /keep its 4 cels/);
    });

    it("fails a cel removed from loop 1", () => {
      const verdict = verifyMirrorEdit(viewEdit(2, { type: "deleteCel", loop: 1, cel: 3 }));
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /keep its 4 cels/);
    });

    it("fails a repaint that also adds a cel", () => {
      const verdict = verifyMirrorEdit(
        viewEdit(
          2,
          { type: "recolor", scope: "loop", loop: 1, from: 14, to: 10 },
          { type: "addCel", loop: 1, at: 4, from: { loop: 1, cel: 0 } },
        ),
      );
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /keep its 4 cels/);
    });

    it("fails the same edit carried through to loop 0", () => {
      const verdict = verifyMirrorEdit(
        viewEdit(2, { type: "recolor", scope: "loop", loop: 1, from: 14, to: 10, propagate: true }),
      );
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /loop 0 changed too/);
    });

    it("fails no edit", () => {
      const verdict = verifyMirrorEdit(viewEdit(2));
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /Nothing has changed yet/);
    });
  });

  describe("the archive: give the ledger stand the counter's depth", () => {
    it("passes Counter depth extended over the stand, as its source text", () => {
      const source = TUTORIAL_PICTURES[3]!;
      const extended = source.replace(
        "rect 56,85 118,121\nfill 57,86",
        "rect 56,85 118,121\nfill 57,86\nrect 38,84 53,121\nfill 45,100",
      );
      assert.notEqual(extended, source);
      const after = compileEditDocument(parsePictureDocument(extended).document, profile).bytes;
      const input: LessonVerifyInput = {
        kind: "picture",
        num: 3,
        before: tutorial.getResource("picture", 3)!,
        after,
        beforeSource: source,
        afterSource: extended,
        profile,
      };
      assert.deepEqual(verifyStandDepth(input), { ok: true });
    });

    it("passes a depth-11 region over the stand", () => {
      assert.deepEqual(verifyStandDepth(pictureEdit(3, depthRect(3, 11, 38, 84, 53, 120))), {
        ok: true,
      });
    });

    it("fails depth that also lands elsewhere", () => {
      const verdict = verifyStandDepth(pictureEdit(3, depthRect(3, 11, 38, 60, 100, 120)));
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /away from the ledger stand/);
    });

    it("fails a depth that would hide the apprentice standing in front", () => {
      const verdict = verifyStandDepth(pictureEdit(3, depthRect(3, 12, 38, 84, 53, 120)));
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /closer than 11 \(a bigger number\)/);
    });

    it("fails depth painted over the walk barriers", () => {
      const end = parsePictureDocument(TUTORIAL_PICTURES[3]!).document.lines.indexOf("end") + 1;
      const verdict = verifyStandDepth(
        pictureEdit(3, { ...depthRect(3, 11, 38, 84, 53, 121), atLine: end }),
      );
      assert.equal(verdict.ok, false);
      assert.equal(
        verdict.hint,
        "That covered a walk barrier, so the apprentice could walk through things. Draw the depth earlier: undo, click Counter depth's last command under Commands (or drag the draw order back before the barriers), and draw it again.",
      );
    });

    it("fails a change to the picture itself", () => {
      const verdict = verifyStandDepth(
        pictureEdit(3, { type: "setItemColor", itemId: "ledger-stand", plane: "visual", value: 4 }),
      );
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /depth only/);
    });

    it("fails no edit", () => {
      const verdict = verifyStandDepth(pictureEdit(3));
      assert.equal(verdict.ok, false);
      assert.match(verdict.hint ?? "", /Nothing has changed yet/);
    });
  });
});
