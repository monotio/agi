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
import { compileEditDocument, type CompiledDocument } from "../src/studio/editValidation.ts";
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
