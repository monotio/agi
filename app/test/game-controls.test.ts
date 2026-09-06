import { test } from "node:test";
import assert from "node:assert/strict";
import { pcKey, gameShortcuts, registeredKey } from "../src/gameControls.ts";

function key(key: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...modifiers,
  } as KeyboardEvent;
}

test("physical keyboard preserves AGI navigation, function and letter shortcut words", () => {
  assert.equal(pcKey(key("PageUp")), 0x4900);
  assert.equal(pcKey(key("F10")), 0x4400);
  assert.equal(pcKey(key("q", { altKey: true })), 0x1000);
  assert.equal(pcKey(key("C", { ctrlKey: true })), 0x0003);
  assert.equal(pcKey(key("ScrollLock")), 0x4600);
});

test("composition and native browser shortcuts are not converted to unrelated AGI keys", () => {
  assert.equal(pcKey(key("é", { isComposing: true })), undefined);
  assert.equal(pcKey(key("a", { metaKey: true })), undefined);
  assert.equal(pcKey(key("Tab", { shiftKey: true })), undefined);
  assert.equal(pcKey(key("ArrowLeft", { shiftKey: true })), undefined);
  assert.equal(pcKey(key("F1", { shiftKey: true })), undefined);
  assert.equal(pcKey(key("q", { ctrlKey: true, altKey: true })), undefined);
  assert.equal(pcKey(key("€")), undefined);
});

test("all registered Alt letters have discoverable phone key labels", () => {
  assert.deepEqual(gameShortcuts([{ key: 0x1000, controller: 2, menuItems: [] }])[0], {
    key: 0x1000,
    keyLabel: "Alt+Q",
    label: "Alt+Q",
    hasLabel: false,
    disabled: false,
    heading: "",
  });
  assert.equal(
    registeredKey(key("q", { altKey: true }), [{ key: 0x1000, controller: 2, menuItems: [] }]),
    0x1000,
  );
});
