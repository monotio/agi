import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { TEXT_COLS, attr } from "../src/runtime/textSurface.ts";
import { PROFILES } from "../src/runtime/profile.ts";

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
  // Pulldown: box from column 0, width 4 + the frame (the original's
  // OpenWndw draws a fill plus four 1-pixel edge bars, no corner glyphs —
  // kq1 2.917 0x54C8). Frame cells are edge glyphs whose masks carry the
  // measured 1-pixel bar in the foreground over the fill colour.
  const FRAME = attr(0, 15);
  assert.ok(
    attrs(engine, 1, 0, 6).every((a) => a === FRAME),
    "top edge cells",
  );
  assert.equal(engine.textRow(1), "######" + spaces(34));
  assert.equal(engine.textRow(2), "#Save#" + spaces(34));
  assert.equal(engine.textRow(3), "#Quit#" + spaces(34));
  assert.ok(
    attrs(engine, 4, 0, 6).every((a) => a === FRAME),
    "bottom edge cells",
  );
  assert.equal(attrs(engine, 2, 0, 1)[0], FRAME);
  assert.equal(attrs(engine, 2, 5, 6)[0], FRAME);
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
  assert.equal(engine.textRow(2), spaces(11) + "#Look#" + spaces(23));

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
    " Score:0 of 0  " + spaces(15) + "Sound:on  ",
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

function bootV3(source: string): { engine: Engine; host: Host } {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(source, { dictionary: DICT, profile: PROFILES["3.002.149"] }).payload,
  );
  const host = new Host();
  return {
    engine: new Engine(container, host, DICT, { profile: "3.002.149" }),
    host,
  };
}

test("v3 menu.input opens without allow.menu: the interaction gate ships 1", () => {
  // Player-visible rule: a v3 game that never calls allow.menu still opens
  // its menu — the gate word ships 1 in the data image and nothing resets it
  // (mh1 3.002.107 ovl DS+0x5E3 = 01 00; gr1 3.002.149 ovl DS+0x403 = 01 00;
  // no shipped gr1/mh1/demopac4 logic calls allow.menu).
  const { engine } = bootV3(`
    if (!isset(f200)) {
      set(f200); set.menu("File"); set.menu.item("Save", 1); submit.menu(); set(f14);
    }
    if (isset(f201)) { reset(f201); menu.input(); }
    return;
  `);
  engine.tick();
  engine.flags[201] = 1;
  engine.tick();
  engine.tick();
  assert.equal(engine.modalKind, "menu");
});

test("a gated menu request pends and opens when allow.menu re-enables it", () => {
  // Player-visible rule: allow.menu(0) does not cancel a requested menu; the
  // request waits and the menu opens on a later input phase once the gate is
  // nonzero again. menu.input tests f14 only and sets the request word; the
  // gate is consulted at the head of DoMenu and the gated exit leaves the
  // request set (mh1 3.002.107 0x9859 / 0x9895-0x989C; the request word's
  // only clear is the menu-close path 0x993F).
  const { engine } = bootV3(`
    if (!isset(f200)) {
      set(f200); set.menu("File"); set.menu.item("Save", 1); submit.menu(); set(f14);
    }
    if (isset(f201)) { reset(f201); allow.menu(0); menu.input(); }
    if (isset(f202)) { reset(f202); allow.menu(1); }
    return;
  `);
  engine.tick();
  engine.flags[201] = 1;
  engine.tick();
  engine.tick();
  assert.equal(engine.modalKind, null, "the gate holds the menu closed");
  engine.flags[202] = 1;
  engine.tick(); // allow.menu(1) lands in the logic phase, after that input phase
  engine.tick();
  engine.tick();
  assert.equal(engine.modalKind, "menu", "the pending request opens once ungated");
});

// ---------- restart and restore (docs/fidelity.md "Original menu across restart and restore") ----------

/**
 * Builds and submits the menu only while f6 is clear, the way the shipped
 * games guard their one-time setup, and disables one item. The rest of the
 * boot block runs on every boot, restart included.
 */
const RESTART_MENU_GAME = `
  if (!isset(f200)) {
    set(f200);
    if (!isset(f6)) {
      set.menu("File");
      set.menu.item("Save", 1);
      set.menu.item("Quit", 2);
      set.menu("Empty");
      set.menu("Game");
      set.menu.item("Look", 3);
      submit.menu();
      disable.item(2);
    }
    set(f14);
    set(f16);
  }
  if (isset(f201)) { reset(f201); menu.input(); }
  if (isset(f203)) { reset(f203); restart.game(); }
  if (isset(f204)) { reset(f204); save.game(); }
  if (isset(f205)) { reset(f205); disable.item(1); disable.item(3); }
  if (isset(f206)) { reset(f206); restore.game(); }
  if (isset(f207)) { reset(f207); submit.menu(); }
  if (isset(f12)) { assignn(v110, 1); }
  return;
`;

class SaveHost extends Host {
  saved: Uint8Array | null = null;
  saveGame(bytes: Uint8Array): void {
    this.saved = bytes.slice();
  }
  restoreGame(): Uint8Array | null {
    return this.saved;
  }
}

function bootRestartMenu(profile?: "2.272" | "2.936"): { engine: Engine; host: SaveHost } {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    // 2.272 has no menu.input action; its other menu actions are stubs.
    assembleLogic(
      profile === "2.272"
        ? RESTART_MENU_GAME.replace("if (isset(f201)) { reset(f201); menu.input(); }", "")
        : RESTART_MENU_GAME,
      {
        dictionary: DICT,
        ...(profile ? { profile: PROFILES[profile] } : {}),
      },
    ).payload,
  );
  const host = new SaveHost();
  const engine = new Engine(container, host, DICT, profile ? { profile } : undefined);
  engine.tick();
  return { engine, host };
}

const enabledItems = (engine: Engine) =>
  engine.readMenuState().headings.map((h) => h.items.map((item) => item.enabled));

test("after a restart the game's menu is still there and every item is enabled", () => {
  // Player-visible rule: a game that builds its menu only on the cold boot
  // still has it after Restart, with every item enabled until the game
  // disables one again (PC 2.411..3.002.149, Amiga, IIgs: the accepted
  // restart keeps the strip and runs EnableAllItems, GR1 0x276c -> 0x9648).
  const { engine } = bootRestartMenu();
  assert.deepEqual(enabledItems(engine), [[true, false], [], [true]]);
  const before = engine.readMenuState();
  const resets = engine.runResetSerial;
  engine.flags[203] = 1;
  engine.tick();
  assert.notEqual(engine.runResetSerial, resets, "the restart was accepted");
  const after = engine.readMenuState();
  assert.equal(after.finalized, true, "the menu stays submitted");
  assert.deepEqual(
    after.headings.map((h) => [h.title, h.enabled, h.items.map((item) => item.text)]),
    before.headings.map((h) => [h.title, h.enabled, h.items.map((item) => item.text)]),
    "the same headings and items, in order",
  );
  assert.deepEqual(enabledItems(engine), [[true, true], [], [true]], "every item enabled");
  assert.equal(after.heading, before.heading, "the current heading is kept");
  openMenu(engine);
  assert.equal(engine.modalKind, "menu", "the menu opens after the restart");
  assert.match(engine.textRow(0), /File Empty Game/);
});

test("a game that submits its menu again after a restart starts it at the first heading", () => {
  // submit.menu has no submitted guard: re-running it puts the current
  // heading and item back to the first (GR1 0x960b..0x9618).
  const { engine, host } = bootRestartMenu();
  openMenu(engine);
  engine.modalNavigate(3); // Game
  engine.modalNavigate(7); // back to File, then down to Quit
  engine.modalNavigate(5);
  host.keys.push(0x1b);
  engine.tick();
  const open = engine.readMenuState();
  assert.equal(open.headings[0]!.current, 1, "Quit was current when the menu closed");
  engine.flags[203] = 1;
  engine.tick();
  assert.equal(engine.readMenuState().headings[0]!.current, 1, "restart keeps the current item");
  engine.flags[207] = 1;
  engine.tick();
  const resubmitted = engine.readMenuState();
  assert.equal(resubmitted.heading, 0);
  assert.deepEqual(
    resubmitted.headings.map((h) => h.current),
    [0, 0, 0],
  );
});

test("after a restore every menu item is enabled and f12 is set", () => {
  // Player-visible rule: items the game disabled come back enabled after a
  // successful restore; the save holds no item states and the restore tail
  // runs EnableAllItems (GR1 0x2925 -> 0x9648).
  const { engine, host } = bootRestartMenu();
  engine.flags[204] = 1;
  engine.tick();
  assert.ok(host.saved, "the game saved");
  engine.flags[205] = 1;
  engine.tick();
  assert.deepEqual(enabledItems(engine), [[false, false], [], [false]]);
  engine.flags[206] = 1;
  engine.tick();
  assert.deepEqual(enabledItems(engine), [[true, true], [], [true]]);
  assert.equal(engine.readMenuState().finalized, true);
  assert.equal(engine.vars[110], 1, "the restored pass saw f12");
});

test("a host restore keeps the recorded menu item states", () => {
  // History and autosave restore the recorded menu; only the game's own
  // restore.game re-enables the items.
  const { engine } = bootRestartMenu();
  const image = engine.recordingImage(true);
  assert.ok(image);
  const menus = engine.readMenuState();
  engine.restoreImage(image);
  assert.equal(engine.restoreMenuState(menus), true);
  assert.deepEqual(enabledItems(engine), [[true, false], [], [true]]);
});

test("2.272 builds no menu, so a restart has none to keep", () => {
  const { engine } = bootRestartMenu("2.272");
  engine.flags[203] = 1;
  engine.tick();
  assert.deepEqual(engine.readMenuState().headings, []);
  assert.equal(engine.readMenuState().finalized, false);
});
