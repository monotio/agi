import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";
import {
  intuitionMenuChrome,
  intuitionPulldown,
  intuitionTitles,
} from "../src/runtime/nativeMenu.ts";
import { AGI_KEY } from "../src/runtime/keys.ts";

/**
 * The Amiga native menu: Intuition pull-downs the interpreter builds from
 * set.menu/set.menu.item, opened by the right mouse button and gated per
 * build (docs/fidelity.md "Original native menu dispatch" and "Original
 * Amiga menu strip and pull-downs"). The player sees the Kickstart menu bar
 * replace the title bar while the button is held, the pull-down under the
 * title, and the game acts on the released item at the next cycle.
 */

const DICT = new Map<string, number>();

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

/**
 * SQ2 Amiga's strip, as the fixture's logic 0 submits it (ids from the game).
 * The first picture uses overlay.pic so it shows at once: these tests are
 * about the menu, and a drawn picture would dissolve first (f203 draws one).
 */
const MENU_GAME = `
  configure.screen(1, 22, 0);
  if (!isset(f200)) {
    set(f200);
    load.pic(v250); overlay.pic(v250); show.pic();
    set.menu("Sierra");
    set.menu.item("About SQ2", 21);
    set.menu.item("Help     ", 2);
    set.menu("File");
    set.menu.item("Save     <F5>", 3);
    set.menu.item("Restore  <F7>", 5);
    set.menu.item("-------------", 20);
    set.menu.item("Restart  <F9>", 7);
    set.menu.item("Quit  <Alt-Z>", 1);
    set.menu("Action");
    set.menu.item("See Object  <F4>", 22);
    set.menu.item("Inventory  <Tab>", 10);
    set.menu("Special");
    set.menu.item("Sound On/Off       <F2>", 16);
    set.menu.item("Joystick       <Ctrl J>", 15);
    set.menu.item("Pause             <Esc>", 18);
    set.menu("Speed");
    set.menu.item("Normal ", 24);
    set.menu.item("Slow   ", 25);
    set.menu.item("Fast   ", 23);
    set.menu.item("Fastest", 28);
    submit.menu();
    disable.item(20);
    set(f14);
    status.line.on();
  }
  if (controller(3)) { assignn(v100, 3); }
  if (controller(5)) { assignn(v100, 5); }
  if (controller(7)) { assignn(v100, 7); }
  if (isset(f201)) { reset(f201); print("Hello"); }
  if (isset(f202)) { reset(f202); text.screen(); }
  if (isset(f203)) { reset(f203); draw.pic(v250); show.pic(); }
  return;
`;

function boot(profile: ProfileId = "amiga-2.202"): { engine: Engine; host: Host } {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(MENU_GAME, { dictionary: DICT }).payload);
  container.putResource("picture", 0, Uint8Array.of(0xff));
  const host = new Host();
  const engine = new Engine(container, host, DICT, { profile: PROFILES[profile] });
  engine.tick();
  engine.tick();
  return { engine, host };
}

test("title strip geometry follows the interpreter's Menu structs: 8 x (len + 1) wide, text 2 px in", () => {
  const { engine } = boot();
  const titles = intuitionTitles(engine.readMenuState().headings);
  assert.deepEqual(
    titles.map((t) => [t.text, t.left, t.width]),
    [
      ["Sierra", 0, 56],
      ["File", 56, 40],
      ["Action", 96, 56],
      ["Special", 152, 64],
      ["Speed", 216, 48],
    ],
  );
});

test("pull-down boxes: item width 8 x len + 8, box 8 wider and 9 rows per item plus 8, clamped to the screen", () => {
  const { engine } = boot();
  const headings = engine.readMenuState().headings;
  // File (LeftEdge 56): box 54..173 x 9..61 as measured on MAME.
  const file = intuitionPulldown(headings, 1)!;
  assert.deepEqual([file.x0, file.y0, file.x1, file.y1], [54, 9, 173, 61]);
  assert.deepEqual(
    file.items.map((it) => [it.x0, it.y0, it.x1, it.y1, it.enabled]),
    [
      [58, 13, 169, 21, true],
      [58, 22, 169, 30, true],
      [58, 31, 169, 39, false],
      [58, 40, 169, 48, true],
      [58, 49, 169, 57, true],
    ],
  );
  // Sierra (LeftEdge 0): the box would start at -2 and is kept on screen at 0..87.
  const sierra = intuitionPulldown(headings, 0)!;
  assert.deepEqual([sierra.x0, sierra.y0, sierra.x1, sierra.y1], [0, 9, 87, 34]);
  assert.deepEqual([sierra.items[0]!.x0, sierra.items[0]!.y0], [4, 13]);
});

test("a first item that would overflow the right edge shifts the whole pull-down left (h221+0x19c)", () => {
  const headings = [
    { title: "Sierra", enabled: true, current: 0, items: [] },
    { title: "File", enabled: true, current: 0, items: [] },
    { title: "Action", enabled: true, current: 0, items: [] },
    {
      title: "Special",
      enabled: true,
      current: 0,
      items: [{ text: "Pause Game             ", id: 18, enabled: true }],
    },
  ];
  // LeftEdge 152, item width 192: 152 + 192 >= 320, so items start at 64 - 192 = -128.
  const special = intuitionPulldown(headings, 3)!;
  assert.deepEqual([special.x0, special.x1], [22, 221]);
  assert.deepEqual([special.items[0]!.x0, special.items[0]!.x1], [26, 217]);
});

test("the gate: f14 on 2.176..2.333, never on 2.082; an open window or text mode inhibits every build", () => {
  for (const profile of ["amiga-2.082", "amiga-2.176", "amiga-2.202", "amiga-2.310"] as const) {
    const { engine } = boot(profile);
    assert.equal(engine.nativeMenuAvailable, true, `${profile} with f14 set`);
    engine.flags[14] = 0;
    assert.equal(
      engine.nativeMenuAvailable,
      profile === "amiga-2.082",
      `${profile} with f14 clear`,
    );
    engine.flags[14] = 1;
    engine.flags[201] = 1;
    engine.tick();
    assert.equal(engine.modalKind, "print");
    assert.equal(engine.nativeMenuAvailable, false, `${profile} with a window open`);
    engine.ackPrint();
    engine.tick();
    assert.equal(engine.nativeMenuAvailable, true);
    engine.flags[202] = 1;
    engine.tick();
    assert.equal(engine.textModeActive, true);
    assert.equal(engine.nativeMenuAvailable, false, `${profile} in text mode`);
  }
  const pc = boot("2.936");
  assert.equal(pc.engine.nativeMenuAvailable, false, "PC builds open menus through menu.input");
});

test("the strip stays shut during a picture dissolve and opens once it ends (MENUVERIFY busy flag)", () => {
  // docs/fidelity.md "Original picture dissolve", "During the dissolve": the
  // loop's busy flag makes MENUVERIFY refuse the pull; a held button does not
  // open the strip later.
  const { engine } = boot();
  engine.flags[203] = 1;
  engine.tick();
  assert.equal(engine.modalKind, "dissolve");
  assert.equal(engine.nativeMenuAvailable, false);
  assert.equal(engine.nativeMenuOpen(3, 2), false, "refused mid-dissolve");
  assert.equal(engine.modalKind, "dissolve");
  engine.advanceClock(794.2 - 0.01);
  assert.equal(engine.nativeMenuOpen(3, 2), false, "refused until the last cell");
  engine.advanceClock(0.01);
  assert.equal(engine.modalKind, null);
  assert.equal(engine.nativeMenuOpen(3, 2), true, "opens after the dissolve");
  assert.equal(engine.modalKind, "menu");
});

test("holding the right button opens the strip; the pull-down follows the title under the pointer", () => {
  const { engine } = boot();
  assert.equal(engine.nativeMenuOpen(3, 2), true);
  assert.equal(engine.modalKind, "menu");
  let chrome = engine.getPresentation().menu!;
  assert.equal(engine.getPresentation().statusBar, null, "the strip replaces the title bar");
  assert.deepEqual(
    chrome.titles.map((t) => t.highlighted),
    [true, false, false, false, false],
  );
  assert.equal(chrome.pulldown!.items.length, 2);
  // Moving along the bar switches the pull-down; moving into an item highlights it.
  assert.equal(engine.nativeMenuMove(70, 4), true);
  chrome = engine.getPresentation().menu!;
  assert.equal(chrome.titles[1]!.highlighted, true);
  assert.equal(chrome.pulldown!.items.length, 5);
  assert.equal(chrome.pulldown!.highlighted, null);
  assert.equal(engine.nativeMenuMove(70, 25), true);
  assert.equal(engine.getPresentation().menu!.pulldown!.highlighted, 1);
  assert.equal(engine.nativeMenuMove(72, 25), false, "no change reports no change");
  // A ghosted item never highlights.
  engine.nativeMenuMove(70, 35);
  assert.equal(engine.getPresentation().menu!.pulldown!.highlighted, null);
  // Leaving the pull-down keeps it open with no item.
  engine.nativeMenuMove(300, 150);
  chrome = engine.getPresentation().menu!;
  assert.equal(chrome.titles[1]!.highlighted, true);
  assert.equal(chrome.pulldown!.highlighted, null);
});

test("releasing over an enabled item delivers its controller at the next input phase, once", () => {
  const { engine } = boot();
  engine.nativeMenuOpen(70, 4);
  engine.nativeMenuMove(70, 25);
  engine.nativeMenuRelease(70, 25);
  assert.equal(engine.modalKind, null);
  assert.equal(engine.vars[100], 0, "nothing until the next cycle");
  engine.tick();
  assert.equal(engine.vars[100], 5, "Restore (controller 5) seen by the logic");
  engine.vars[100] = 0;
  engine.tick();
  assert.equal(engine.vars[100], 0, "delivered exactly once");
});

test("releasing elsewhere, over a ghosted item or on the bar cancels without a controller", () => {
  for (const [x, y] of [
    [300, 150],
    [70, 35],
    [70, 4],
  ] as const) {
    const { engine } = boot();
    engine.nativeMenuOpen(70, 4);
    engine.nativeMenuRelease(x, y);
    assert.equal(engine.modalKind, null);
    engine.tick();
    assert.equal(engine.vars[100], 0, `release at ${x},${y}`);
  }
});

test("statuses 128..255 select nothing: the original's signed write lands outside the controller table", () => {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `
      configure.screen(1, 22, 0);
      if (!isset(f200)) {
        set(f200);
        set.menu("File");
        set.menu.item("High", 200);
        set.menu.item("Low", 100);
        submit.menu();
        set(f14);
      }
      if (controller(200)) { assignn(v100, 1); }
      if (controller(100)) { assignn(v100, 2); }
      return;
      `,
      { dictionary: DICT },
    ).payload,
  );
  const engine = new Engine(container, new Host(), DICT, { profile: PROFILES["amiga-2.310"] });
  engine.tick();
  engine.tick();
  engine.nativeMenuOpen(10, 2);
  engine.nativeMenuRelease(10, 16);
  engine.tick();
  assert.equal(engine.vars[100], 0, "status 200 writes before the table and sets no controller");
  engine.nativeMenuOpen(10, 2);
  engine.nativeMenuRelease(10, 25);
  engine.tick();
  assert.equal(engine.vars[100], 2);
});

test("the game clock stops while the menu is held (MENUVERIFY freeze flag) and resumes after", () => {
  const { engine } = boot();
  engine.advanceClock(500);
  engine.nativeMenuOpen(3, 2);
  assert.equal(engine.timerPaused, true);
  engine.advanceClock(5000);
  assert.equal(engine.vars[11], 0, "no seconds passed under the menu");
  engine.nativeMenuRelease(300, 150);
  assert.equal(engine.timerPaused, false);
  engine.advanceClock(500);
  assert.equal(engine.vars[11], 1);
});

test("a checkpoint is refused while the menu is open", () => {
  const { engine } = boot();
  assert.notEqual(engine.autosaveImage(), null);
  engine.nativeMenuOpen(3, 2);
  assert.equal(engine.autosaveImage(), null);
  engine.nativeMenuRelease(300, 150);
  assert.notEqual(engine.autosaveImage(), null);
});

test("host access: a sticky menu stays open without the button; taps and keys drive it", () => {
  const { engine } = boot();
  assert.equal(engine.nativeMenuOpen(-1, -1, true), true);
  let chrome = engine.getPresentation().menu!;
  assert.equal(chrome.titles[0]!.highlighted, true, "the first enabled heading opens");
  assert.equal(engine.nativeMenuRelease(300, 150), false, "a release is not a cancel");
  assert.equal(engine.modalKind, "menu");
  // Arrow keys move like the PC menu; Enter selects, Esc cancels.
  engine.modalNavigate(3);
  chrome = engine.getPresentation().menu!;
  assert.equal(chrome.titles[1]!.highlighted, true);
  engine.modalNavigate(5);
  engine.modalNavigate(5);
  assert.equal(engine.getPresentation().menu!.pulldown!.highlighted, 1);
  engine.modalKey(AGI_KEY.ENTER);
  assert.equal(engine.modalKind, null);
  engine.tick();
  assert.equal(engine.vars[100], 5);
  // A tap: a title switches, an item selects, anywhere else cancels.
  engine.nativeMenuOpen(-1, -1, true);
  engine.nativeMenuTap(70, 4);
  assert.equal(engine.getPresentation().menu!.titles[1]!.highlighted, true);
  engine.nativeMenuTap(300, 150);
  assert.equal(engine.modalKind, null);
  engine.nativeMenuOpen(-1, -1, true);
  engine.nativeMenuTap(70, 4);
  engine.nativeMenuTap(70, 44);
  assert.equal(engine.modalKind, null);
  engine.tick();
  assert.equal(engine.vars[100], 7);
  engine.nativeMenuOpen(-1, -1, true);
  engine.modalKey(AGI_KEY.ESCAPE);
  assert.equal(engine.modalKind, null);
});

test("chrome ops name every pen and glyph run the compositor paints", () => {
  const { engine } = boot();
  engine.nativeMenuOpen(70, 4);
  engine.nativeMenuMove(70, 16);
  const chrome = intuitionMenuChrome(engine.readMenuState().headings, 1, 0);
  assert.deepEqual(engine.getPresentation().menu, chrome);
  assert.equal(chrome.pulldown!.highlighted, 0);
  assert.equal(chrome.pulldown!.items[2]!.enabled, false);
});
