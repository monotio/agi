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
    lens: () => calls.push("lens"),
    seek: () => calls.push("seek"),
    zoom: () => calls.push("zoom"),
    step: (direction: number) => calls.push(`step ${direction}`),
    extend: (direction: number) => calls.push(`extend ${direction}`),
    nudge: (dx: number, dy: number) => calls.push(`nudge ${dx},${dy}`),
    cursor: (dx: number, dy: number) => (drawing ? calls.push(`cursor ${dx},${dy}`) > 0 : false),
    click: (enter: boolean) => (drawing ? calls.push(enter ? "click enter" : "click") > 0 : false),
    remove: () => calls.push("remove"),
    duplicate: () => calls.push("duplicate"),
    group: () => calls.push("group"),
    ungroup: () => calls.push("ungroup"),
    reorder: () => calls.push("reorder"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
    tool: () => false,
    finish: () => calls.push("finish") > 0,
    ask: () => calls.push("ask") > 0,
    insertPoint: () => calls.push("insert point") > 0,
    focusMode: () => calls.push("focus mode"),
    keySheet: () => calls.push("key sheet"),
  } satisfies Record<keyof StudioKeyActions, unknown>;
  return { act: act as StudioKeyActions, calls };
}

const key = (name: string, target: object, extra: Partial<KeyboardEvent> = {}) =>
  ({
    key: name,
    code: "",
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

test("Tab and Shift+Tab always move focus; ? opens the sheet", () => {
  const { act, calls } = actions(true);
  assert.equal(studioKey(key("Tab", CANVAS), act), false);
  assert.equal(studioKey(key("Tab", CANVAS, { shiftKey: true }), act), false);
  assert.equal(studioKey(key("Tab", ELSEWHERE), act), false);
  assert.equal(studioKey(key("?", ELSEWHERE, { shiftKey: true }), act), true);
  assert.deepEqual(calls, ["key sheet"]);
});

test("⌘\\ or Ctrl+\\ toggles focus mode from anywhere but a text field, on any layout", () => {
  const { act, calls } = actions(false);
  // US: the Backslash key, with ⌘ on a Mac or Ctrl elsewhere.
  const us = { code: "Backslash" };
  assert.equal(studioKey(key("\\", CANVAS, { ...us, metaKey: true }), act), true);
  assert.equal(studioKey(key("\\", ELSEWHERE, { ...us, ctrlKey: true }), act), true);
  // A held chord toggles once.
  assert.equal(studioKey(key("\\", CANVAS, { ...us, ctrlKey: true, repeat: true }), act), true);
  // A layout that types \ with Alt or AltGr elsewhere: the character decides.
  const altGr = { code: "Minus", ctrlKey: true, altKey: true };
  assert.equal(studioKey(key("\\", CANVAS, altGr), act), true);
  // The modifier changed what `key` reports: the US key position still counts.
  assert.equal(studioKey(key("|", CANVAS, { code: "Backslash", ctrlKey: true }), act), true);
  assert.deepEqual(calls, ["focus mode", "focus mode", "focus mode", "focus mode"]);
  // Not without the modifier, not Shift or Alt on the key position, not in a text field.
  assert.equal(studioKey(key("\\", CANVAS, us), act), false);
  assert.equal(studioKey(key("|", CANVAS, { ...us, shiftKey: true, ctrlKey: true }), act), false);
  assert.equal(studioKey(key("«", CANVAS, { ...us, altKey: true, metaKey: true }), act), false);
  const field = Object.assign(Object.create(HTMLElement.prototype) as HTMLElement, {
    tagName: "TEXTAREA",
    isContentEditable: false,
  });
  assert.equal(studioKey(key("\\", field, { ...us, metaKey: true }), act), false);
  assert.equal(calls.length, 4);
});

test("Enter on the canvas without a drawing cursor still finishes", () => {
  const { act, calls } = actions(false);
  assert.equal(studioKey(key("Enter", CANVAS), act), true);
  assert.deepEqual(calls, ["finish"]);
});

test("Esc in a text field leaves the field; elsewhere, with nothing in hand, it does nothing", () => {
  const { act, calls } = actions(false);
  const field = Object.assign(Object.create(HTMLElement.prototype) as HTMLElement, {
    tagName: "INPUT",
    isContentEditable: false,
    blur: () => calls.push("blur"),
  });
  assert.equal(studioKey(key("Escape", field), act), true);
  assert.deepEqual(calls, ["blur"]);
  assert.equal(studioKey(key("Escape", ELSEWHERE), act), true);
  assert.deepEqual(calls, ["blur"]);
});

test("/ focuses the Ask box from anywhere but a text field", () => {
  const { act, calls } = actions(false);
  assert.equal(studioKey(key("/", ELSEWHERE), act), true);
  assert.equal(studioKey(key("/", CANVAS), act), true);
  const field = Object.assign(Object.create(HTMLElement.prototype) as HTMLElement, {
    tagName: "TEXTAREA",
    isContentEditable: false,
  });
  assert.equal(studioKey(key("/", field), act), false);
  assert.deepEqual(calls, ["ask", "ask"]);
});

test("Insert adds a point to the selected line; + stays zoom", () => {
  const { act, calls } = actions(false);
  assert.equal(studioKey(key("Insert", CANVAS), act), true);
  assert.equal(studioKey(key("+", CANVAS), act), true);
  assert.equal(studioKey(key("Insert", ELSEWHERE, { altKey: true }), act), false);
  assert.deepEqual(calls, ["insert point", "zoom"]);
});

test("Alt+Enter on the canvas adds a point where the cursor stands, as Alt+click does", () => {
  const { act, calls } = actions(false);
  assert.equal(studioKey(key("Enter", CANVAS, { altKey: true }), act), true);
  // Off the canvas it is not a click: no point is added.
  studioKey(key("Enter", ELSEWHERE, { altKey: true }), act);
  assert.deepEqual(
    calls.filter((call) => call === "insert point"),
    ["insert point"],
  );
});

test("Shift+Alt+arrows on the canvas grow the selection to the next or previous item", () => {
  const { act, calls } = actions(false);
  assert.equal(studioKey(key("ArrowDown", CANVAS, { altKey: true, shiftKey: true }), act), true);
  assert.equal(studioKey(key("ArrowRight", CANVAS, { altKey: true, shiftKey: true }), act), true);
  assert.equal(studioKey(key("ArrowUp", CANVAS, { altKey: true, shiftKey: true }), act), true);
  assert.equal(studioKey(key("ArrowLeft", CANVAS, { altKey: true }), act), true);
  // Off the canvas the arrows belong to the widget that has focus.
  assert.equal(
    studioKey(key("ArrowDown", ELSEWHERE, { altKey: true, shiftKey: true }), act),
    false,
  );
  assert.deepEqual(calls, ["extend 1", "extend 1", "extend -1", "step -1"]);
});

test("Cmd/Ctrl+G groups and Shift+Cmd/Ctrl+G ungroups; plain G stays the probe's letter", () => {
  const { act, calls } = actions(false);
  assert.equal(studioKey(key("g", CANVAS, { metaKey: true }), act), true);
  assert.equal(studioKey(key("G", CANVAS, { metaKey: true, shiftKey: true }), act), true);
  assert.equal(studioKey(key("g", ELSEWHERE, { ctrlKey: true }), act), true);
  assert.equal(studioKey(key("G", ELSEWHERE, { ctrlKey: true, shiftKey: true }), act), true);
  assert.deepEqual(calls, ["group", "ungroup", "group", "ungroup"]);
  // Duplicate and focus mode keep their chords.
  assert.equal(studioKey(key("d", CANVAS, { metaKey: true }), act), true);
  assert.equal(studioKey(key("\\", CANVAS, { metaKey: true }), act), true);
  assert.deepEqual(calls.slice(4), ["duplicate", "focus mode"]);
});
