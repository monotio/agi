import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cropFrameRgba,
  describeDebugEvent,
  describeObject,
  formatTraceRecord,
  inspectPixel,
  latchIsStale,
  latchPickAt,
  overlayBoxes,
  pickFromClient,
  type DebugEvent,
  type PickPoint,
} from "../src/debugView.ts";
import type { Frame } from "../src/gameTypes.ts";
import type { ScreenObjectState } from "../../src/runtime/engine.ts";

function frameFixture(): Frame {
  const visual = new Uint8Array(160 * 168).fill(15);
  const priority = new Uint8Array(160 * 168).fill(9);
  const ownership = new Uint16Array(160 * 168);
  visual[50 * 160 + 40] = 4;
  priority[50 * 160 + 40] = 11;
  ownership[50 * 160 + 40] = 3; // object num 2
  return {
    visual,
    priority,
    ownership,
    text: new Uint8Array(40 * 25 * 2),
    picRow: 1,
    cycle: 42,
  };
}

test("pickFromClient maps client pixels to displayed and logical space", () => {
  // Canvas displayed at 640x400 (2x), picRow 1 → picture band starts row 8.
  const rect = { left: 10, top: 20, width: 640, height: 400 };
  const p = pickFromClient(10 + 320, 20 + 200, rect, 1)!;
  assert.deepEqual(p.displayed, { x: 160, y: 100 });
  assert.deepEqual(p.logical, { x: 80, y: 92 });
});

test("pickFromClient reports rows above the picture band as non-logical", () => {
  const rect = { left: 0, top: 0, width: 640, height: 400 };
  const p = pickFromClient(100, 4, rect, 1)!; // displayed y = 2 < picRow*8
  assert.equal(p.logical, null);
  assert.deepEqual(p.displayed, { x: 50, y: 2 });
});

test("inspectPixel returns color, priority, and owning object", () => {
  const frame = frameFixture();
  assert.deepEqual(inspectPixel(frame, 40, 50), { color: 4, priority: 11, owner: 2 });
  assert.deepEqual(inspectPixel(frame, 0, 0), { color: 15, priority: 9, owner: null });
  assert.equal(inspectPixel(frame, 200, 50), null);
});

test("cropFrameRgba extracts a clamped square around the point", () => {
  const frame = frameFixture();
  const crop = cropFrameRgba(frame, 40, 50, 4);
  assert.equal(crop.width, 9);
  assert.equal(crop.height, 9);
  // Centre pixel (40,50) is red (EGA 4).
  const o = (4 * 9 + 4) * 4;
  assert.deepEqual([...crop.data.slice(o, o + 4)], [0xaa, 0, 0, 255]);
  // Edge-clamped: point (0,0) keeps a full-size window starting at 0,0.
  const corner = cropFrameRgba(frame, 0, 0, 4);
  assert.equal(corner.width, 9);
});

test("describeDebugEvent names well-known vars and flags", () => {
  const roomChange: DebugEvent = { seq: 1, cycle: 7, kind: "var", index: 0, from: 3, to: 5 };
  assert.equal(describeDebugEvent(roomChange), "v0 room 3 → 5");
  const flag: DebugEvent = { seq: 2, cycle: 8, kind: "flag", index: 4, from: 0, to: 1 };
  assert.equal(describeDebugEvent(flag), "f4 said ready set");
  const flagOff: DebugEvent = { seq: 3, cycle: 9, kind: "flag", index: 4, from: 1, to: 0 };
  assert.equal(describeDebugEvent(flagOff), "f4 said ready reset");
  const anon: DebugEvent = { seq: 4, cycle: 1, kind: "var", index: 200, from: 1, to: 9 };
  assert.equal(describeDebugEvent(anon), "v200 1 → 9");
});

test("formatTraceRecord prints names, operands, and test results", () => {
  assert.equal(
    formatTraceRecord({ logic: 3, pc: 41, op: 0x03, args: [4, 2], name: "assignn" }),
    "L3 pc41 assignn(4,2)",
  );
  assert.equal(
    formatTraceRecord({ logic: 0, pc: 7, op: 0x85, args: [3, 1], name: "equaln", result: false }),
    "L0 pc7 equaln(3,1) → false",
  );
  assert.equal(formatTraceRecord({ logic: 1, pc: 2, op: 0x0b, args: [] }), "L1 pc2 0x0b()");
});

test("overlayBoxes converts object records to logical-pixel boxes", () => {
  const [box] = overlayBoxes([
    {
      num: 2,
      view: 10,
      loop: 0,
      cel: 1,
      x: 40,
      y: 100,
      width: 12,
      height: 20,
      priority: 9,
      fixedPriority: false,
      direction: 3,
      stepSize: 1,
      stepTime: 1,
      cycling: true,
      cycleMode: 0,
      cycleTime: 1,
      motionMode: 0,
      update: true,
    },
  ]);
  assert.deepEqual(box, {
    x: 40,
    y: 81,
    w: 12,
    h: 20,
    baseline: 100,
    label: "o2",
    priority: 9,
    direction: 3,
    stepSize: 1,
    moveTarget: null,
    follow: false,
    wander: false,
  });
});

function objectFixture(over: Partial<ScreenObjectState> = {}): ScreenObjectState {
  return {
    num: 2,
    view: 10,
    loop: 0,
    cel: 1,
    x: 40,
    y: 100,
    width: 12,
    height: 20,
    priority: 11,
    fixedPriority: false,
    direction: 3,
    stepSize: 1,
    stepTime: 1,
    cycling: true,
    cycleMode: 0,
    cycleTime: 1,
    motionMode: 0,
    update: true,
    ...over,
  };
}

const PICK: PickPoint = { logical: { x: 40, y: 50 }, displayed: { x: 80, y: 58 } };

test("latchPickAt freezes the object snapshot and frame identity at click time", () => {
  const frame = frameFixture();
  frame.patchGeneration = 7;
  frame.objects = [objectFixture()];
  const latch = latchPickAt(frame, PICK)!;
  assert.equal(latch.cycle, 42);
  assert.equal(latch.patchGeneration, 7); // the frame's own revision, not a poll
  assert.equal(describeObject(latch.object!), "o2 · view 10 loop 0 cel 1 · pri 11 · normal");

  // The object moves, changes, then disappears in later observations; newer
  // frames arrive out of order. The latched card keeps its original fields.
  frame.objects[0]!.x = 99;
  frame.objects[0]!.view = 77;
  frame.objects.length = 0;
  const stale = { ...frame, cycle: 41, objects: [objectFixture({ num: 2, x: 5 })] };
  const newer = { ...frame, cycle: 55, patchGeneration: 8, objects: [] };
  assert.equal(describeObject(latch.object!), "o2 · view 10 loop 0 cel 1 · pri 11 · normal");
  assert.equal(latch.cycle, 42);
  assert.equal(latch.patchGeneration, 7);
  assert.ok(latchIsStale(latch, stale)); // restore/seek/new game regresses cycle
  assert.ok(!latchIsStale(latch, newer));
  assert.ok(!latchIsStale(latch, null));
});

test("latchPickAt records no object identity for non-sprite layer picks", () => {
  const frame = frameFixture();
  frame.objects = [objectFixture()];
  const flat = latchPickAt(frame, PICK)!;
  assert.equal(flat.object?.num, 2); // flat 2D picks name the owner
  const picture: PickPoint = { ...PICK, layerKind: "picture", layerBand: 4 };
  const latch = latchPickAt(frame, picture)!;
  assert.equal(latch.object, null); // even though the mask reports owner 2
  assert.equal(latch.inspection.owner, 2);
});

test("latchPickAt returns null off the picture band and drops the latch on regression", () => {
  const frame = frameFixture();
  assert.equal(latchPickAt(frame, { ...PICK, logical: null }), null);
  const latch = latchPickAt(frame, PICK)!;
  // cycle went backwards without a defined cycle on the latch → not stale
  assert.ok(!latchIsStale({ ...latch, cycle: null }, frame));
});
