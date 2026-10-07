import assert from "node:assert/strict";
import { it } from "node:test";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { compilePictureSource } from "../src/picture/source.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import {
  applyEdit,
  applyEdits,
  type EditOperation,
  type EditOptions,
} from "../src/studio/editOperations.ts";
import { createHistory, record, undo, redo } from "../src/studio/editHistory.ts";
import {
  parsePictureDocument,
  serializePictureDocument,
  type PictureDocument,
} from "../src/studio/pictureDocument.ts";
import { compileDocument } from "../src/studio/pictureQuery.ts";
import { probeActor } from "../src/studio/probe.ts";
import { buildView, parseView, readViewCel } from "../src/view/view.ts";

const profile = PROFILES["2.936"];
const at = (x: number, y: number): number => y * 160 + x;
const doc = (source: string): PictureDocument => {
  const parsed = parsePictureDocument(source);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.document;
};
const bush = doc(`# @item bush "Bush" art
vis 2
pri off
rect 10,54 14,60
fill 12,56
# @end
vis 6
line 30,70 32,70
end`);
function edit(
  document: PictureDocument,
  op: EditOperation,
  options?: EditOptions,
): PictureDocument {
  const result = applyEdit(document, op, options);
  if ("error" in result) assert.fail(result.error);
  return result.document;
}
function rectanglePriority(document: PictureDocument, x: number, y: number, value: number): void {
  const picture = compileDocument(document, profile);
  for (let row = 0; row <= 6; row++) {
    for (let col = 0; col <= 4; col++) assert.equal(picture.priority[at(x + col, y + row)], value);
  }
  assert.equal(picture.priority[at(x - 1, y)], 4);
  assert.equal(picture.priority[at(x + 5, y)], 4);
}
function probe(document: PictureDocument, x: number, baselineY: number, height = 12) {
  const cel = readViewCel(
    parseView(
      buildView({ loops: [{ cels: [{ width: 1, height, pixels: new Array(height).fill(1) }] }] }),
    ),
    0,
    0,
  )!;
  return probeActor({
    picture: compileDocument(document, profile),
    cel,
    x,
    baselineY,
    priority: "band",
    profile,
  });
}

it("stands a filled bush up with exact pixels, bounded bytes and ghost occlusion", () => {
  const stood = edit(bush, { type: "addDepth", itemId: "bush" });
  assert.equal(stood.items[0]!.depth?.baseY, 60);
  // y60 is band6; y59 is band5. The outline and all 15 interior cells share band6.
  rectanglePriority(stood, 10, 54, 6);
  const before = compileDocument(bush, profile);
  const after = compileDocument(stood, profile);
  assert.deepEqual(after.visual, before.visual);
  assert.ok(after.bytes.length - before.bytes.length <= 60);
  assert.equal(probe(stood, 12, 59).hiddenMask[at(12, 59)], 1);
  assert.equal(probe(stood, 12, 61).hiddenMask[at(12, 59)], 0);
  // AGI shares priority within a band; a baseline just above need not be hidden.
  assert.equal(probe(stood, 12, 60).hiddenMask[at(12, 59)], 0);
});

it("stands in the room: the base band plus a wall line along the base, as exact bytes", () => {
  const stood = edit(bush, { type: "standInRoom", itemId: "bush" });
  assert.equal(stood.items[0]!.depth?.baseY, 60);
  assert.equal(stood.items[0]!.depth?.wall, true);
  const expected = doc(`# @item bush "Bush" art
pri off
vis 2
rect 10,54 14,60
fill 12,56
# @depth base=60 wall
vis off
pri 6
line 10,54 14,54
line 10,55 14,55
line 10,56 14,56
line 10,57 14,57
line 10,58 14,58
line 10,59 14,59
line 10,60 14,60
pri 0
line 10,60 14,60
vis 2
pri off
# @depth end
# @end
vis 6
line 30,70 32,70
end`);
  assert.equal(serializePictureDocument(stood), serializePictureDocument(expected));
  assert.deepEqual(
    compileDocument(stood, profile).bytes,
    new Uint8Array([
      0xf3, // pri off (item body)
      0xf0,
      0x02, // vis 2
      0xf6,
      10,
      54,
      14,
      54,
      14,
      60,
      10,
      60,
      10,
      54, // rect outline
      0xf8,
      12,
      56, // fill
      0xf1, // vis off (depth block)
      0xf2,
      0x06, // pri 6: the band of base row 60
      0xf6,
      10,
      54,
      14,
      54,
      0xf6,
      10,
      55,
      14,
      55,
      0xf6,
      10,
      56,
      14,
      56,
      0xf6,
      10,
      57,
      14,
      57,
      0xf6,
      10,
      58,
      14,
      58,
      0xf6,
      10,
      59,
      14,
      59,
      0xf6,
      10,
      60,
      14,
      60,
      0xf2,
      0x00, // pri 0: the wall along the base
      0xf6,
      10,
      60,
      14,
      60,
      0xf0,
      0x02, // vis 2 restored
      0xf3, // pri off restored
      0xf0,
      0x06, // vis 6 (loose tail)
      0xf6,
      30,
      70,
      32,
      70,
      0xff, // end
    ]),
  );
  const picture = compileDocument(stood, profile);
  for (let x = 10; x <= 14; x++) {
    assert.equal(picture.priority[at(x, 60)], 0); // the wall on the base row
    assert.equal(picture.priority[at(x, 59)], 6); // the band above it
  }
  // The wall and band are regenerated together: moving the bush moves both.
  const down = edit(stood, { type: "moveItem", itemId: "bush", dx: 0, dy: 12 });
  assert.equal(down.items[0]!.depth?.baseY, 72);
  assert.equal(down.items[0]!.depth?.wall, true);
  const moved = compileDocument(down, profile);
  for (let x = 10; x <= 14; x++) {
    assert.equal(moved.priority[at(x, 72)], 0);
    assert.equal(moved.priority[at(x, 71)], 7);
  }
});

it("moves, duplicates, deletes and batches derived depth in one history step each", () => {
  const stood = edit(bush, { type: "addDepth", itemId: "bush" });
  const down = edit(stood, { type: "moveItem", itemId: "bush", dx: 0, dy: 12 });
  rectanglePriority(down, 10, 66, 7);
  assert.equal(down.items[0]!.depth?.baseY, 72);
  const up = edit(down, { type: "moveItem", itemId: "bush", dx: 0, dy: -12 });
  assert.deepEqual(compileDocument(up, profile).bytes, compileDocument(stood, profile).bytes);
  const duplicate = edit(down, {
    type: "duplicateItem",
    itemId: "bush",
    dx: 10,
    dy: 12,
    newId: "copy",
    newLabel: "Copy",
  });
  rectanglePriority(duplicate, 10, 66, 7);
  rectanglePriority(duplicate, 20, 78, 8);
  assert.equal(duplicate.items[1]!.depth?.baseY, 84);
  const batch = applyEdits(duplicate, [
    { type: "moveItem", itemId: "bush", dx: 0, dy: -12 },
    { type: "moveItem", itemId: "copy", dx: 0, dy: 12 },
  ]);
  if ("error" in batch) assert.fail(batch.error);
  rectanglePriority(batch.document, 10, 54, 6);
  rectanglePriority(batch.document, 20, 90, 9);
  const removed = edit(duplicate, { type: "deleteItem", itemId: "copy" });
  assert.deepEqual(compileDocument(removed, profile).bytes, compileDocument(down, profile).bytes);
  let history = createHistory(serializePictureDocument(bush));
  for (const next of [stood, down, duplicate, removed]) {
    const result = record(history, "Edit", history.current, serializePictureDocument(next));
    assert.ok(result.ok);
    history = result.history;
  }
  assert.equal(history.past.length, 4);
  for (const expected of [duplicate, down, stood, bush]) {
    const result = undo(history, history.current);
    assert.ok(result.ok);
    history = result.history;
    assert.deepEqual(
      compilePictureSource(result.source).bytes,
      compileDocument(expected, profile).bytes,
    );
  }
  for (const expected of [stood, down, duplicate, removed]) {
    const result = redo(history, history.current);
    assert.ok(result.ok);
    history = result.history;
    assert.equal(result.source, serializePictureDocument(expected));
  }
});

it("keeps hand-painted depth, clears derived markers on manual depth edits and converts back", () => {
  const painted = doc(serializePictureDocument(bush).replace("pri off", "pri 11"));
  const moved = edit(painted, { type: "moveItem", itemId: "bush", dx: 0, dy: 12 });
  rectanglePriority(moved, 10, 66, 11);
  assert.equal(moved.items[0]!.depth, undefined);
  const stood = edit(painted, { type: "addDepth", itemId: "bush" });
  rectanglePriority(stood, 10, 54, 6);
  const manual = edit(stood, {
    type: "setItemColor",
    itemId: "bush",
    plane: "priority",
    value: 12,
  });
  assert.equal(manual.items[0]!.depth, undefined);
  rectanglePriority(edit(manual, { type: "moveItem", itemId: "bush", dx: 0, dy: 12 }), 10, 66, 12);
  const derivedLine = stood.items[0]!.depth!.openLine + 3;
  const pointEdit = edit(stood, {
    type: "setPoint",
    line: derivedLine,
    pointIndex: 0,
    x: 11,
    y: 54,
  });
  assert.equal(pointEdit.items[0]!.depth, undefined);
  rectanglePriority(edit(manual, { type: "addDepth", itemId: "bush" }), 10, 54, 6);
});

it("regenerates reshaped lines and pen pixels, retains chosen baseline offsets and priority base", () => {
  const line = doc('# @item bush "Bush" art\nvis 2\nline 10,58 14,59\n# @end');
  const stood = edit(line, { type: "addDepth", itemId: "bush", baseY: 60 }, { priorityBase: 60 });
  assert.equal(compileDocument(stood, profile).priority[at(14, 59)], 5);
  const shaped = edit(stood, { type: "setPoint", line: 4, pointIndex: 1, x: 14, y: 82 });
  assert.equal(shaped.items[0]!.depth?.baseY, 83);
  assert.equal(shaped.items[0]!.depth?.priorityBase, 60);
  assert.equal(compileDocument(shaped, profile).priority[at(14, 82)], 7);
  const inserted = edit(stood, {
    type: "insertPoint",
    itemId: "bush",
    line: 4,
    pointIndex: 2,
    x: 14,
    y: 82,
  });
  assert.equal(compileDocument(inserted, profile).priority[at(14, 82)], 7);
  const pen = doc('# @item bush "Bush" art\nvis 2\npen 1\nplot 20,71\n# @end');
  const penDepth = edit(pen, { type: "addDepth", itemId: "bush" });
  assert.equal(penDepth.items[0]!.depth?.baseY, 72);
  const rendered = compileDocument(penDepth, profile);
  // v2 radius1: doubled x=39, start x=19; three row words e000
  // select columns 0 and 1, producing x19..20, y70..72.
  const expected = [at(19, 70), at(20, 70), at(19, 71), at(20, 71), at(19, 72), at(20, 72)];
  assert.deepEqual(
    Array.from(rendered.priority.keys()).filter((i) => rendered.priority[i] === 7),
    expected,
  );
  const stub = edit(
    bush,
    { type: "addDepth", itemId: "bush" },
    { profile: PROFILES["amiga-2.310"], priorityBase: 60 },
  );
  rectanglePriority(stub, 10, 54, 6);
});

it("captures item pixels before later art covers them and preserves surrounding registers", () => {
  const covered = doc(
    serializePictureDocument(bush).replace("vis 6", "vis 6\nrect 10,54 14,60\nfill 12,56"),
  );
  const stood = edit(covered, { type: "addDepth", itemId: "bush" });
  rectanglePriority(stood, 10, 54, 6);
  assert.deepEqual(
    compileDocument(stood, profile).visual,
    compileDocument(covered, profile).visual,
  );
});

it("stands Starter Meadow cottage and tree up with probe-visible occlusion", () => {
  const meadow = doc(createStarterProject("starter").sources.pictures.get(1)!);
  const cottage = edit(meadow, { type: "addDepth", itemId: "cottage" });
  assert.equal(cottage.items.find((i) => i.id === "cottage")!.depth?.baseY, 132);
  assert.equal(probe(cottage, 22, 95).hiddenMask[at(22, 90)], 1);
  assert.equal(probe(cottage, 22, 133, 50).hiddenMask[at(22, 90)], 0);
  const tree = edit(cottage, { type: "addDepth", itemId: "tree" });
  assert.equal(tree.items.find((i) => i.id === "tree")!.depth?.baseY, 107);
  assert.equal(probe(tree, 135, 95).hiddenMask[at(135, 90)], 1);
  assert.equal(probe(tree, 135, 108, 25).hiddenMask[at(135, 90)], 0);
  assert.deepEqual(compileDocument(tree, profile).visual, compileDocument(meadow, profile).visual);
});

it("treats Add depth and derived art reshaping as intentional depth changes under lens locks", async () => {
  const { editOperationUnlocks, NO_UNLOCKS, lockedPlanes } =
    await import("../src/studio/lensRules.ts");
  const stood = edit(bush, { type: "addDepth", itemId: "bush" });
  assert.deepEqual(
    lockedPlanes(
      "art",
      editOperationUnlocks(bush, [{ type: "addDepth", itemId: "bush" }], NO_UNLOCKS),
    ),
    [],
  );
  assert.deepEqual(
    lockedPlanes(
      "art",
      editOperationUnlocks(
        stood,
        [{ type: "setPoint", line: 5, pointIndex: 1, x: 14, y: 72 }],
        NO_UNLOCKS,
      ),
    ),
    [],
  );
  assert.deepEqual(
    lockedPlanes(
      "art",
      editOperationUnlocks(
        bush,
        [{ type: "setItemColor", itemId: "bush", plane: "priority", value: 12 }],
        NO_UNLOCKS,
      ),
    ),
    ["priority"],
  );
  assert.deepEqual(
    lockedPlanes(
      "depth",
      editOperationUnlocks(
        stood,
        [{ type: "setPoint", line: 5, pointIndex: 1, x: 14, y: 72 }],
        NO_UNLOCKS,
      ),
    ),
    ["visual"],
  );
});

it("round-trips depth comments, rejects malformed blocks, and refuses invalid or opaque edits atomically", () => {
  const source =
    '# @item a "A" art\r\nvis 2\r\nline 10,60\r\n# @depth base=60 pri-base=50\r\nvis off\r\npri 5\r\nline 10,60\r\nvis 2\r\npri off\r\n# @depth end\r\n# @end';
  assert.equal(serializePictureDocument(doc(source)), source);
  assert.deepEqual(
    compilePictureSource(source).bytes,
    compilePictureSource(source.replace(/# @depth[^\r\n]*/g, "")).bytes,
  );
  for (const body of [
    "# @depth base=168\n# @depth end",
    "# @depth base=60",
    "# @depth end",
    "# @depth base=60 pri-base=168\n# @depth end",
  ]) {
    assert.ok(parsePictureDocument(`# @item a "A" art\n${body}\n# @end`).diagnostics.length > 0);
  }
  for (const [input, op] of [
    [bush, { type: "addDepth", itemId: "bush", baseY: 168 }],
    [bush, { type: "addDepth", itemId: "missing" }],
    [doc('# @item a "A" art locked\nvis 2\nline 10,60\n# @end'), { type: "addDepth", itemId: "a" }],
    [
      doc('# @item a "A" depth\nvis off\npri 8\nline 10,60\n# @end'),
      { type: "addDepth", itemId: "a" },
    ],
    [doc('# @item a "A" art\nvis 2\nraw 246 10 60\n# @end'), { type: "addDepth", itemId: "a" }],
  ] as const) {
    assert.ok("error" in applyEdit(input, op));
  }
  const stood = edit(bush, { type: "addDepth", itemId: "bush", baseY: 166 });
  const bytes = compileDocument(stood, profile).bytes;
  assert.ok("error" in applyEdit(stood, { type: "moveItem", itemId: "bush", dx: 0, dy: 12 }));
  assert.deepEqual(compileDocument(stood, profile).bytes, bytes);
  const again = edit(stood, { type: "addDepth", itemId: "bush", baseY: 166 });
  assert.equal(serializePictureDocument(again), serializePictureDocument(stood));
});

it("preserves inherited visual and priority state and replaces priority-only strokes", () => {
  const painted = doc(
    'vis 2\npri 11\n# @item bush "Bush" mixed\nrect 10,54 14,60\nfill 12,56\nvis off\nline 8,61 16,61\n# @end\nline 30,70 32,70',
  );
  const stood = edit(painted, { type: "addDepth", itemId: "bush" });
  rectanglePriority(stood, 10, 54, 6);
  const compiled = compileDocument(stood, profile);
  for (let x = 8; x <= 16; x++) assert.equal(compiled.priority[at(x, 61)], 4);
  for (let x = 30; x <= 32; x++) assert.equal(compiled.priority[at(x, 70)], 11);
  assert.deepEqual(compiled.visual, compileDocument(painted, profile).visual);
  const recolored = edit(stood, {
    type: "setItemColor",
    itemId: "bush",
    plane: "visual",
    value: 3,
  });
  rectanglePriority(recolored, 10, 54, 6);
  assert.equal(compileDocument(recolored, profile).visual[at(12, 56)], 3);
  assert.equal(compileDocument(recolored, profile).visual[at(9, 54)], 15);
});

it("stands fill-only and stippled items up pixel-exactly", () => {
  const filled = doc('vis 0\nrect 10,54 14,60\n# @item bush "Bush" art\nvis 2\nfill 12,56\n# @end');
  const stood = edit(filled, { type: "addDepth", itemId: "bush" });
  const picture = compileDocument(stood, profile);
  assert.equal(stood.items[0]!.depth?.baseY, 59);
  for (let y = 54; y <= 60; y++)
    for (let x = 10; x <= 14; x++) {
      assert.equal(picture.priority[at(x, y)], x > 10 && x < 14 && y > 54 && y < 60 ? 5 : 4);
    }
  const stipple = doc('# @item bush "Bush" art\nvis 2\npen 1 stipple\nplot 4 20,71\n# @end');
  const depth = edit(stipple, { type: "addDepth", itemId: "bush" });
  // Seed4 starts state5: ba(draw),5d,96(draw),4b,9d,f6(draw).
  const expected = [at(19, 70), at(19, 71), at(20, 72)];
  const rendered = compileDocument(depth, profile);
  assert.deepEqual(
    Array.from(rendered.priority.keys()).filter((i) => rendered.priority[i] === 7),
    expected,
  );
  assert.deepEqual(rendered.visual, compileDocument(stipple, profile).visual);
});

it("lets derived art turn off and back on within the existing recolor operation", () => {
  const stood = edit(bush, { type: "addDepth", itemId: "bush" });
  const off = edit(stood, { type: "setItemColor", itemId: "bush", plane: "visual", value: null });
  assert.equal(off.items[0]!.depth?.baseY, 60);
  rectanglePriority(off, 10, 54, 4);
  const on = edit(off, { type: "setItemColor", itemId: "bush", plane: "visual", value: 2 });
  rectanglePriority(on, 10, 54, 6);
});

it("groups derived items as painted commands until the combined item is stood up", () => {
  const stood = edit(bush, { type: "addDepth", itemId: "bush" });
  const pair = edit(stood, {
    type: "duplicateItem",
    itemId: "bush",
    dx: 10,
    dy: 12,
    newId: "copy",
    newLabel: "Copy",
  });
  const grouped = edit(pair, {
    type: "combineItems",
    itemIds: ["bush", "copy"],
    id: "group",
    label: "Group",
  });
  assert.deepEqual(compileDocument(grouped, profile).bytes, compileDocument(pair, profile).bytes);
  const split = edit(grouped, { type: "ungroupItem", itemId: "group" });
  assert.ok(split.items.every((item) => item.depth === undefined));
  const combined = edit(grouped, { type: "addDepth", itemId: "group" });
  assert.equal(combined.items[0]!.depth?.baseY, 72);
  const separated = edit(combined, { type: "ungroupItem", itemId: "group" });
  assert.deepEqual(
    compileDocument(separated, profile).bytes,
    compileDocument(combined, profile).bytes,
  );
  assert.ok(separated.items.every((item) => item.depth === undefined));
  rectanglePriority(combined, 10, 54, 7);
  rectanglePriority(combined, 20, 66, 7);
  const moved = edit(combined, { type: "moveItem", itemId: "group", dx: 0, dy: 12 });
  rectanglePriority(moved, 10, 66, 8);
  rectanglePriority(moved, 20, 78, 8);
});
