import assert from "node:assert/strict";
import { test } from "node:test";
import { studioKey, type StudioKeyActions } from "../src/studio/studioKeys.ts";
import { spriteKey, type SpriteKeyActions } from "../src/studio/sprite/spriteKeys.ts";

/**
 * Esc in either Studio only lets go of what is in hand: a menu, a stroke, a
 * selection, a panel. With nothing to let go of it does nothing at all, and
 * Studio stays open; its × button (and the other ways out) close it.
 */

/** Node has no DOM: the text-field check only needs the class to exist. */
globalThis.HTMLElement ??= class {} as unknown as typeof HTMLElement;

/** Actions that record every call by name; `dismiss` answers `dismissed`. */
function recorder<T extends object>(dismissed: boolean): { act: T; calls: string[] } {
  const calls: string[] = [];
  const act = new Proxy({} as T, {
    get: (_, name) =>
      name === "onCanvas"
        ? () => true
        : (..._args: unknown[]) => {
            calls.push(String(name));
            return name === "dismiss" ? dismissed : false;
          },
  });
  return { act, calls };
}

const escape = (target: unknown = null) =>
  ({ key: "Escape", defaultPrevented: false, repeat: false, target }) as unknown as KeyboardEvent;

const STUDIOS = [
  ["Room Studio", (event: KeyboardEvent, act: object) => studioKey(event, act as StudioKeyActions)],
  [
    "Sprite Studio",
    (event: KeyboardEvent, act: object) => spriteKey(event, act as SpriteKeyActions),
  ],
] as const;

for (const [name, press] of STUDIOS) {
  test(`${name}: Esc with nothing to let go of stays in Studio`, () => {
    const { act, calls } = recorder(false);
    assert.equal(press(escape(), act), true);
    assert.deepEqual(calls, ["dismiss"]);
  });

  test(`${name}: Esc lets go of one thing per press`, () => {
    const { act, calls } = recorder(true);
    assert.equal(press(escape(), act), true);
    assert.equal(press(escape(), act), true);
    assert.deepEqual(calls, ["dismiss", "dismiss"]);
  });

  test(`${name}: Esc in a text field leaves the field`, () => {
    const { act, calls } = recorder(false);
    const field = Object.assign(Object.create(HTMLElement.prototype) as HTMLElement, {
      tagName: "INPUT",
      isContentEditable: false,
      blur: () => calls.push("blur"),
    });
    assert.equal(press(escape(field), act), true);
    assert.deepEqual(calls, ["blur"]);
  });
}
