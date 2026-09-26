import assert from "node:assert/strict";
import { test } from "node:test";
import { studioKey, type StudioKeyActions } from "../src/studio/studioKeys.ts";

/** Node has no DOM: studioKey's text-field check only needs the class to exist. */
globalThis.HTMLElement ??= class {} as unknown as typeof HTMLElement;

const CANVAS = { id: "canvas" };
const ELSEWHERE = { id: "elsewhere" };

/** Actions that record what ran; the drawing cursor takes keys while `drawing`. */
function actions(drawing: boolean) {
  const calls: string[] = [];
  const act = {
    onCanvas: (target: EventTarget | null) => target === (CANVAS as unknown),
    dismiss: () => false,
    close: () => calls.push("close"),
    lens: () => calls.push("lens"),
    seek: () => calls.push("seek"),
    zoom: () => calls.push("zoom"),
    step: (direction: number) => calls.push(`step ${direction}`),
    nudge: (dx: number, dy: number) => calls.push(`nudge ${dx},${dy}`),
    cursor: (dx: number, dy: number) => (drawing ? calls.push(`cursor ${dx},${dy}`) > 0 : false),
    click: (enter: boolean) => (drawing ? calls.push(enter ? "click enter" : "click") > 0 : false),
    remove: () => calls.push("remove"),
    duplicate: () => calls.push("duplicate"),
    reorder: () => calls.push("reorder"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
    tool: () => false,
    finish: () => calls.push("finish") > 0,
  } satisfies Record<keyof StudioKeyActions, unknown>;
  return { act: act as StudioKeyActions, calls };
}

const key = (name: string, target: object, extra: Partial<KeyboardEvent> = {}) =>
  ({
    key: name,
    target,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...extra,
  }) as unknown as KeyboardEvent;

test("with a drawing tool the canvas arrows move the cursor (Shift 8); Select's nudge", () => {
  const drawing = actions(true);
  assert.equal(studioKey(key("ArrowRight", CANVAS), drawing.act), true);
  assert.equal(studioKey(key("ArrowUp", CANVAS, { shiftKey: true }), drawing.act), true);
  assert.equal(studioKey(key("ArrowDown", CANVAS, { altKey: true }), drawing.act), true);
  assert.deepEqual(drawing.calls, ["cursor 1,0", "cursor 0,-8", "step 1"]);
  const select = actions(false);
  studioKey(key("ArrowLeft", CANVAS, { shiftKey: true }), select.act);
  assert.deepEqual(select.calls, ["nudge -8,0"]);
  // Off the canvas the arrows belong to the focused widget.
  assert.equal(studioKey(key("ArrowLeft", ELSEWHERE), select.act), false);
});

test("Space and Enter on the canvas click at the cursor, once per press", () => {
  const { act, calls } = actions(true);
  assert.equal(studioKey(key(" ", CANVAS), act), true);
  assert.equal(studioKey(key("Enter", CANVAS), act), true);
  assert.equal(studioKey(key(" ", CANVAS, { repeat: true }), act), true);
  assert.deepEqual(calls, ["click", "click enter"]);
  // Elsewhere Enter finishes what is drawn, as it always has; Space is the control's own.
  assert.equal(studioKey(key("Enter", ELSEWHERE), act), true);
  assert.equal(studioKey(key(" ", ELSEWHERE), act), false);
  assert.deepEqual(calls, ["click", "click enter", "finish"]);
});

test("Enter on the canvas without a drawing cursor still finishes", () => {
  const { act, calls } = actions(false);
  assert.equal(studioKey(key("Enter", CANVAS), act), true);
  assert.deepEqual(calls, ["finish"]);
});
