import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";

const compile = (source: string) => assembleLogic(source, { dictionary: new Map() }).payload;

test("shortcut discovery reports actual bindings, menu labels and live enable state without guessing meanings", () => {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    compile(
      'set.key(0,61,7);set.key(0,63,8);set.menu("Adventure");set.menu.item("Inspect",7);submit.menu();return;',
    ),
  );
  const engine = new Engine(game, {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine() {
      return null;
    },
    takeKeys() {
      return [];
    },
  });
  assert.deepEqual(engine.readControls(), []);
  engine.tick();
  assert.deepEqual(engine.readControls(), [
    {
      key: 0x3d00,
      controller: 7,
      menuItems: [{ heading: "Adventure", text: "Inspect", enabled: true }],
    },
    { key: 0x3f00, controller: 8, menuItems: [] },
  ]);
  const detached = engine.readControls();
  detached[0]!.menuItems[0]!.text = "corrupted";
  assert.equal(engine.readControls()[0]!.menuItems[0]!.text, "Inspect");
  engine.patchResource("logic", 0, compile("disable.item(7);return;"));
  engine.tick();
  assert.equal(engine.readControls()[0]!.menuItems[0]!.enabled, false);
  engine.patchResource("logic", 0, compile("set.key(0,61,8);return;"));
  engine.tick();
  assert.deepEqual(engine.readControls()[0], { key: 0x3d00, controller: 8, menuItems: [] });
});
