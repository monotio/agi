import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentSessionState } from "../src/agent/agentState.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { applyEdit, type EditOperation } from "../src/studio/editOperations.ts";
import { parsePictureDocument, type PictureDocument } from "../src/studio/pictureDocument.ts";
import { parseLogicDocument, serializeLogicDocument } from "../src/studio/rules/logicDocument.ts";
import { followPictureEdit, itemTranslation } from "../src/studio/rules/ruleBinding.ts";

const PICTURE = parsePictureDocument(
  [
    '# @item doorway "East doorway" art',
    "vis 4",
    "rect 120,100 135,130",
    "# @end",
    '# @item bust "Bust" art',
    "vis 7",
    "line 20,100 25,100",
    "# @end",
    "end",
  ].join("\n"),
).document;

const LOGIC = [
  "if (isset(f5)) {",
  "  accept.input();",
  "}",
  '// @rule bust-spot "Bust" region item=bust',
  "if (!isset(f40) && posn(o0, 18, 140, 28, 150)) {",
  "  set(f40);",
  "}",
  "// @end",
  '// @rule door-east "East door" exit item=doorway',
  "if (posn(o0, 120, 125, 135, 130)) {",
  "  new.room(2);",
  "}",
  "// @end",
  '// @rule east "East edge" exit item=doorway',
  "if (equaln(v2, 2)) {",
  "  new.room(3);",
  "}",
  "// @end",
  "return;",
  "",
].join("\n");

function edited(op: EditOperation): PictureDocument {
  const result = applyEdit(PICTURE, op);
  if ("error" in result) assert.fail(result.error);
  return result.document;
}

const session = createAgentSessionState();

describe("rules bound to picture items", () => {
  it("measures an item's move exactly and a reshape by its centre", () => {
    const moved = edited({ type: "moveItem", itemId: "doorway", dx: 10, dy: -5 });
    assert.deepEqual(itemTranslation(PICTURE, moved, "doorway"), { dx: 10, dy: -5 });
    assert.deepEqual(itemTranslation(PICTURE, moved, "bust"), { dx: 0, dy: 0 });
    // Dragging the rect's far corner from 135,130 to 139,130 widens it by 4: its centre moves 2.
    const reshaped = edited({ type: "setPoint", line: 3, pointIndex: 1, x: 139, y: 130 });
    assert.deepEqual(itemTranslation(PICTURE, reshaped, "doorway"), { dx: 2, dy: 0 });
    assert.equal(itemTranslation(PICTURE, moved, "nothing"), null);
  });

  it("moves the doorway's exit with the doorway in one edit", () => {
    const logic = parseLogicDocument(LOGIC).document;
    const after = edited({ type: "moveItem", itemId: "doorway", dx: 10, dy: -5 });
    const result = followPictureEdit(logic, PICTURE, after, session);
    if (!result.ok) assert.fail(result.error);
    assert.deepEqual(result.moved, [{ rule: "door-east", item: "doorway", dx: 10, dy: -5 }]);
    assert.deepEqual(result.detached, [
      { rule: "east", item: "doorway", reason: "an edge exit has no box to move" },
    ]);
    const expected = LOGIC.replace(
      "if (posn(o0, 120, 125, 135, 130)) {",
      "if (posn(o0, 130, 120, 145, 125)) {",
    );
    assert.equal(result.source, expected);
    assert.equal(serializeLogicDocument(result.document), expected);
    assert.deepEqual(result.bytes, assembleLogic(expected, { dictionary: new Map() }).payload);
  });

  it("leaves everything as it was when no bound item moved", () => {
    const logic = parseLogicDocument(LOGIC).document;
    const recoloured = edited({
      type: "setItemColor",
      itemId: "doorway",
      plane: "visual",
      value: 2,
    });
    const result = followPictureEdit(logic, PICTURE, recoloured, session);
    if (!result.ok) assert.fail(result.error);
    assert.equal(result.source, LOGIC);
    assert.deepEqual(result.moved, []);
  });

  it("detaches a rule whose item was deleted", () => {
    const logic = parseLogicDocument(LOGIC).document;
    const result = followPictureEdit(
      logic,
      PICTURE,
      edited({ type: "deleteItem", itemId: "bust" }),
      session,
    );
    if (!result.ok) assert.fail(result.error);
    assert.deepEqual(result.detached, [
      { rule: "bust-spot", item: "bust", reason: "picture item 'bust' no longer exists" },
    ]);
    assert.equal(result.source, LOGIC);
  });

  it("follows a member into a group, with the group, and back out on Ungroup", () => {
    const logic = parseLogicDocument(LOGIC).document;
    const follow = (before: PictureDocument, after: PictureDocument) => {
      const result = followPictureEdit(logic, before, after, session);
      if (!result.ok) assert.fail(result.error);
      return { moved: result.moved, detached: result.detached.filter((d) => d.rule !== "east") };
    };
    // Group gives the group a fresh id; each member lives on as a `# part` inside it.
    const grouped = edited({
      type: "combineItems",
      itemIds: ["doorway", "bust"],
      id: "entrance",
      label: "Entrance",
    });
    assert.deepEqual(follow(PICTURE, grouped), { moved: [], detached: [] });
    assert.deepEqual(itemTranslation(PICTURE, grouped, "doorway"), { dx: 0, dy: 0 });
    // Moving the group moves both members, and both rules with them.
    const moved = applyEdit(grouped, { type: "moveItem", itemId: "entrance", dx: 10, dy: -5 });
    if ("error" in moved) assert.fail(moved.error);
    assert.deepEqual(follow(PICTURE, moved.document), {
      moved: [
        { rule: "bust-spot", item: "bust", dx: 10, dy: -5 },
        { rule: "door-east", item: "doorway", dx: 10, dy: -5 },
      ],
      detached: [],
    });
    // A group that took the doorway's id still follows the doorway's own lines.
    const named = edited({
      type: "combineItems",
      itemIds: ["doorway", "bust"],
      id: "doorway",
      label: "Entrance",
    });
    assert.deepEqual(itemTranslation(PICTURE, named, "doorway"), { dx: 0, dy: 0 });
    // Ungroup gives the members their ids back: nothing moves or detaches.
    const ungrouped = applyEdit(moved.document, { type: "ungroupItem", itemId: "entrance" });
    if ("error" in ungrouped) assert.fail(ungrouped.error);
    assert.deepEqual(follow(moved.document, ungrouped.document), { moved: [], detached: [] });
  });

  it("refuses a move that puts a box off the picture or touches native logic", () => {
    const wide = parseLogicDocument(
      LOGIC.replace("posn(o0, 120, 125, 135, 130)", "posn(o0, 120, 125, 140, 130)"),
    ).document;
    assert.deepEqual(
      followPictureEdit(
        wide,
        PICTURE,
        edited({ type: "moveItem", itemId: "doorway", dx: 20, dy: 0 }),
        session,
      ),
      { ok: false, error: "Moving 'doorway' by 20,0 would put rule 'door-east' off the picture." },
    );
    const native = parseLogicDocument(
      LOGIC.replace("  set(f40);", "  set(f40);\n  set(f41);"),
    ).document;
    assert.deepEqual(
      followPictureEdit(
        native,
        PICTURE,
        edited({ type: "moveItem", itemId: "bust", dx: 1, dy: 1 }),
        session,
      ),
      {
        ok: false,
        error:
          "Rule 'bust-spot' follows 'bust' but is written directly in the room's script; move its box in the script text.",
      },
    );
  });
});
