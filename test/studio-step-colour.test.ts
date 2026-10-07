import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compilePictureSource } from "../src/picture/source.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { applyEdit, applyEdits, type EditOperation } from "../src/studio/editOperations.ts";
import {
  parsePictureDocument,
  serializePictureDocument,
  type PictureDocument,
} from "../src/studio/pictureDocument.ts";
import { compileDocument } from "../src/studio/pictureQuery.ts";

const profile = PROFILES["2.936"];
const at = (x: number, y: number): number => y * 160 + x;
const doc = (source: string): PictureDocument => {
  const parsed = parsePictureDocument(source);
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.document;
};
function edit(document: PictureDocument, op: EditOperation): PictureDocument {
  const result = applyEdit(document, op, { profile });
  if ("error" in result) assert.fail(result.error);
  return result.document;
}
const bytes = (source: string): number[] => [...compilePictureSource(source, { profile }).bytes];

/**
 * A sky fill under a cottage; the sky's fill is the step the bucket clicked.
 * line 3 is the painting command, line 2 the colour it reads.
 */
const ROOM = `# @item sky "Sky" art
vis 11
fill 80,20
# @end
# @item cottage "Cottage" art
vis 4
rect 40,80 60,100
# @end
end
`;

describe("setStepColor: recolour the one step that painted a cell", () => {
  it("wraps the step with the new colour and a restore, bytes hand-computed", () => {
    const after = edit(doc(ROOM), {
      type: "setStepColor",
      line: 3,
      plane: "visual",
      value: 9,
    });
    const source = serializePictureDocument(after);
    assert.equal(
      source,
      `# @item sky "Sky" art
vis 11
vis 9
fill 80,20
# @end
# @item cottage "Cottage" art
vis 4
rect 40,80 60,100
# @end
end
`,
    );
    // F0 11 (vis 11), F0 9 (vis 9), F8 80 20 (fill), F0 4 (the cottage sets its
    // own colour, so no restore is needed), F6 rect outline, FF.
    assert.deepEqual(
      bytes(source),
      [
        0xf0, 11, 0xf0, 9, 0xf8, 80, 20, 0xf0, 4, 0xf6, 40, 80, 60, 80, 60, 100, 40, 100, 40, 80,
        0xff,
      ],
    );
    const compiled = compileDocument(after, profile);
    // Everything the fill painted is now light blue; the cottage outline is untouched.
    assert.equal(compiled.visual[at(0, 0)], 9);
    assert.equal(compiled.visual[at(50, 90)], 9);
    assert.equal(compiled.visual[at(40, 80)], 4);
  });

  it("recolours a step inside a multi-colour item without touching its siblings", () => {
    const pair = `# @item house "House" art
vis 8
rect 10,10 20,20
vis 6
line 30,30 40,30
# @end
end
`;
    const after = edit(doc(pair), {
      type: "setStepColor",
      line: 3,
      plane: "visual",
      value: 2,
    });
    const source = serializePictureDocument(after);
    assert.equal(
      source,
      `# @item house "House" art
vis 8
vis 2
rect 10,10 20,20
vis 6
line 30,30 40,30
# @end
end
`,
    );
    const compiled = compileDocument(after, profile);
    assert.equal(compiled.visual[at(15, 10)], 2);
    assert.equal(compiled.visual[at(15, 15)], 15); // the outline's inside stays white
    assert.equal(compiled.visual[at(35, 30)], 6);
  });

  it("recolours a priority step on the priority plane", () => {
    const source = `# @item wall "Wall" walk
pri 0
line 10,100 30,100
# @end
end
`;
    const after = edit(doc(source), {
      type: "setStepColor",
      line: 3,
      plane: "priority",
      value: 2,
    });
    const compiled = compileDocument(after, profile);
    for (let x = 10; x <= 30; x++) assert.equal(compiled.priority[at(x, 100)], 2);
  });

  it("is a no-op at the same colour and refuses non-steps, off planes and locked items", () => {
    const same = edit(doc(ROOM), {
      type: "setStepColor",
      line: 3,
      plane: "visual",
      value: 11,
    });
    assert.equal(serializePictureDocument(same), serializePictureDocument(doc(ROOM)));
    for (const op of [
      { type: "setStepColor", line: 2, plane: "visual", value: 1 },
      { type: "setStepColor", line: 1, plane: "visual", value: 1 },
      { type: "setStepColor", line: 99, plane: "visual", value: 1 },
      { type: "setStepColor", line: 3, plane: "priority", value: 1 },
      { type: "setStepColor", line: 3, plane: "visual", value: 16 },
    ] as const) {
      assert.ok(
        "error" in applyEdit(doc(ROOM), op as EditOperation, { profile }),
        `line ${op.line}`,
      );
    }
    const locked = doc(`# @item sky "Sky" art locked
vis 11
fill 80,20
# @end
end
`);
    assert.ok(
      "error" in
        applyEdit(
          locked,
          { type: "setStepColor", line: 3, plane: "visual", value: 9 },
          { profile },
        ),
    );
  });

  it("recolours loose steps too and batches with other edits", () => {
    const loose = `vis 11
fill 80,20
line 5,5 6,6
end
`;
    const after = edit(doc(loose), {
      type: "setStepColor",
      line: 2,
      plane: "visual",
      value: 9,
    });
    // The line after the fill reads the colour, so it is restored to 11.
    assert.equal(
      serializePictureDocument(after),
      `vis 11
vis 9
fill 80,20
vis 11
line 5,5 6,6
end
`,
    );
    const looseCompiled = compileDocument(after, profile);
    assert.equal(looseCompiled.visual[at(0, 0)], 9);
    assert.equal(looseCompiled.visual[at(5, 5)], 11);
    const batch = applyEdits(
      doc(ROOM),
      [
        { type: "setStepColor", line: 3, plane: "visual", value: 9 },
        { type: "setStepColor", line: 8, plane: "visual", value: 2 },
      ],
      { profile },
    );
    assert.ok(!("error" in batch));
    const compiled = compileDocument(batch.document, profile);
    assert.equal(compiled.visual[at(0, 0)], 9);
    assert.equal(compiled.visual[at(40, 80)], 2);
  });
});
