import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assistRefusalText,
  checkCandidate,
  draftRevision,
  pictureAssistScope,
  viewAssistScope,
  type AssistCheck,
  type PictureAssistScope,
} from "../src/studio/assistScope.ts";
import { PAYLOAD_MAX_BYTES } from "../src/container/container.ts";
import { applyEdit, type EditOperation } from "../src/studio/editOperations.ts";
import {
  compileEditDocument,
  footprintMask,
  type CompiledDocument,
} from "../src/studio/editValidation.ts";
import { parsePictureDocument } from "../src/studio/pictureDocument.ts";
import { openSprite, type SpriteDocument } from "../src/view/spriteDocument.ts";
import { applySpriteEdit, type SpriteEdit } from "../src/studio/sprite/spriteOperations.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { NO_UNLOCKS } from "../src/studio/lensRules.ts";
import {
  AFTER_BRIDGE,
  BRIDGE_AREA,
  BRIDGE_SOURCE,
  ISLAND_MOVE,
  ISLAND_SOURCE,
  RIVER_UNDER_BRIDGE,
  ROBOT_CELS,
  ROBOT_VIEW,
} from "./studioAssistFixtures.ts";
import { buildView, type BuildCelInput, type BuildLoopInput } from "../src/view/view.ts";

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

/** Each side effect as its item id, label, plane, cell count, bounding box and fill flag. */
const effects = (check: AssistCheck) =>
  (check.sideEffects?.effects ?? []).map((e) => [
    e.itemId,
    e.label,
    e.plane,
    e.count,
    e.bbox,
    e.fill,
  ]);

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
  // A unit above 0xff hashes its low byte, then its high byte: 'Ω' is 0x03a9,
  // while 'ÿ' (0xff) is one byte.
  assert.equal(draftRevision({ kind: "picture", source: "Ω" }), "picture-1-dd9a0e05");
  assert.equal(draftRevision({ kind: "picture", source: "ÿ" }), "picture-1-7a0b824e");
  assert.equal(
    draftRevision({ kind: "view", payload: Uint8Array.of(5) }),
    "view-1-000c5540",
    "the hash keeps its leading zeros",
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

test("moving an outline drawn before another item's fill passes, the fill's new pour reported", () => {
  // The grass pours around the island: moved 8 right, the island takes the
  // grass along its new outline. Refused before side effects were reported.
  const before = compile(ISLAND_SOURCE);
  const after = edit(before, { type: "moveItem", itemId: "island", dx: ISLAND_MOVE.dx, dy: 0 });
  const check = checkCandidate(before, after, artScope(before, "island"));
  assert.equal(check.ok, true);
  assert.deepEqual(check.violations, []);
  assert.deepEqual(effects(check), [
    ["grass", "Grass", "art", ISLAND_MOVE.cells, ISLAND_MOVE.bbox, true],
  ]);
  assert.deepEqual(check.sideEffects?.items, [
    { itemId: "grass", label: "Grass", cells: ISLAND_MOVE.cells, fill: true },
  ]);
  assert.equal(check.sideEffects?.cells, ISLAND_MOVE.cells);
});

test("an unselected item's commands, and the loose steps, stay: the check refuses a rewrite", () => {
  const before = compile(ISLAND_SOURCE);
  // The grass reseeded: its pixels are the same, its commands are not.
  const reseeded = compile(ISLAND_SOURCE.replace("fill 80,100", "fill 90,100"));
  assert.deepEqual(
    checkCandidate(before, reseeded, artScope(before, "island")).violations.map((v) => [
      v.constraint,
      v.message,
    ]),
    [
      [
        "outside-target",
        `item 'grass' ("Grass") is not selected but would have its commands changed`,
      ],
    ],
  );
  const loose = compile(ISLAND_SOURCE.replace("\nend\n", "\nvis 4\nline 0,0 5,0\nend\n"));
  assert.deepEqual(
    checkCandidate(before, loose, artScope(before, "island")).violations.map((v) => v.message),
    ["the loose steps outside every item would change"],
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
  const draft = draftRevision({ kind: "picture", source: BRIDGE_SOURCE });
  assert.equal(
    assistRefusalText(check),
    `the draft changed since this request was made (request base ${scope.baseRevision}, draft now ${draft})`,
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

test("a target's fill that escapes its shrunken outline is a side effect, reported with its cells", () => {
  // QA probe: the river's rect shrinks to 0,120..3,122, leaving its fill
  // seed 5,130 outside. The priority fill (3) floods every floor cell (4):
  // the 23,680 cells above and below the river rows, which no command drew
  // before (the sky is art only). Inside the river rows 356 cells change too
  // (the old outline and the new corner), which the river's own cells
  // license.
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
  assert.deepEqual(check.violations, []);
  assert.deepEqual(effects(check), [
    [null, "Blank area", "walk", 23680, { x0: 0, y0: 0, x1: 159, y1: 167 }, false],
  ]);
  assert.equal(check.sideEffects?.cells, 23680);
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

test("a fill the proposal inserts reports what it pours over outside the selection", () => {
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
  assert.equal(check.ok, true);
  assert.deepEqual(effects(check), [
    [null, "Blank area", "walk", 19200, { x0: 0, y0: 0, x1: 159, y1: 119 }, false],
  ]);
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
  // Not licensed as a copy: those 80 cells are side effects.
  const check = checkCandidate(before, after, scope);
  assert.deepEqual(check.violations, []);
  assert.deepEqual(effects(check), [
    [null, "Blank area", "depth", 80, { x0: 60, y0: 118, x1: 99, y1: 119 }, false],
  ]);
});

/** A picture from source lines. */
const picture = (...lines: string[]) => compile(lines.join("\n"));

/** Each violation as its constraint, plane, cell count and bounding box. */
const shape = (check: AssistCheck) =>
  check.violations.map((v) => [v.constraint, v.plane, v.count, v.bbox]);

/** The scope of an Art-lens selection of `targetIds`: priority locked, their area licensed on the art. */
const artScope = (compiled: CompiledDocument, ...targetIds: string[]) =>
  pictureAssistScope({ num: 1, compiled, targetIds, lens: "art" });

/** A new art item `n` drawing `commands` in colour 5. */
const newItem = (...commands: string[]) => ['# @item n "N" art', "vis 5", ...commands, "# @end"];

test("a selection naming items the draft lacks is refused in words", () => {
  const before = compile(BRIDGE_SOURCE);
  // The candidate adds an item that only sets a colour: new, but drawing nothing.
  const after = compile(
    BRIDGE_SOURCE.replace("\nend\n", '\n# @item mark "Mark" art\nvis 5\n# @end\nend\n'),
  );
  const check = (...targetIds: string[]) =>
    checkCandidate(
      before,
      after,
      pictureAssistScope({ num: 1, compiled: before, targetIds, lens: "depth" }),
    );
  assert.deepEqual(check("ghost"), {
    ok: false,
    violations: [
      {
        constraint: "unknown-target",
        message: "the selection names an item the draft does not have: ghost",
      },
    ],
  });
  assert.deepEqual(check("bridge", "ghost", "wisp").violations, [
    {
      constraint: "unknown-target",
      message: "the selection names items the draft does not have: ghost, wisp",
    },
  ]);
});

test("an unselected item may not be removed, re-kinded or relocked; the selection's own identity may change", () => {
  const before = compile(BRIDGE_SOURCE);
  const scope = walkScope(before);
  const identity = `item 'river' ("River") is not selected but would have its label, kind or lock changed`;
  // setItemMeta keeps every byte, so identity is all these candidates change.
  for (const op of [
    { type: "setItemMeta", itemId: "river", kind: "depth" },
    { type: "setItemMeta", itemId: "river", locked: true },
  ] as const)
    assert.deepEqual(checkCandidate(before, edit(before, op), scope).violations, [
      { constraint: "outside-target", message: identity },
    ]);
  const removed = checkCandidate(
    before,
    edit(before, { type: "deleteItem", itemId: "sky" }),
    scope,
  );
  assert.deepEqual(
    removed.violations.filter((v) => v.constraint === "outside-target").map((v) => v.message),
    [`item 'sky' ("Sky") is not selected but would be removed`],
  );
  const renamed = edit(before, {
    type: "setItemMeta",
    itemId: "bridge",
    label: "Span",
    kind: "mixed",
  });
  assert.deepEqual(checkCandidate(before, renamed, scope), { ok: true, violations: [] });
});

test("a proposal never locks or unlocks an item, selected or new", () => {
  const before = compile(BRIDGE_SOURCE);
  const scope = walkScope(before);
  const lockRule = 'but only the creator locks or unlocks items: leave "locked" out of setItemMeta';
  // Locking the selection changes no pixel: the lock alone is refused.
  assert.deepEqual(
    checkCandidate(
      before,
      edit(before, { type: "setItemMeta", itemId: "bridge", locked: true }),
      scope,
    ).violations,
    [{ constraint: "item-lock", message: `item 'bridge' ("Bridge") would be locked, ${lockRule}` }],
  );
  // A selected item the creator locked stays locked: unlocking it to move it is refused.
  const locked = compile(BRIDGE_SOURCE.replace('"Bridge" art', '"Bridge" art locked'));
  const unlockedAndMoved = edit(
    locked,
    { type: "setItemMeta", itemId: "bridge", locked: false },
    { type: "moveItem", itemId: "bridge", dx: 0, dy: -1 },
  );
  assert.deepEqual(
    checkCandidate(locked, unlockedAndMoved, walkScope(locked)).violations.filter(
      (v) => v.constraint === "item-lock",
    ),
    [
      {
        constraint: "item-lock",
        message: `item 'bridge' ("Bridge") would be unlocked, ${lockRule} and ask the creator to unlock it`,
      },
    ],
  );
  // A new item may not arrive locked.
  const lockedCrossing = edit(before, walkRect(60, 99), {
    type: "setItemMeta",
    itemId: "crossing",
    locked: true,
  });
  assert.deepEqual(checkCandidate(before, lockedCrossing, scope).violations, [
    {
      constraint: "item-lock",
      message: `new item 'crossing' ("Crossing") would be locked, ${lockRule}`,
    },
  ]);
  assert.deepEqual(checkCandidate(before, edit(before, walkRect(60, 99)), scope).violations, []);
});

test("without an allowedMask a target licenses only its own footprint on each plane", () => {
  // The bridge is art only: under it the crossing turns the 80 bank cells
  // (rows 120 and 139, x 60..99) from barrier 0 to water 3, and the bridge
  // owns no priority there.
  const before = compile(BRIDGE_SOURCE);
  const scope: PictureAssistScope = {
    kind: "picture",
    num: 1,
    baseRevision: draftRevision({ kind: "picture", source: BRIDGE_SOURCE }),
    targetIds: ["bridge"],
    lockedPlanes: [],
    lens: "depth",
    unlocks: NO_UNLOCKS,
    maxBytes: PAYLOAD_MAX_BYTES,
  };
  const after = edit(before, walkRect(60, 99));
  assert.deepEqual(shape(checkCandidate(before, after, scope)), [
    ["outside-mask", "priority", 80, { x0: 60, y0: 120, x1: 99, y1: 139 }],
  ]);
  for (const allowedMask of [new Uint8Array(5), { priority: new Uint8Array(5) }])
    assert.throws(() => checkCandidate(before, after, { ...scope, allowedMask }), {
      name: "RangeError",
      message: "allowedMask has 5 cells; expected 26880",
    });
});

test("the scope's byte budget is the caller's, or the payload limit", () => {
  const before = compile(BRIDGE_SOURCE);
  const input = { num: 1, compiled: before, targetIds: ["bridge"], lens: "walk" } as const;
  assert.equal(pictureAssistScope(input).maxBytes, PAYLOAD_MAX_BYTES);
  const after = edit(before, walkRect(60, 99));
  const budget = before.bytes.length;
  const bytes = after.bytes.length;
  assert.deepEqual(
    checkCandidate(before, after, pictureAssistScope({ ...input, maxBytes: budget })).violations,
    [
      {
        constraint: "max-bytes",
        count: bytes,
        message: `the picture would be ${bytes} bytes, ${bytes - budget} over the ${budget}-byte budget`,
      },
    ],
  );
});

test("a target counts as moved only when every coordinate command moved by one offset", () => {
  // T is a square outline 20,20..40,40 plus one more command. The candidate
  // moves only the square 50 right and adds N, which draws that command 50
  // right: T was not moved as a whole, so its old area moved 50 right
  // licenses nothing, and N's cells are outside the selection.
  const row60 = { x0: 70, y0: 60, x1: 90, y1: 60 };
  const rows60to70 = { x0: 70, y0: 60, x1: 90, y1: 70 };
  const cases = [
    ["line 20,60 40,60", "line 70,60 90,60", 21, row60],
    // Row 60 x 20..40 (21), then column 40 y 61..70 (10).
    ["polyline 20,60 40,60 40,70", "polyline 70,60 90,60 90,70", 31, rows60to70],
    // A closed 21 x 11 outline: 2 x 21 + 2 x 9.
    ["polygon 20,60 40,60 40,70 20,70", "polygon 70,60 90,60 90,70 70,70", 60, rows60to70],
    // 20,60 -> 27,60 -> 34,60 -> 40,60: row 60 x 20..40.
    ["rel 20,60 7,0 7,0 6,0", "rel 70,60 7,0 7,0 6,0", 21, row60],
    // x to 40 along row 60 (21), then y to 70 down column 40 (10).
    ["xcorner 20,60 40 70", "xcorner 70,60 90 70", 31, rows60to70],
    // y to 70 down column 20 (11), then x to 40 along row 70 (20).
    ["ycorner 20,60 70 40", "ycorner 70,60 70 90", 31, rows60to70],
    ["plot 30,65", "plot 80,65", 1, { x0: 80, y0: 65, x1: 80, y1: 65 }],
  ] as const;
  for (const [rest, moved, count, bbox] of cases) {
    const item = (square: string) => ['# @item t "T" art', "vis 1", square, rest, "# @end"];
    const before = picture(...item("rect 20,20 40,40"), "end");
    const after = picture(...item("rect 70,20 90,40"), ...newItem(moved), "end");
    assert.deepEqual(
      shape(checkCandidate(before, after, artScope(before, "t"))),
      [["outside-mask", "visual", count, bbox]],
      rest,
    );
  }
});

test("a target's fill follows it only when the seed moved with the outline", () => {
  // The square 20,20..40,40 filled with colour 1, moved 50 right. Its new
  // interior 71..89 x 21..39 (19 x 19 = 361 cells) lies outside its old area:
  // licensed as that area moved 50 right when the seed moves 50 right too,
  // and a side effect when the seed lands elsewhere inside the square.
  const item = (square: string, seed: string) =>
    picture('# @item t "T" art', "vis 1", square, seed, "# @end", "end");
  const before = item("rect 20,20 40,40", "fill 30,30");
  const scope = artScope(before, "t");
  const moved = item("rect 70,20 90,40", "fill 80,30");
  assert.deepEqual(checkCandidate(before, moved, scope), { ok: true, violations: [] });
  const reseeded = checkCandidate(before, item("rect 70,20 90,40", "fill 75,25"), scope);
  assert.deepEqual(reseeded.violations, []);
  assert.deepEqual(effects(reseeded), [
    [null, "Blank area", "art", 361, { x0: 71, y0: 21, x1: 89, y1: 39 }, false],
  ]);
});

test("an unselected copy of the target is not the target: its commands stay", () => {
  // U repeats T's square 50 right; recolouring U rewrites its commands.
  const square = (id: string, colour: number, corners: string) => [
    `# @item ${id} "${id.toUpperCase()}" art`,
    `vis ${colour}`,
    `rect ${corners}`,
    "# @end",
  ];
  const t = square("t", 1, "20,20 40,40");
  const before = picture(...t, ...square("u", 1, "70,20 90,40"), "end");
  const after = picture(...t, ...square("u", 3, "70,20 90,40"), "end");
  const check = checkCandidate(before, after, artScope(before, "t"));
  assert.deepEqual(
    check.violations.map((v) => [v.constraint, v.message]),
    [["outside-target", `item 'u' ("U") is not selected but would have its commands changed`]],
  );
});

test("a moved fill's licence is its old area moved, dropping cells pushed off the surface", () => {
  // East is a wall at x 100 filling everything right of it with colour 2
  // (x 100..159 on every row). Its colour is set before it, so its own
  // lines are its wall and its seed.
  const east = (x: number, seed: number) => [
    "vis 2",
    '# @item east "East" art',
    `line ${x},0 ${x},167`,
    `fill ${seed},80`,
    "# @end",
  ];
  const before = picture(...east(100, 130), "end");
  const scope = artScope(before, "east");
  // 20 left: the new wall is its own, and the fill's new cells x 81..99 lie
  // in the old area moved 20 left (x 80..139); N's six cells do not.
  const left = picture(...east(80, 110), ...newItem("line 10,50 15,50"), "end");
  assert.deepEqual(shape(checkCandidate(before, left, scope)), [
    ["outside-mask", "visual", 6, { x0: 10, y0: 50, x1: 15, y1: 50 }],
  ]);
  // 20 right: the old area moved 20 right runs past x 159; those cells drop
  // rather than wrap onto the start of the next row, where N draws.
  const right = picture(...east(120, 150), ...newItem("line 0,50 5,50"), "end");
  assert.deepEqual(shape(checkCandidate(before, right, scope)), [
    ["outside-mask", "visual", 6, { x0: 0, y0: 50, x1: 5, y1: 50 }],
  ]);
  // West mirrors it: a wall at x 59 filling x 0..58, moved 20 left, whose
  // cells moved past x 0 do not wrap onto the end of the row above.
  const west = (x: number, seed: number) => [
    '# @item west "West" art',
    "vis 2",
    `line ${x},0 ${x},167`,
    `fill ${seed},80`,
    "# @end",
  ];
  const wall = picture(...west(59, 20), "end");
  const moved = picture(...west(39, 0), ...newItem("line 150,50 159,50"), "end");
  assert.deepEqual(shape(checkCandidate(wall, moved, artScope(wall, "west"))), [
    ["outside-mask", "visual", 10, { x0: 150, y0: 50, x1: 159, y1: 50 }],
  ]);
});

test("a target moved into the corner licenses its moved area up to row 0 and column 0", () => {
  const square = ['# @item t "T" art', "vis 1", "rect 10,10 30,30", "# @end"];
  const before = picture(...square, "end");
  const scope = artScope(before, "t");
  // T moves to 0,0..20,20 and N paints over its top and left edges: 41
  // cells T no longer owns, all in its old outline moved -10,-10.
  const cornered = ['# @item t "T" art', "vis 1", "rect 0,0 20,20", "# @end"];
  const after = picture(...cornered, ...newItem("polyline 20,0 0,0 0,20"), "end");
  assert.deepEqual(checkCandidate(before, after, scope), { ok: true, violations: [] });
  // Without the move, a stray cell at the origin is reported exactly there.
  const stray = checkCandidate(before, picture(...square, ...newItem("plot 0,0"), "end"), scope);
  assert.deepEqual(shape(stray), [["outside-mask", "visual", 1, { x0: 0, y0: 0, x1: 0, y1: 0 }]]);
  assert.equal(
    assistRefusalText(stray),
    "1 cell at 0,0..0,0 of the art (visual plane) outside the selection would change",
  );
});

test("an offset that would push the target's other commands off the surface is no move, and no error", () => {
  // The square 100 right fits; the line 100,50..150,50 would not.
  const item = (square: string) =>
    picture('# @item t "T" art', "vis 1", square, "line 100,50 150,50", "# @end", "end");
  const before = item("rect 10,10 20,20");
  assert.deepEqual(checkCandidate(before, item("rect 110,10 120,20"), artScope(before, "t")), {
    ok: true,
    violations: [],
  });
});

test("a target whose first command opens with a stipple seed is compared without error", () => {
  // `plot 17 30,30` starts with its seed, not a coordinate pair.
  const item = (pen: string, plot: string) =>
    picture('# @item t "T" art', pen, "vis 1", plot, "# @end", "end");
  const before = item("pen 0 stipple", "plot 17 30,30");
  assert.deepEqual(checkCandidate(before, item("pen 0", "plot 30,30"), artScope(before, "t")), {
    ok: true,
    violations: [],
  });
});

test("a locked plane refuses its changes whole; on the others new outlines outside the selection are refused and their fills reported", () => {
  // Under the Walk lens (art locked) a new mixed item draws the outline
  // 50,50..52,52 (8 cells) and fills its one interior cell 51,51 on both
  // planes; none of it is in the selection.
  const target = ['# @item t "T" walk', "pri 3", "rect 10,10 20,20", "# @end"];
  const before = picture(...target, "end");
  const pond = ['# @item pond "Pond" mixed', "vis 1", "pri 3", "rect 50,50 52,52", "fill 51,51"];
  const after = picture(...target, ...pond, "# @end", "end");
  const check = checkCandidate(
    before,
    after,
    pictureAssistScope({ num: 1, compiled: before, targetIds: ["t"], lens: "walk" }),
  );
  const outline = { x0: 50, y0: 50, x1: 52, y1: 52 };
  const seed = { x0: 51, y0: 51, x1: 51, y1: 51 };
  assert.deepEqual(shape(check), [
    ["locked-plane", "visual", 9, outline],
    ["outside-mask", "priority", 8, outline],
  ]);
  assert.deepEqual(effects(check), [[null, "Blank area", "walk", 1, seed, false]]);
  assert.equal(
    assistRefusalText(check),
    "the art (visual plane) is locked, but 9 cells at 50,50..52,52 would change; " +
      "8 cells at 50,50..52,52 of the depth and walk (priority plane) outside the selection would change",
  );
});

/** A new art item `id` repeating the bridge's 24 rows dx,dy away, in colour `colour`. */
const bridgeCopy = (id: string, dx: number, dy: number, colour = 6) => [
  `# @item ${id} "${id}" art`,
  `vis ${colour}`,
  "pri off",
  ...Array.from(
    { length: 24 },
    (_, i) => `line ${60 + dx},${118 + dy + i} ${99 + dx},${118 + dy + i}`,
  ),
  "# @end",
];
/** The bridge fixture with `lines` added after its last item. */
const withBridge = (source: string, ...lines: string[]) =>
  compile(source.replace("\nend\n", `\n${lines.join("\n")}\nend\n`));

test("one copy of the selected item is licensed; a second is refused in words the model can act on", () => {
  // The bridge is 40 x 24 = 960 cells of colour 6 at x 60..99, y 118..141,
  // over sky 11. A copy 60 left and 100 up lands on x 0..39, y 18..41, one
  // 60 right and 100 up on x 120..159, y 18..41: 960 sky cells each.
  const before = compile(BRIDGE_SOURCE);
  const scope = artScope(before, "bridge");
  const one = withBridge(BRIDGE_SOURCE, ...bridgeCopy("left", -60, -100));
  assert.deepEqual(checkCandidate(before, one, scope), { ok: true, violations: [] });
  const two = withBridge(
    BRIDGE_SOURCE,
    ...bridgeCopy("left", -60, -100),
    ...bridgeCopy("right", 60, -100),
  );
  const check = checkCandidate(before, two, scope);
  assert.deepEqual(shape(check), [
    ["extra-copy", "visual", 960, { x0: 120, y0: 18, x1: 159, y1: 41 }],
  ]);
  assert.equal(
    assistRefusalText(check),
    `new item 'right' ("right") would be a second copy of the selected "Bridge": 960 cells at 120,18..159,41 of the art (visual plane) outside the selection would change. An assist may move a selected item or copy it once, no more; drop the extra copies`,
  );
});

test("a moved target has no copy left to make", () => {
  // The bridge moves 100 up (x 60..99, y 18..41), and a copy of it lands 60
  // left of that: its 960 cells are a second position.
  const before = compile(BRIDGE_SOURCE);
  const moved = BRIDGE_SOURCE.replace(
    /line (\d+),(\d+) (\d+),\2\n/g,
    (text, x1: string, y: string, x2: string) =>
      x1 === "60" ? `line ${x1},${Number(y) - 100} ${x2},${Number(y) - 100}\n` : text,
  );
  const after = withBridge(moved, ...bridgeCopy("left", -60, -100));
  assert.deepEqual(shape(checkCandidate(before, after, artScope(before, "bridge"))), [
    ["extra-copy", "visual", 960, { x0: 0, y0: 18, x1: 39, y1: 41 }],
  ]);
});

test("look-alikes in other colours get no licence: of six tiles of the bridge, one passes", () => {
  // QA's tiles: the bridge's rows in colours 1..6 with top-left corners
  // 0,0 / 40,0 / 80,0 / 120,0 / 0,30 / 40,60, none overlapping, all over
  // sky. Only the colour-6 tile is the bridge copied; the other five are
  // refused with their 960 cells each.
  const before = compile(BRIDGE_SOURCE);
  const corners = [
    [0, 0],
    [40, 0],
    [80, 0],
    [120, 0],
    [0, 30],
    [40, 60],
  ] as const;
  const after = withBridge(
    BRIDGE_SOURCE,
    ...corners.flatMap(([x, y], i) => bridgeCopy(`t${i + 1}`, x - 60, y - 118, i + 1)),
  );
  const check = checkCandidate(before, after, artScope(before, "bridge"));
  assert.deepEqual(
    shape(check),
    corners
      .slice(0, 5)
      .map(([x, y]) => ["extra-copy", "visual", 960, { x0: x, y0: y, x1: x + 39, y1: y + 23 }]),
  );
  assert.ok(
    assistRefusalText(check).startsWith(
      `new item 't1' ("t1") copies the selected "Bridge" in other colours: 960 cells at 0,0..39,23 of the art (visual plane) outside the selection would change. A copy keeps the item's colours and pen; draw it in the same ones, or keep new drawing inside the selection; `,
    ),
  );
});

test("a copy that draws depth the selected art never drew is refused in the Walk lens", () => {
  // Dot is a 3-cell colour-6 line at 10..12,10 with priority off. W repeats
  // it at 100..102,100 with art off and priority 2: its 3 cells turn floor 4
  // into signal 2, which the Walk lens itself would allow as control.
  const sky = ['# @item sky "Sky" art', "vis 11", "fill 0,0", "# @end"];
  const dot = ['# @item dot "Dot" art', "vis 6", "line 10,10 12,10", "# @end"];
  const walk = ['# @item w "W" walk', "vis off", "pri 2", "line 100,100 102,100", "# @end"];
  const before = picture(...sky, ...dot, "end");
  const after = picture(...sky, ...dot, ...walk, "end");
  const scope = pictureAssistScope({ num: 1, compiled: before, targetIds: ["dot"], lens: "walk" });
  assert.deepEqual(shape(checkCandidate(before, after, scope)), [
    ["extra-copy", "priority", 3, { x0: 100, y0: 100, x1: 102, y1: 100 }],
  ]);
});

test("a duplicate as manual Duplicate makes it passes, a colour set before the item included", () => {
  // East's colour 2 is set before its @item; the duplicate carries it.
  const east = ["vis 2", '# @item east "East" art', "line 100,0 100,20", "# @end"];
  const before = picture(...east, "end");
  const after = edit(before, {
    type: "duplicateItem",
    itemId: "east",
    dx: -50,
    dy: 0,
    newId: "west",
    newLabel: "West",
  });
  assert.deepEqual(checkCandidate(before, after, artScope(before, "east")), {
    ok: true,
    violations: [],
  });
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

const [HEAD_0, HEAD_1] = ROBOT_CELS;

/** A cel marked mirrorable, as the linked pair's cels are: splitting the pair keeps the bit. */
const mirrorable = (cel: BuildCelInput): BuildCelInput => ({ ...cel, mirror: true });

/** Loop 0's two cels as loop 1 shows them on its own: each mirrored is the other. */
const LOOP_1_ALONE = [mirrorable(HEAD_1), mirrorable(HEAD_0)];

/** The robot with its loops rebuilt: `loops` as given, the description kept. */
const robot = (...loops: BuildLoopInput[]) =>
  openSprite(buildView({ description: "Test robot", loops }), profile);

test("a view selection naming cels the view lacks is refused in words", () => {
  const before = sprite();
  const scope = viewAssistScope({
    num: 2,
    document: before,
    targetCels: [
      { loop: 0, cel: 5 },
      { loop: 4, cel: 0 },
    ],
  });
  assert.deepEqual(checkCandidate(before, before, scope), {
    ok: false,
    violations: [
      {
        constraint: "unknown-target",
        message: "the selection names cels the view does not have: loop 0 cel 5, loop 4 cel 0",
      },
    ],
  });
});

/** The robot plus loop 2, a 2x1 tail of its own. */
const TAIL = { width: 2, height: 1, transparentColor: 0, pixels: [7, 0] };
const tail = [{ loop: 2, cel: 0 }];

test("a mirror link outside the selection stays, protected or not", () => {
  const before = robot({ cels: ROBOT_CELS }, { mirrorLoop: 0 }, { cels: [TAIL] });
  // Loop 1 unlinked from loop 0, showing the same pixels from its own cels.
  const after = robot(
    { cels: ROBOT_CELS.map(mirrorable) },
    { cels: LOOP_1_ALONE },
    { cels: [TAIL] },
  );
  const check = (protectedLoops?: number[]) =>
    checkCandidate(
      before,
      after,
      viewAssistScope({
        num: 2,
        document: before,
        targetCels: tail,
        ...(protectedLoops ? { protectedLoops } : {}),
      }),
    ).violations;
  assert.deepEqual(check(), [
    {
      constraint: "outside-target",
      loop: 1,
      message: "loop 1 is not selected, but its mirror link would change",
    },
  ]);
  assert.deepEqual(check([1]), [
    { constraint: "protected-loop", loop: 1, message: "protected loop 1 changed alias" },
  ]);
});

const loop0 = [
  { loop: 0, cel: 0 },
  { loop: 0, cel: 1 },
];
const guardMirror = (document: SpriteDocument) =>
  viewAssistScope({ num: 2, document, targetCels: loop0, protectedLoops: [1] });

/** `cel` keying colour 3 as transparent where it used 0: the same display. */
const keyedOn3 = (cel: BuildCelInput): BuildCelInput => ({
  ...cel,
  transparentColor: 3,
  pixels: Array.from(cel.pixels, (colour) => (colour === 0 ? 3 : colour)),
});

test("a selected loop may shed a cel while its protected mirror keeps both", () => {
  // Loop 0 drops its cel 1; loop 1, split off, still shows both cels.
  const before = sprite();
  const after = robot({ cels: [mirrorable(HEAD_0)] }, { cels: LOOP_1_ALONE });
  assert.deepEqual(checkCandidate(before, after, guardMirror(before)), {
    ok: true,
    violations: [],
  });
});

test("splitting a protected mirror lets its link follow, but not its transparency or pixels", () => {
  const before = sprite();
  const [shown0, shown1] = LOOP_1_ALONE as [BuildCelInput, BuildCelInput];
  const rekeyed = robot({ cels: ROBOT_CELS.map(mirrorable) }, { cels: [shown0, keyedOn3(shown1)] });
  assert.deepEqual(checkCandidate(before, rekeyed, guardMirror(before)).violations, [
    {
      constraint: "protected-loop",
      loop: 1,
      cel: 1,
      message: "protected loop 1 changed cel 1's transparent",
    },
  ]);
  // Split and repainted (its eyes blue): the link change is reported with the pixels.
  const blue = (cel: BuildCelInput) => ({
    ...cel,
    pixels: Array.from(cel.pixels, (colour) => (colour === 12 ? 9 : colour)),
  });
  const repainted = robot({ cels: ROBOT_CELS.map(mirrorable) }, { cels: LOOP_1_ALONE.map(blue) });
  assert.deepEqual(checkCandidate(before, repainted, guardMirror(before)).violations, [
    {
      constraint: "protected-loop",
      loop: 1,
      cel: 0,
      count: 1,
      message: "1 pixel changed in loop 1, cel 0 of protected loop 1",
    },
    {
      constraint: "protected-loop",
      loop: 1,
      cel: 1,
      count: 1,
      message: "1 pixel changed in loop 1, cel 1 of protected loop 1",
    },
    { constraint: "protected-loop", loop: 1, message: "protected loop 1 changed alias" },
  ]);
});

test("selecting the mirror does not open its owner's metadata", () => {
  // Loop 0's cel 0 keys colour 3 as transparent; loop 1 shows the same block.
  const before = sprite();
  const after = robot({ cels: [keyedOn3(HEAD_0), HEAD_1] }, { mirrorLoop: 0 });
  const scope = viewAssistScope({ num: 2, document: before, targetCels: loop1 });
  assert.deepEqual(checkCandidate(before, after, scope).violations, [
    {
      constraint: "outside-target",
      loop: 0,
      message: "loop 0 is not selected, but its cel 0 transparent would change",
    },
  ]);
});

test("the loop count, an unselected loop's cel count and the description stay", () => {
  const before = robot({ cels: ROBOT_CELS }, { mirrorLoop: 0 }, { cels: [TAIL] });
  const after = openSprite(
    buildView({
      description: "Other robot",
      loops: [
        { cels: ROBOT_CELS },
        { mirrorLoop: 0 },
        { cels: [TAIL, TAIL] },
        { cels: [{ width: 1, height: 1, transparentColor: 0, pixels: [5] }] },
      ],
    }),
    profile,
  );
  const scope = viewAssistScope({ num: 2, document: before, targetCels: [{ loop: 0, cel: 0 }] });
  assert.deepEqual(checkCandidate(before, after, scope).violations, [
    {
      constraint: "outside-target",
      loop: 2,
      cel: 1,
      count: 2,
      message: "loop 2, cel 1 is not selected, but 2 pixels of it would change",
    },
    {
      constraint: "outside-target",
      loop: 3,
      cel: 0,
      count: 1,
      message: "loop 3, cel 0 is not selected, but 1 pixel of it would change",
    },
    { constraint: "outside-target", message: "the view's loop count would change from 3 to 4" },
    {
      constraint: "outside-target",
      loop: 2,
      message: "loop 2 is not selected, but its cel count would change",
    },
    { constraint: "outside-target", message: "the view's description would change" },
  ]);
});

test("a view exactly at its byte budget fits; a byte over is refused with the overshoot", () => {
  const before = sprite();
  const after = spriteEdit(before, { type: "recolor", scope: loop1, from: 12, to: 9 });
  const size = after.payload.length;
  const scope = (maxBytes: number) =>
    viewAssistScope({ num: 2, document: before, targetCels: loop1, maxBytes });
  assert.deepEqual(checkCandidate(before, after, scope(size)), { ok: true, violations: [] });
  assert.deepEqual(checkCandidate(before, after, scope(size - 1)).violations, [
    {
      constraint: "max-bytes",
      count: size,
      message: `the view would be ${size} bytes, 1 over the ${size - 1}-byte budget`,
    },
  ]);
});

test("in the Art lens a proposal may move or copy a whole mixed target, walk lines and all, but not repaint them", () => {
  // The pond: water art and a barrier line (priority 0) far below it.
  const before = compile(
    [
      '# @item pond "Pond" mixed',
      "vis 1",
      "rect 20,20 40,30",
      "vis off",
      "pri 0",
      "line 20,100 40,100",
      "# @end",
      "end",
    ].join("\n"),
  );
  const scope = pictureAssistScope({ num: 1, compiled: before, targetIds: ["pond"], lens: "art" });
  assert.deepEqual(scope.lockedPlanes, ["priority"]);
  const moved = edit(before, { type: "moveItem", itemId: "pond", dx: 6, dy: 4 });
  assert.deepEqual(checkCandidate(before, moved, scope).violations, []);
  const copied = edit(before, {
    type: "duplicateItem",
    itemId: "pond",
    dx: 50,
    dy: 0,
    newId: "pond-copy",
    newLabel: "Pond copy",
  });
  assert.deepEqual(checkCandidate(before, copied, scope).violations, []);
  // Moving it and recolouring its barrier is painting within the locked plane.
  const repainted = edit(
    before,
    { type: "moveItem", itemId: "pond", dx: 6, dy: 4 },
    { type: "setItemColor", itemId: "pond", plane: "priority", value: 3 },
  );
  assert.deepEqual(
    checkCandidate(before, repainted, scope).violations.map((v) => v.constraint),
    ["locked-plane"],
  );
});
