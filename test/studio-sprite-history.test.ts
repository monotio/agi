import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { openSprite, type SpriteDocument } from "../src/view/spriteDocument.ts";
import { applySpriteEdit, type SpriteEdit } from "../src/studio/sprite/spriteOperations.ts";
import {
  begin,
  cancelSpriteGesture,
  commit,
  createSpriteHistory,
  recordSpriteEdit,
  redoSprite,
  undoSprite,
} from "../src/studio/sprite/spriteHistory.ts";
import type { EditHistory } from "../src/studio/editHistory.ts";
import { mirroredView } from "./studio-sprite-fixture.ts";

const open = () => openSprite(mirroredView(), DEFAULT_V2_PROFILE);

function applied(document: SpriteDocument, op: SpriteEdit): SpriteDocument {
  const result = applySpriteEdit(document, op);
  if ("error" in result) assert.fail(result.error);
  return result.document;
}

/** Apply and record one edit, returning the new history and document. */
function step(history: EditHistory, document: SpriteDocument, op: SpriteEdit) {
  const after = applied(document, op);
  const recorded = recordSpriteEdit(history, op.type, document, after);
  if (!recorded.ok) assert.fail(recorded.reason);
  return { history: recorded.history, document: after };
}

const displays = (document: SpriteDocument) =>
  document.loops.map((loop) => [loop.alias, ...loop.cels.map((cel) => [...cel.pixels])]);

const paint = (loop: number, color: number, propagate = false): SpriteEdit => ({
  type: "setPixels",
  loop,
  cel: 0,
  changes: [{ x: 0, y: 0, color }],
  propagate,
});

describe("sprite history", () => {
  it("undoes and redoes encoded snapshots, keeping the original", () => {
    const original = open();
    const edited = step(createSpriteHistory(original), original, paint(2, 4));
    const undone = undoSprite(edited.history, edited.document);
    assert.ok(undone.ok);
    assert.deepEqual(undone.document.payload, mirroredView());
    assert.deepEqual(displays(undone.document), displays(original));
    assert.equal(undone.document.original, original.original);
    const redone = redoSprite(undone.history, undone.document);
    assert.ok(redone.ok);
    assert.deepEqual(redone.document.payload, edited.document.payload);
    assert.deepEqual([...redone.document.loops[2]!.cels[0]!.pixels], [4, 15, 5, 5]);
  });

  it("makes a gesture one step and cancels it back", () => {
    const original = open();
    let state = { history: begin(createSpriteHistory(original), "stroke"), document: original };
    state = step(state.history, state.document, paint(2, 4));
    state = step(state.history, state.document, paint(2, 6));
    const committed = commit(state.history);
    assert.equal(committed.past.length, 1);
    const undone = undoSprite(committed, state.document);
    assert.ok(undone.ok);
    assert.deepEqual(undone.document.payload, mirroredView());
    const cancelled = cancelSpriteGesture(state.history, state.document);
    assert.ok(cancelled.ok);
    assert.deepEqual(cancelled.document.payload, mirroredView());
  });

  it("refuses to undo over a sprite changed outside the history", () => {
    const original = open();
    const edited = step(createSpriteHistory(original), original, paint(2, 4));
    const elsewhere = applied(edited.document, paint(2, 6));
    const undone = undoSprite(edited.history, elsewhere);
    assert.equal(undone.ok, false);
    assert.ok(!undone.ok && /the sprite changed outside the edit history/.test(undone.reason));
  });
});

describe("sprite edits and their inverses", () => {
  // Each pair returns to the original display; `bytes` records whether the
  // encoded payload also returns to the original bytes.
  const pairs: [string, SpriteEdit, SpriteEdit, boolean][] = [
    ["paint", paint(2, 4), paint(2, 5), true],
    ["propagated paint", paint(0, 7, true), paint(0, 1, true), true],
    ["isolating paint", paint(1, 7), paint(1, 2), false],
    [
      "horizontal flip",
      { type: "flipCel", loop: 2, cel: 1, axis: "h" },
      { type: "flipCel", loop: 2, cel: 1, axis: "h" },
      true,
    ],
    [
      "shift",
      { type: "shiftCel", loop: 2, cel: 1, dx: 2, dy: 1 },
      { type: "shiftCel", loop: 2, cel: 1, dx: -2, dy: -1 },
      true,
    ],
    [
      "resize",
      { type: "resizeCel", loop: 2, cel: 1, width: 6, height: 4 },
      { type: "resizeCel", loop: 2, cel: 1, width: 3, height: 2 },
      true,
    ],
    [
      "recolor",
      { type: "recolor", scope: "view", from: 1, to: 9 },
      { type: "recolor", scope: "view", from: 9, to: 1 },
      true,
    ],
    [
      "transparent colour",
      { type: "setTransparent", loop: 2, cel: 0, color: 3 },
      { type: "setTransparent", loop: 2, cel: 0, color: 15 },
      true,
    ],
    ["add cel", { type: "addCel", loop: 2, at: 2 }, { type: "deleteCel", loop: 2, cel: 2 }, true],
    [
      "move cel",
      { type: "moveCel", loop: 2, cel: 0, to: 1 },
      { type: "moveCel", loop: 2, cel: 1, to: 0 },
      true,
    ],
    ["add loop", { type: "addLoop", at: 1 }, { type: "deleteLoop", loop: 1 }, true],
    [
      "delete the carrier",
      { type: "deleteLoop", loop: 0 },
      { type: "addLoop", at: 0, mirrorOf: 0 },
      true,
    ],
    ["unlink", { type: "unlinkMirror", loop: 1 }, { type: "linkMirror", loop: 1, of: 0 }, true],
  ];
  for (const [name, edit, inverse, bytes] of pairs)
    it(`${name} then its inverse restores the display${bytes ? " and the bytes" : ""}`, () => {
      const original = open();
      const edited = applied(original, edit);
      assert.notDeepEqual(displays(edited), displays(original));
      const restored = applied(edited, inverse);
      const pixels = (document: SpriteDocument) =>
        document.loops.map((loop) => loop.cels.map((cel) => [...cel.pixels]));
      assert.deepEqual(pixels(restored), pixels(original));
      assert.equal(
        restored.payload.length === original.payload.length &&
          restored.payload.every((byte, i) => byte === original.payload[i]),
        bytes,
      );
    });
});
