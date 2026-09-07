import { test } from "node:test";
import assert from "node:assert/strict";
import { gameShortcuts, movementDirection, pcKey, registeredKey } from "../src/gameControls.ts";

function key(key: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    code: "",
    location: 0,
    ...modifiers,
  } as KeyboardEvent;
}

test("navigation and keypad keys cover every AGI movement direction", () => {
  const cases = [
    ["ArrowUp", "Numpad8", "8", 1],
    ["PageUp", "Numpad9", "9", 2],
    ["ArrowRight", "Numpad6", "6", 3],
    ["PageDown", "Numpad3", "3", 4],
    ["ArrowDown", "Numpad2", "2", 5],
    ["End", "Numpad1", "1", 6],
    ["ArrowLeft", "Numpad4", "4", 7],
    ["Home", "Numpad7", "7", 8],
  ] as const;

  for (const [navigation, code, digit, direction] of cases) {
    assert.equal(movementDirection(key(navigation)), direction, navigation);
    assert.equal(
      movementDirection(key(digit, { code, location: 3 })),
      direction,
      `${code} with NumLock on`,
    );
    assert.equal(
      movementDirection(key(navigation, { code, location: 3 })),
      direction,
      `${code} with NumLock off`,
    );
    assert.equal(
      movementDirection(key(digit, { code: "Unidentified", location: 3 })),
      direction,
      `${code} fallback without a usable code`,
    );
  }
});

test("movement ignores modifiers, composition, the center key, and ordinary number keys", () => {
  assert.equal(movementDirection(key("8", { code: "Digit8" })), undefined);
  assert.equal(movementDirection(key("7", { code: "" })), undefined);
  assert.equal(movementDirection(key("5", { code: "Numpad5", location: 3 })), undefined);
  assert.equal(movementDirection(key("5", { code: "Unidentified", location: 3 })), undefined);
  for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
    assert.equal(
      movementDirection(key("8", { code: "Numpad8", location: 3, [modifier]: true })),
      undefined,
      modifier,
    );
  }
  assert.equal(
    movementDirection(key("8", { code: "Numpad8", location: 3, isComposing: true })),
    undefined,
  );
});

test("physical keyboard preserves AGI navigation, function and letter shortcut words", () => {
  assert.equal(pcKey(key("PageUp")), 0x4900);
  assert.equal(pcKey(key("F10")), 0x4400);
  assert.equal(pcKey(key("q", { altKey: true })), 0x1000);
  assert.equal(pcKey(key("C", { ctrlKey: true })), 0x0003);
  assert.equal(pcKey(key("ScrollLock")), 0x4600);
  assert.equal(pcKey(key("8", { code: "Numpad8", location: 3 })), "8".charCodeAt(0));
  assert.equal(pcKey(key("8", { code: "Digit8" })), "8".charCodeAt(0));
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
