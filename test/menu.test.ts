import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { TEXT_COLS, attr } from "../src/runtime/textSurface.ts";

/**
 * Menu bar and pulldown interaction (spec "Menu construction" and "Menu
 * interaction"). Cell layout hand-computed: headings from column 1, one
 * space apart; the pulldown is a bordered box under the heading.
 */

const DICT = new Map<string, number>();
const BAR = attr(0, 15);
const SELECTED = attr(15, 0);
const DISABLED = attr(8, 15);
const spaces = (n: number): string => " ".repeat(n);

class Host implements EngineHost {
  keys: number[] = [];
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
}

const MENU_GAME = `
  configure.screen(1, 22, 0);
  if (!isset(f200)) {
    set(f200);
    set.menu("File");
    set.menu.item("Save", 1);
    set.menu.item("Quit", 2);
    set.menu("Empty");
    set.menu("Game");
    set.menu.item("Look", 3);
    submit.menu();
    set.menu("Late");
    set.menu.item("Never", 4);
    set(f14);
    status.line.on();
  }
  if (isset(f201)) { reset(f201); menu.input(); }
  if (isset(f202)) { reset(f202); disable.item(2); }
  if (controller(2)) { assignn(v100, 7); }
  return;
`;

function boot(): { engine: Engine; host: Host } {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(MENU_GAME, { dictionary: DICT }).payload);
  const host = new Host();
  const engine = new Engine(container, host, DICT);
  engine.tick();
  return { engine, host };
}

function attrs(engine: Engine, r: number, from: number, to: number): number[] {
  const out: number[] = [];
  for (let c = from; c < to; c++) out.push(engine.textCells[(r * TEXT_COLS + c) * 2 + 1]!);
  return out;
}

/** Request the menu (f201) and run the cycle that opens it. */
function openMenu(engine: Engine): void {
  engine.flags[201] = 1;
  engine.tick(); // logic requests the menu
  engine.tick(); // input phase opens it
}

test("host menu state restores a fresh interpreter without changing the AGI save image", () => {
  const { engine } = boot();
  engine.flags[202] = 1;
  engine.tick();
  const image = engine.serialize();
  const menus = engine.readMenuState();
  assert.deepEqual(engine.serialize(), image);
  assert.equal(menus.headings[0]!.items[1]!.enabled, false);

  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(MENU_GAME, { dictionary: DICT }).payload);
  const restored = new Engine(container, new Host(), DICT);
  restored.restoreImage(image);
  assert.equal(restored.restoreMenuState(menus), true);
  assert.deepEqual(restored.readMenuState(), menus);
  menus.headings[0]!.title = "corrupted";
  assert.equal(restored.readMenuState().headings[0]!.title, "File");
  const before = restored.readMenuState();
  assert.equal(restored.restoreMenuState({ ...before, heading: 999 }), false);
  assert.equal(restored.restoreMenuState({ ...before, headings: [null] }), false);
  assert.deepEqual(restored.readMenuState(), before);
  openMenu(restored);
  assert.equal(restored.modalKind, "menu");
  assert.match(restored.textRow(0), /File.*Game/);
  assert.match(restored.textRow(2), /Save/);
});

test("menu.input opens the bar and the root heading's pulldown at the next input phase", () => {
  const { engine } = boot();
  assert.equal(engine.modalKind, null);
  openMenu(engine);
  assert.equal(engine.modalKind, "menu");
  // Bar: " File Empty Game" — the late heading was ignored after submit.menu.
  assert.equal(engine.textRow(0), " File Empty Game" + spaces(24));
  assert.deepEqual(attrs(engine, 0, 1, 5), Array(4).fill(SELECTED), "root heading highlighted");
  assert.deepEqual(attrs(engine, 0, 6, 11), Array(5).fill(BAR));
  // Pulldown: box from column 0, width 4 + border.
  assert.equal(engine.textRow(1), "######" + spaces(34));
  assert.equal(engine.textRow(2), "#Save#" + spaces(34));
  assert.equal(engine.textRow(3), "#Quit#" + spaces(34));
  assert.equal(engine.textRow(4), "######" + spaces(34));
  assert.deepEqual(attrs(engine, 2, 1, 5), Array(4).fill(SELECTED), "first item selected");
  assert.deepEqual(attrs(engine, 3, 1, 5), Array(4).fill(BAR));
});

test("item and heading navigation: circular items, disabled headings skipped, items remembered", () => {
  const { engine } = boot();
  openMenu(engine);
  engine.modalNavigate(5); // next item -> Quit
  assert.deepEqual(attrs(engine, 3, 1, 5), Array(4).fill(SELECTED));
  engine.modalNavigate(5); // wraps to Save
  assert.deepEqual(attrs(engine, 2, 1, 5), Array(4).fill(SELECTED));
  engine.modalNavigate(1); // previous wraps to Quit
  assert.deepEqual(attrs(engine, 3, 1, 5), Array(4).fill(SELECTED));

  engine.modalNavigate(3); // next enabled heading skips "Empty" -> Game
  assert.deepEqual(attrs(engine, 0, 12, 16), Array(4).fill(SELECTED));
  assert.deepEqual(attrs(engine, 0, 1, 5), Array(4).fill(BAR));
  assert.equal(engine.textRow(1), spaces(11) + "######" + spaces(23));
  assert.equal(engine.textRow(2), spaces(11) + "#Look#" + spaces(23));
  assert.equal(engine.textRow(3), spaces(11) + "######" + spaces(23));

  engine.modalNavigate(7); // previous enabled heading -> File, Quit still current
  assert.deepEqual(attrs(engine, 3, 1, 5), Array(4).fill(SELECTED));
  engine.modalNavigate(2); // first item
  assert.deepEqual(attrs(engine, 2, 1, 5), Array(4).fill(SELECTED));
  engine.modalNavigate(4); // last item
  assert.deepEqual(attrs(engine, 3, 1, 5), Array(4).fill(SELECTED));
  engine.modalNavigate(6); // last heading
  assert.deepEqual(attrs(engine, 0, 12, 16), Array(4).fill(SELECTED));
  engine.modalNavigate(8); // root heading
  assert.deepEqual(attrs(engine, 0, 1, 5), Array(4).fill(SELECTED));
});

test("Enter selects an enabled item as a mapped event visible to the next cycle's logic", () => {
  const { engine, host } = boot();
  openMenu(engine);
  host.keys.push(0x5000); // extended down-arrow key word -> navigation 5
  engine.tick();
  assert.deepEqual(attrs(engine, 3, 1, 5), Array(4).fill(SELECTED));
  host.keys.push(0x0d);
  engine.tick(); // Enter closes the menu and queues the mapped event
  assert.equal(engine.modalKind, null);
  assert.equal(engine.textRow(1), spaces(40), "pulldown restored");
  assert.equal(
    engine.textRow(0),
    " Score: 0 of 0" + spaces(16) + "Sound:off ",
    "status line redrawn",
  );
  engine.tick(); // the input phase delivers controller 2 to logic 0
  assert.equal(engine.vars[100], 7);
});

test("Escape closes without selection; Enter on a disabled item keeps waiting", () => {
  const { engine, host } = boot();
  engine.flags[202] = 1; // disable.item(2)
  engine.tick();
  openMenu(engine);
  engine.modalNavigate(5);
  assert.deepEqual(attrs(engine, 3, 1, 5), Array(4).fill(SELECTED));
  engine.modalNavigate(1);
  assert.deepEqual(attrs(engine, 3, 1, 5), Array(4).fill(DISABLED), "disabled item is grey");
  engine.modalNavigate(5);
  host.keys.push(0x0d);
  engine.tick();
  assert.equal(engine.modalKind, "menu", "Enter on a disabled item does nothing");
  host.keys.push(0x1b);
  engine.tick();
  assert.equal(engine.modalKind, null);
  engine.tick();
  assert.equal(engine.vars[100], 0, "no mapped event");
});

test("menu.input is ignored while f14 is clear", () => {
  const { engine } = boot();
  engine.flags[14] = 0;
  openMenu(engine);
  assert.equal(engine.modalKind, null);
});
