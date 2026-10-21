import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { nextTick, reactive, shallowRef, watch } from "vue";

// Run the component's actual pointer callbacks and mode watcher with Vue's
// reactive scheduling. No browser is needed to delay a Windows contextmenu.
function rightButtonHarness() {
  const source = readFileSync(new URL("../src/play/PlayArea.vue", import.meta.url), "utf8");
  const start = source.indexOf("type RightButtonOwner = ");
  const end = source.indexOf("/**\n * The Amiga right mouse button", start);
  assert.ok(start >= 0 && end > start);
  const props = reactive({ inspectorDocked: true });
  const gameRoomMenu = shallowRef<{ x: number; y: number; room: number }>();
  const calls: string[] = [];
  const evaluate = new Function(
    "props",
    "gameRoomMenu",
    "watch",
    "calls",
    stripTypeScriptTypes(`
      let menuDrag = false, movePending = null, screenPointerType = "mouse";
      let longPressFired = false, longPressTimer = 0;
      const screenPresentation = { value: "amiga" };
      const amigaMenuReady = { value: true }, amigaMenuOpen = { value: false };
      const engine = { roomMap: { currentRoom: { value: 7 } } };
      const clearLongPress = () => {};
      const sendMenu = () => calls.push("strip");
      const onAmigaRightButton = () => calls.push("game");
      ${source.slice(start, end)}
    `) +
      "; return { down: onScreenPointerDown, up: onScreenPointerUp, menu: onScreenContextMenu };",
  );
  const handlers = evaluate(props, gameRoomMenu, watch, calls) as {
    down(event: object): void;
    up(event: object): void;
    menu(event: object): void;
  };
  const pointer = { button: 2, pointerType: "mouse" };
  const menu = () => {
    let prevented = false;
    handlers.menu({
      button: 2,
      clientX: 100,
      clientY: 150,
      preventDefault: () => (prevented = true),
    });
    return prevented;
  };
  return { props, gameRoomMenu, calls, handlers, pointer, menu };
}

for (const returnBeforeMenu of [false, true]) {
  test(`a Create press is consumed without room actions after leaving the mode (contextmenu in ${returnBeforeMenu ? "Create again" : "Play"})`, async () => {
    const rig = rightButtonHarness();
    rig.handlers.down(rig.pointer);
    rig.props.inspectorDocked = false;
    await nextTick();
    rig.handlers.up(rig.pointer);
    if (returnBeforeMenu) {
      rig.props.inspectorDocked = true;
      await nextTick();
    }
    assert.equal(rig.menu(), true, "the old gesture still consumes the browser contextmenu");
    assert.equal(rig.gameRoomMenu.value, undefined, "the retired Create gesture has no action");
    assert.deepEqual(rig.calls, [], "the gesture cannot fall through to a Play owner");
    rig.props.inspectorDocked = true;
    await nextTick();
    assert.equal(rig.gameRoomMenu.value, undefined, "returning to Create has no stale room menu");
    rig.handlers.down(rig.pointer);
    rig.handlers.up(rig.pointer);
    assert.equal(rig.menu(), true);
    assert.deepEqual(
      rig.gameRoomMenu.value,
      { x: 100, y: 150, room: 7 },
      "a fresh Create gesture works",
    );
  });
}
