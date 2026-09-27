import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistRefusalText,
  checkCandidate,
  draftRevision,
  pictureAssistScope,
  viewAssistScope,
  type PictureAssistScope,
} from "../src/studio/assistScope.ts";
import { applyEdit, type EditOperation } from "../src/studio/editOperations.ts";
import {
  compileEditDocument,
  footprintMask,
  type CompiledDocument,
} from "../src/studio/editValidation.ts";
import { parsePictureDocument } from "../src/studio/pictureDocument.ts";
import { openSprite, type SpriteDocument } from "../src/studio/sprite/spriteDocument.ts";
import { applySpriteEdit, type SpriteEdit } from "../src/studio/sprite/spriteOperations.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { NO_UNLOCKS } from "../src/studio/lensRules.ts";
import {
  AFTER_BRIDGE,
  BRIDGE_AREA,
  BRIDGE_SOURCE,
  RIVER_UNDER_BRIDGE,
  ROBOT_VIEW,
} from "./studioAssistFixtures.ts";

const profile = DEFAULT_V2_PROFILE;

function compile(source: string): CompiledDocument {
  const parsed = parsePictureDocument(source);
  assert.deepEqual(parsed.diagnostics, []);
  return compileEditDocument(parsed.document, profile);
}

function edit(before: CompiledDocument, ...ops: EditOperation[]): CompiledDocument {
  let document = before.document;
  for (const op of ops) {
    const result = applyEdit(document, op, { profile });
    assert.ok(!("error" in result), "error" in result ? result.error : "");
    document = result.document;
  }
  return compileEditDocument(document, profile);
}

/** A filled priority-only rect over the river rows x1..x2: 3 turns the banks to water. */
const walkRect = (x1: number, x2: number, priority = 3): EditOperation => ({
  type: "insertShape",
  atLine: AFTER_BRIDGE,
  shape: { kind: "rect", color: null, priority, filled: true, x1, y1: 120, x2, y2: 139 },
  id: "crossing",
  label: "Crossing",
  kind: priority < 4 ? "walk" : "depth",
});

/** The Walk lens over the bridge: art locked, the bridge's area licensed on priority. */
function walkScope(before: CompiledDocument, overrides: Partial<PictureAssistScope> = {}) {
  return {
    ...pictureAssistScope({
      num: 1,
      compiled: before,
      targetIds: ["bridge"],
      lens: "walk",
    }),
    ...overrides,
  };
}

test("the draft revision names the exact text or bytes", () => {
  assert.equal(
    draftRevision({ kind: "picture", source: "ab" }),
    // FNV-1a of 0x61 then 0x62 from 0x811c9dc5.
    "picture-2-4d2505ca",
  );
  assert.equal(
    draftRevision({ kind: "view", payload: Uint8Array.of(0x61, 0x62) }),
    "view-2-4d2505ca",
  );
  assert.notEqual(
    draftRevision({ kind: "picture", source: BRIDGE_SOURCE }),
    draftRevision({ kind: "picture", source: BRIDGE_SOURCE.replace('"Bridge"', '"Span"') }),
    "a label edit is a new revision",
  );
});

test("a control-only crossing under the selected bridge is allowed in the Walk lens", () => {
  const before = compile(BRIDGE_SOURCE);
  const scope = walkScope(before);
  assert.deepEqual(scope.lockedPlanes, ["visual"]);
  assert.deepEqual(Object.keys(scope.allowedMask as object), ["priority"]);
  const after = edit(before, walkRect(RIVER_UNDER_BRIDGE.x0, RIVER_UNDER_BRIDGE.x1));
  let changed = 0;
  for (let i = 0; i < after.priority.length; i++)
    if (after.priority[i] !== before.priority[i]) changed++;
  assert.equal(changed, RIVER_UNDER_BRIDGE.banks, "only the bank barriers turn to water");
  assert.deepEqual(checkCandidate(before, after, scope), { ok: true, violations: [] });
});

test("depth painted under the Walk lens is refused, and allowed once depth is unlocked", () => {
  const before = compile(BRIDGE_SOURCE);
  // Floor (4) over the whole river under the bridge: banks 0 -> 4 and water
  // 3 -> 4, all 800 cells moving into depth values.
  const after = edit(before, walkRect(RIVER_UNDER_BRIDGE.x0, RIVER_UNDER_BRIDGE.x1, 4));
  const check = checkCandidate(before, after, walkScope(before));
  assert.deepEqual(
    check.violations.map((v) => [v.constraint, v.plane, v.count, v.bbox]),
    [["walk-depth", "priority", RIVER_UNDER_BRIDGE.cells, { x0: 60, y0: 120, x1: 99, y1: 139 }]],
  );
  assert.equal(
    assistRefusalText(check),
    "depth values 4–15 are locked in the Walk lens, but 800 cells at 60,120..99,139 would change",
  );
  const unlocked = pictureAssistScope({
    num: 1,
    compiled: before,
    targetIds: ["bridge"],
    lens: "walk",
    unlocks: { ...NO_UNLOCKS, depthInWalk: true },
  });
  assert.deepEqual(checkCandidate(before, after, unlocked), { ok: true, violations: [] });
});

test("art changed under the Walk lens is refused on the locked plane", () => {
  const before = compile(BRIDGE_SOURCE);
  const after = edit(before, { type: "setItemColor", itemId: "bridge", plane: "visual", value: 8 });
  const check = checkCandidate(before, after, walkScope(before));
  assert.equal(check.ok, false);
  const locked = check.violations.find((v) => v.constraint === "locked-plane")!;
  assert.equal(locked.plane, "visual");
  assert.equal(locked.count, BRIDGE_AREA.cells);
  assert.deepEqual(locked.bbox, { x0: 60, y0: 118, x1: 99, y1: 141 });
  assert.equal(
    assistRefusalText(check),
    "the art (visual plane) is locked, but 960 cells at 60,118..99,141 would change",
  );
});

test("priority painted outside the selection is refused, with its cells", () => {
  const before = compile(BRIDGE_SOURCE);
  const after = edit(before, walkRect(0, 99));
  const check = checkCandidate(before, after, walkScope(before));
  assert.deepEqual(
    check.violations.map((v) => [v.constraint, v.plane, v.count, v.bbox]),
    // The banks left of the bridge: rows 120 and 139 at x 0..59 (120) and
    // the river's west edge x 0, rows 121..138 (18); its water stays 3.
    [["outside-mask", "priority", 138, { x0: 0, y0: 120, x1: 59, y1: 139 }]],
  );
});

test("an item outside the selection keeps its identity", () => {
  const before = compile(BRIDGE_SOURCE);
  const renamed = edit(before, { type: "setItemMeta", itemId: "river", label: "Stream" });
  const check = checkCandidate(before, renamed, walkScope(before));
  assert.deepEqual(
    check.violations.map((v) => v.message),
    [`item 'river' ("River") is not selected but would have its label, kind or lock changed`],
  );
});

test("a candidate from another draft is stale", () => {
  const before = compile(BRIDGE_SOURCE);
  const scope = walkScope(compile(BRIDGE_SOURCE.replace('"Sky"', '"Clouds"')));
  const after = edit(before, walkRect(60, 99));
  const check = checkCandidate(before, after, scope);
  assert.deepEqual(
    check.violations.map((v) => v.constraint),
    ["stale-base"],
  );
});

test("the byte budget counts the compiled picture", () => {
  const before = compile(BRIDGE_SOURCE);
  const after = edit(before, walkRect(60, 99));
  const grown = after.bytes.length - before.bytes.length;
  assert.ok(grown > 0);
  const check = checkCandidate(before, after, walkScope(before, { maxBytes: before.bytes.length }));
  assert.deepEqual(
    check.violations.map((v) => [v.constraint, v.count]),
    [["max-bytes", after.bytes.length]],
  );
  assert.ok(checkCandidate(before, after, walkScope(before, { maxBytes: after.bytes.length })).ok);
});

test("a moved target licenses its new footprint, and only that", () => {
  const before = compile(BRIDGE_SOURCE);
  const scope = {
    ...pictureAssistScope({
      num: 1,
      compiled: before,
      targetIds: ["bridge"],
      lens: "depth",
      unlocks: { ...NO_UNLOCKS, visual: true },
    }),
  };
  // Moving 10 right: the new footprint is the bridge's own, the vacated
  // cells were its old one; the sky's cells in between stay the sky's.
  const moved = edit(before, { type: "moveItem", itemId: "bridge", dx: 10, dy: 0 });
  assert.ok(checkCandidate(before, moved, scope).ok);
});

/** Cells set in `mask`. */
const cells = (mask: Uint8Array) => mask.reduce((sum, bit) => sum + bit, 0);

/** Priority cells that differ, and how many of them lie outside `area`. */
function priorityChanges(before: CompiledDocument, after: CompiledDocument, area: Uint8Array) {
  let changed = 0;
  let outside = 0;
  for (let i = 0; i < before.priority.length; i++) {
    if (before.priority[i] === after.priority[i]) continue;
    changed++;
    if (area[i] !== 1) outside++;
  }
  return { changed, outside };
}

/** The river's rect line, 1-based. */
const RIVER_RECT = BRIDGE_SOURCE.split("\n").indexOf("rect 0,120 159,139") + 1;
/** The river's rows 120..139 across the screen: its outline and the water it fills. */
const RIVER = { cells: 160 * 20, outline: 2 * 160 + 2 * 18, water: 158 * 18 };

test("a footprint splits into the item's fills and its bounded commands", () => {
  const before = compile(BRIDGE_SOURCE);
  assert.equal(cells(footprintMask(before, "river", "priority")), RIVER.cells);
  assert.equal(cells(footprintMask(before, "river", "priority", "bounded")), RIVER.outline);
  assert.equal(cells(footprintMask(before, "river", "priority", "fills")), RIVER.water);
  assert.equal(cells(footprintMask(before, "river", "visual", "fills")), 0, "the river has no art");
});

test("a target's fill that escapes its shrunken outline is refused, in words the model can act on", () => {
  // QA probe: the river's rect shrinks to 0,120..3,122, leaving its fill
  // seed 5,130 outside. The priority fill (3) floods every floor cell (4):
  // the 23,680 cells above and below the river rows. Inside the river rows
  // 356 cells change too (the old outline and the new corner), which the
  // river's own cells license.
  const before = compile(BRIDGE_SOURCE);
  const scope = pictureAssistScope({
    num: 1,
    compiled: before,
    targetIds: ["river"],
    lens: "walk",
  });
  const after = edit(before, { type: "setPoint", line: RIVER_RECT, pointIndex: 1, x: 3, y: 122 });
  const area = footprintMask(before, "river", "both");
  assert.deepEqual(priorityChanges(before, after, area), { changed: 24036, outside: 23680 });
  const check = checkCandidate(before, after, scope);
  assert.deepEqual(
    check.violations.map((v) => [v.constraint, v.plane, v.count, v.bbox]),
    [["fill-spill", "priority", 23680, { x0: 0, y0: 0, x1: 159, y1: 167 }]],
  );
  assert.equal(
    assistRefusalText(check),
    "the River fill would spill outside the selection (23,680 cells); close the outline or keep the fill seed inside it",
  );
});

test("a reshaped line keeps its licence past the selection: bounded geometry", () => {
  // The bridge's first row, 60,118..99,118, turned into the post 60,110..60,118:
  // 8 cells above the bridge turn to its colour 6 and row 118 x 61..99 (39
  // cells) back to the sky's 11. A line's cells lie on its own points.
  const before = compile(BRIDGE_SOURCE);
  const firstRow = BRIDGE_SOURCE.split("\n").indexOf("line 60,118 99,118") + 1;
  const after = edit(before, { type: "setPoint", line: firstRow, pointIndex: 1, x: 60, y: 110 });
  const area = footprintMask(before, "bridge", "both");
  let outside = 0;
  let changed = 0;
  for (let i = 0; i < after.visual.length; i++) {
    if (before.visual[i] === after.visual[i]) continue;
    changed++;
    if (area[i] !== 1) outside++;
  }
  assert.deepEqual({ changed, outside }, { changed: 47, outside: 8 });
  const scope = pictureAssistScope({
    num: 1,
    compiled: before,
    targetIds: ["bridge"],
    lens: "art",
  });
  assert.deepEqual(checkCandidate(before, after, scope), { ok: true, violations: [] });
});

test("a moved target's fill may land in its old area moved by the same offset", () => {
  // The river 10 rows down: rect 0,130..159,149, seed 5,140. Rows 120..129
  // go back to floor (1,600), rows 130 and 139 swap bank and water (158 each),
  // and rows 140..149 (1,600) are new: 178 outline cells, licensed as the
  // river's lines, and 1,422 water cells, licensed as the river's old area
  // moved 10 down.
  const before = compile(BRIDGE_SOURCE);
  const after = edit(before, { type: "moveItem", itemId: "river", dx: 0, dy: 10 });
  const area = footprintMask(before, "river", "both");
  assert.deepEqual(priorityChanges(before, after, area), { changed: 3516, outside: 1600 });
  assert.equal(cells(footprintMask(after, "river", "priority", "fills")), RIVER.water);
  const scope = pictureAssistScope({
    num: 1,
    compiled: before,
    targetIds: ["river"],
    lens: "depth",
  });
  assert.deepEqual(checkCandidate(before, after, scope), { ok: true, violations: [] });
});

test("a fill the proposal inserts is refused where it spills out of the selection", () => {
  // A water fill seeded in the floor above the river floods the floor down
  // to the river's top bank, which spans the screen: rows 0..119, 160 x 120
  // = 19,200 cells, none of them in the river's rows.
  const before = compile(BRIDGE_SOURCE);
  const after = edit(before, {
    type: "insertFill",
    atLine: AFTER_BRIDGE,
    x: 80,
    y: 60,
    visual: null,
    priority: 3,
    id: "puddle",
    label: "Puddle",
  });
  const scope = pictureAssistScope({
    num: 1,
    compiled: before,
    targetIds: ["river"],
    lens: "walk",
  });
  const check = checkCandidate(before, after, scope);
  assert.deepEqual(
    check.violations.map((v) => [v.constraint, v.plane, v.count, v.bbox]),
    [["fill-spill", "priority", 19200, { x0: 0, y0: 0, x1: 159, y1: 119 }]],
  );
  assert.equal(
    assistRefusalText(check),
    "the Puddle fill would spill outside the selection (19,200 cells); close the outline or keep the fill seed inside it",
  );
});

test("a new bare fill does not pass as a moved copy of a selected bare fill", () => {
  // The sky is one fill (0,0); a floor-depth fill seeded at 45,29 is the same
  // geometry moved, but encloses nothing. It floods the floor down to the
  // river's top bank, rows 0..119; the sky's area misses the bridge there,
  // x 60..99 on rows 118 and 119: 80 cells.
  const before = compile(BRIDGE_SOURCE);
  const after = edit(before, {
    type: "insertFill",
    atLine: AFTER_BRIDGE,
    x: 45,
    y: 29,
    visual: null,
    priority: 5,
    id: "puddle",
    label: "Puddle",
  });
  const scope = pictureAssistScope({
    num: 1,
    compiled: before,
    targetIds: ["sky"],
    lens: "art",
    unlocks: { ...NO_UNLOCKS, priority: true },
  });
  assert.deepEqual(
    checkCandidate(before, after, scope).violations.map((v) => [v.constraint, v.count, v.bbox]),
    [["fill-spill", 80, { x0: 60, y0: 118, x1: 99, y1: 119 }]],
  );
});

function sprite(): SpriteDocument {
  return openSprite(ROBOT_VIEW, profile);
}

function spriteEdit(before: SpriteDocument, op: SpriteEdit): SpriteDocument {
  const result = applySpriteEdit(before, op);
  assert.ok(!("error" in result), "error" in result ? result.error : "");
  return result.document;
}

const loop1 = [
  { loop: 1, cel: 0 },
  { loop: 1, cel: 1 },
];

test("blue eyes on the mirrored loop split it off and pass", () => {
  const before = sprite();
  assert.equal(before.loops[1]!.alias, 0);
  const after = spriteEdit(before, { type: "recolor", scope: loop1, from: 12, to: 9 });
  assert.equal(after.loops[1]!.alias, null, "copy-on-write isolated loop 1");
  const scope = viewAssistScope({ num: 2, document: before, targetCels: loop1 });
  assert.deepEqual(checkCandidate(before, after, scope), { ok: true, violations: [] });
});

test("a recolor that propagates to the unselected mirror is refused per cel", () => {
  const before = sprite();
  const after = spriteEdit(before, {
    type: "recolor",
    scope: loop1,
    from: 12,
    to: 9,
    propagate: true,
  });
  const check = checkCandidate(
    before,
    after,
    viewAssistScope({ num: 2, document: before, targetCels: loop1 }),
  );
  assert.deepEqual(
    check.violations.map((v) => [v.constraint, v.loop, v.cel, v.count]),
    [
      ["outside-target", 0, 0, 1],
      ["outside-target", 0, 1, 1],
    ],
  );
  assert.equal(
    check.violations[0]!.message,
    "loop 0, cel 0 is not selected, but 1 pixel of it would change",
  );
});

test("a protected loop refuses even a selected cel", () => {
  const before = sprite();
  const after = spriteEdit(before, {
    type: "setPixels",
    loop: 0,
    cel: 0,
    changes: [{ x: 0, y: 0, color: 4 }],
  });
  const check = checkCandidate(
    before,
    after,
    viewAssistScope({
      num: 2,
      document: before,
      targetCels: [{ loop: 0, cel: 0 }],
      protectedLoops: [0],
    }),
  );
  assert.equal(check.ok, false);
  assert.deepEqual([...new Set(check.violations.map((v) => v.constraint))], ["protected-loop"]);
});

test("a view scope refuses a stale base and an oversized payload", () => {
  const before = sprite();
  const after = spriteEdit(before, { type: "recolor", scope: loop1, from: 12, to: 9 });
  const other = spriteEdit(before, { type: "recolor", scope: "view", from: 7, to: 8 });
  const scope = viewAssistScope({ num: 2, document: other, targetCels: loop1, maxBytes: 10 });
  assert.deepEqual(
    checkCandidate(before, after, scope).violations.map((v) => v.constraint),
    ["stale-base", "max-bytes"],
  );
});

test("an edit of the owner loop passes with its mirror protected, whose pixels stay", () => {
  // Loop 0 selected, loop 1 (its mirror) protected: copy-on-write splits the
  // pair, so loop 1 gets its own data block (alias, mirror bits) but shows
  // the same pixels.
  const before = sprite();
  const loop0 = [
    { loop: 0, cel: 0 },
    { loop: 0, cel: 1 },
  ];
  const after = spriteEdit(before, { type: "recolor", scope: loop0, from: 12, to: 9 });
  assert.equal(after.loops[1]!.alias, null, "the pair is split");
  const scope = viewAssistScope({
    num: 2,
    document: before,
    targetCels: loop0,
    protectedLoops: [1],
  });
  assert.deepEqual(checkCandidate(before, after, scope), { ok: true, violations: [] });
});

test("a change that reaches the protected mirror's pixels is still refused", () => {
  const before = sprite();
  const loop0 = [
    { loop: 0, cel: 0 },
    { loop: 0, cel: 1 },
  ];
  // Propagating keeps the pair linked: loop 1's one red eye pixel per cel turns blue too.
  const after = spriteEdit(before, {
    type: "recolor",
    scope: loop0,
    from: 12,
    to: 9,
    propagate: true,
  });
  const scope = viewAssistScope({
    num: 2,
    document: before,
    targetCels: loop0,
    protectedLoops: [1],
  });
  assert.deepEqual(
    checkCandidate(before, after, scope).violations.map((v) => [
      v.constraint,
      v.loop,
      v.cel,
      v.count,
    ]),
    [
      ["protected-loop", 1, 0, 1],
      ["protected-loop", 1, 1, 1],
    ],
  );
});
