import { test } from "node:test";
import assert from "node:assert/strict";
import { gameShortcuts, movementDirection } from "../src/play/gameControls.ts";
import { createGamepadPoll, nativeGameKey } from "../src/play/useGameKeys.ts";
import { translatePlatformKey, type JoystickSample } from "../../src/runtime/keys.ts";

const pcKey = (event: KeyboardEvent) => translatePlatformKey(event, "2.936");

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
  // Shift+F1 is its own BIOS word (0x5400), never an alias of F1.
  assert.equal(pcKey(key("F1", { shiftKey: true })), 0x5400);
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
  assert.equal(nativeGameKey(key("q", { altKey: true }), "2.936", [{ key: 0x1000 }]), 0x1000);
});

test("the Command key stays with the browser unless the game binds its word", () => {
  // F-IN-16: Amiga+X is 0x0178; no shipped game binds an Amiga-qualified word.
  const commandX = key("x", { metaKey: true, code: "KeyX" });
  assert.equal(translatePlatformKey(commandX, "amiga-2.202"), 0x0178);
  assert.equal(nativeGameKey(commandX, "amiga-2.202", []), undefined);
  assert.equal(nativeGameKey(commandX, "amiga-2.202", [{ key: 0x0178 }]), 0x0178);
  assert.equal(nativeGameKey(key("v", { metaKey: true }), "2.936", [{ key: 0x76 }]), undefined);
});

function gamepadRig(): {
  sent: (JoystickSample | null)[];
  keys: number[];
  owns: boolean;
  prompt: boolean;
  pad: { x: number; y: number; button1: boolean; button2: boolean };
  poll: () => void;
} {
  const rig = {
    sent: [] as (JoystickSample | null)[],
    keys: [] as number[],
    owns: true,
    prompt: false,
    pad: { x: 0.9, y: 0, button1: false, button2: false },
    poll: () => {},
  };
  rig.poll = createGamepadPoll({
    gameOwnsPad: () => rig.owns,
    sample: () => rig.pad,
    send: (sample) => rig.sent.push(sample),
    prompt: () => rig.prompt,
    promptKey: (code) => rig.keys.push(code),
    presentation: () => "pc",
  });
  return rig;
}

test("the controller follows the keyboard's owner: while a host control holds focus the game gets nothing, its held buttons release, and focus back resumes it with no stuck buttons", () => {
  const rig = gamepadRig();
  rig.poll();
  assert.deepEqual(rig.sent, [rig.pad]);
  // A Settings field or editor takes the keyboard: the held stick posts a
  // neutral sample, and later polls keep it neutral rather than replaying it.
  rig.owns = false;
  rig.poll();
  assert.deepEqual(rig.sent.at(-1), null);
  rig.pad.x = 0;
  rig.poll();
  assert.deepEqual(rig.sent.at(-1), null);
  // Focus back on the game resumes the live sample at once.
  rig.owns = true;
  rig.pad.x = 0.9;
  rig.poll();
  assert.deepEqual(rig.sent.at(-1), rig.pad);
});

test("a fire button released while a host control holds focus does not fire late into the game's prompt", () => {
  const rig = gamepadRig();
  rig.prompt = true;
  rig.pad.button1 = true;
  rig.poll();
  assert.deepEqual(rig.keys, []);
  // The press crosses into a host control, and the finger lifts there.
  rig.owns = false;
  rig.poll();
  rig.pad.button1 = false;
  rig.poll();
  assert.deepEqual(rig.keys, []);
  // Focus returns: the stale release must not reach the waiting prompt.
  rig.owns = true;
  rig.poll();
  assert.deepEqual(rig.keys, []);
  // A fresh press-and-release still fires its word.
  rig.pad.button1 = true;
  rig.poll();
  rig.pad.button1 = false;
  rig.poll();
  assert.deepEqual(rig.keys, [0x0101]);
});
