import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { MESSAGE_KEY, buildLogicResource } from "../src/logic/resource.ts";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { validateEngineReplayState } from "../src/runtime/replayState.ts";
import {
  GLYPH_BL,
  GLYPH_BR,
  GLYPH_CURSOR,
  GLYPH_H,
  GLYPH_TL,
  GLYPH_TR,
  GLYPH_V,
  TEXT_COLS,
  TextSurface,
  attr,
  cellChar,
  placePrintWindow,
  placeWindow,
  windowLines,
  wrapLines,
} from "../src/runtime/textSurface.ts";

/**
 * Engine-owned text surface (spec "Text geometry and surfaces", "Modal text
 * and alternate text mode", "Inventory selection"). Every expectation below
 * is a hand-computed cell grid: 40 columns, attribute = fg | bg << 4.
 */

const DICT = new Map([["look", 100]]);
const WHITE_ON_BLACK = attr(15, 0); // 0x0f
const BLACK_ON_WHITE = attr(0, 15); // 0xf0

/** Host that never acknowledges: modal windows stay open for inspection. */
class Host implements EngineHost {
  prints: string[] = [];
  keys: number[] = [];
  line: string | null = null;
  print(text: string): void {
    this.prints.push(text);
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    const l = this.line;
    this.line = null;
    return l;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
}

function gameWith(logic0: string, files?: Map<string, Uint8Array>) {
  const container = files ? openContainer(files) : createContainer();
  container.putResource("logic", 0, assembleLogic(logic0, { dictionary: DICT }).payload);
  return container;
}

const spaces = (n: number): string => " ".repeat(n);

/** Chars and attrs of one row as arrays, for exact grid assertions. */
function row(engine: Engine, r: number): { chars: number[]; attrs: number[] } {
  const chars: number[] = [];
  const attrs: number[] = [];
  for (let c = 0; c < TEXT_COLS; c++) {
    chars.push(engine.textCells[(r * TEXT_COLS + c) * 2]!);
    attrs.push(engine.textCells[(r * TEXT_COLS + c) * 2 + 1]!);
  }
  return { chars, attrs };
}

test("TextSurface: write/fill/save/restore are exact cell operations", () => {
  const s = new TextSurface();
  s.write(3, 38, "abc", 0x1f); // clips at column 39
  assert.equal(s.charAt(3, 38), 0x61);
  assert.equal(s.charAt(3, 39), 0x62);
  assert.equal(s.attrAt(3, 39), 0x1f);
  assert.equal(s.rowText(3), spaces(38) + "ab");
  const saved = s.save(3, 37, 3, 39);
  s.fill(3, 0, 3, 39, 0x20, 0x70);
  assert.equal(s.rowText(3), spaces(40));
  s.restore(saved);
  assert.equal(s.rowText(3), spaces(38) + "ab");
  assert.equal(s.charAt(3, 37), 0, "restored transparent cell");
  assert.equal(s.attrAt(3, 20), 0x70, "cells outside the rect keep the fill");
  assert.ok(s.dirty >= 4, "every mutation bumps the dirty counter");
});

test("wrapLines: greedy word wrap, explicit newlines, over-long words", () => {
  assert.deepEqual(wrapLines("The quick brown fox jumps", 10), ["The quick", "brown fox", "jumps"]);
  assert.deepEqual(wrapLines("one\ntwo three", 30), ["one", "two three"]);
  assert.deepEqual(wrapLines("abcdefghijkl end", 5), ["abcde", "fghij", "kl", "end"]);
  assert.deepEqual(wrapLines("", 30), [""]);
});

test("placeWindow: centred in the 21-row display area", () => {
  // "hello" -> 5 + 2 frame = 7 cols, 1 + 2 = 3 rows. Overrides are verbatim
  // and covered by the print.at placement test below.
  assert.deepEqual(placeWindow(["hello"], 1), { top: 10, left: 16, rows: 3, cols: 7 });
  assert.deepEqual(placeWindow(["hello"], 0), { top: 9, left: 16, rows: 3, cols: 7 });
});

test("display writes cells with the text attribute; clear.lines / clear.text.rect paint rectangles", () => {
  const engine = new Engine(
    gameWith(`
      configure.screen(1, 22, 0);
      display(3, 5, "Hi");
      clear.lines(23, 24, 0);
      clear.text.rect(6, 3, 7, 6, 4);
      return;
    `),
    new Host(),
    DICT,
  );
  engine.tick();
  const r3 = row(engine, 3);
  assert.equal(r3.chars[4], 0, "cell before the text stays transparent");
  assert.deepEqual(r3.chars.slice(5, 8), [0x48, 0x69, 0]);
  assert.deepEqual(r3.attrs.slice(5, 7), [WHITE_ON_BLACK, WHITE_ON_BLACK]);
  for (const r of [23, 24]) {
    const { chars, attrs } = row(engine, r);
    assert.ok(
      chars.every((c) => c === 0x20),
      `row ${r} is spaces`,
    );
    assert.ok(
      attrs.every((a) => a === attr(15, 0)),
      `row ${r} painted black`,
    );
  }
  assert.ok(
    row(engine, 22).chars.every((c) => c === 0),
    "row 22 untouched by clear.lines(23,24)",
  );
  const r6 = row(engine, 6);
  assert.deepEqual(r6.chars.slice(2, 8), [0, 0x20, 0x20, 0x20, 0x20, 0]);
  assert.deepEqual(r6.attrs.slice(3, 7), [attr(15, 4), attr(15, 4), attr(15, 4), attr(15, 4)]);
  assert.equal(row(engine, 8).chars[3], 0, "rect is inclusive of row 7 only");
  assert.ok(engine.textDirty > 0);
});

test("status line: score at column 1 and sound state at column 30, black on white", () => {
  // Format strings from the original: "Score:%d of %d  " (no space after the
  // colon, two trailing spaces) at column 1 and "Sound:%s" with the padded
  // "on " at column 30 (kq1 2.917 DisplayStatusLine 0x34BD; overlay strings
  // DS+0xF77/0xF88/0xF91/0xF95).
  const host = new Host();
  const engine = new Engine(
    gameWith(
      "configure.screen(1, 22, 0); assignn(v3, 5); assignn(v7, 42); status.line.on(); return;",
    ),
    host,
    DICT,
  );
  engine.tick();
  assert.equal(engine.textRow(0), " Score:5 of 42  " + spaces(14) + "Sound:on  ");
  assert.ok(row(engine, 0).attrs.every((a) => a === BLACK_ON_WHITE));
  // Turning it off clears the row to transparent cells.
  engine.execute(0);
  const off = gameWith("status.line.off(); return;");
  const e2 = new Engine(off, host, DICT);
  e2.tick();
  assert.ok(row(e2, 0).chars.every((c) => c === 0));
});

test("input line: prompt marker, typed keys, backspace, Enter, echo.line, cancel.line, prevent.input", () => {
  const host = new Host();
  const engine = new Engine(
    gameWith(`
      configure.screen(1, 22, 0);
      if (!isset(f200)) { set(f200); set.cursor.char("_"); accept.input(); }
      if (isset(f201)) { reset(f201); echo.line(); }
      if (isset(f202)) { reset(f202); cancel.line(); }
      if (isset(f203)) { reset(f203); prevent.input(); }
      return;
    `),
    host,
    DICT,
  );
  engine.tick();
  assert.equal(engine.textRow(22), "_" + spaces(39));
  assert.ok(row(engine, 22).attrs.every((a) => a === WHITE_ON_BLACK));

  host.keys.push(0x6c, 0x6f, 0x6f, 0x6b); // l o o k
  engine.tick();
  assert.equal(engine.textRow(22), "_look" + spaces(35));
  assert.equal(engine.inputEdit, "look");

  host.keys.push(0x08); // backspace
  engine.tick();
  assert.equal(engine.textRow(22), "_loo" + spaces(36));

  host.keys.push(0x0d); // Enter accepts the line: parsed, row cleared
  engine.tick();
  assert.equal(engine.lastInputLine, "loo");
  assert.equal(engine.textRow(22), "_" + spaces(39));
  // Enter lands in v19 even though the editor consumed it: the type-1 case
  // stores the low byte FIRST (kq3 2.936 0x35B0).
  assert.equal(engine.vars[19], 0x0d);

  engine.flags[201] = 1; // echo.line restores the accepted line
  engine.tick();
  assert.equal(engine.textRow(22), "_loo" + spaces(36));

  engine.flags[202] = 1; // cancel.line
  engine.tick();
  assert.equal(engine.textRow(22), "_" + spaces(39));

  engine.flags[203] = 1; // prevent.input clears the row to transparent
  engine.tick();
  assert.ok(row(engine, 22).chars.every((c) => c === 0));
});

test("setEditLine mirrors a host-edited line onto the input row", () => {
  const engine = new Engine(
    gameWith('set.cursor.char(">"); accept.input(); return;'),
    new Host(),
    DICT,
  );
  engine.tick();
  engine.setEditLine("open door");
  assert.equal(engine.textRow(22), ">open door" + spaces(30));
});

// Player-visible rule on the Amiga: the input row is string 0, the typed
// text, then the cursor character — the order every Amiga build's ShowInput
// prints (docs/fidelity.md "Amiga screen, font and pointer"); the cursor
// leaves the row while a restart confirmation is open and returns after it,
// also across a save taken during the prompt (F-persistence-02).
test("Amiga input row: s0 prompt, typed text, then the cursor; erased only during a confirmation", () => {
  const amigaGame = (source: string) => {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(source, { dictionary: DICT, profile: PROFILES["amiga-2.202"] }).payload,
    );
    return container;
  };
  // The confirmation parks on the host until a key arrives, as the worker's does.
  class ParkingHost extends Host {
    waitKey(): number {
      const key = this.keys.shift();
      if (key === undefined) throw new HostWait();
      return key;
    }
  }
  const host = new ParkingHost();
  const engine = new Engine(
    amigaGame(`
      configure.screen(1, 22, 0);
      if (!isset(f200)) { set(f200); set.string(s0, ">"); set.cursor.char("_"); accept.input(); }
      if (isset(f201)) { reset(f201); restart.game(); }
      return;
    `),
    host,
    DICT,
    { profile: PROFILES["amiga-2.202"] },
  );
  engine.tick();
  assert.equal(engine.textRow(22), ">_" + spaces(38));
  host.keys.push(0x6c, 0x6f); // l o
  engine.tick();
  assert.equal(engine.textRow(22), ">lo_" + spaces(36));

  const image = engine.serialize();

  engine.flags[201] = 1; // restart.game opens the confirmation; the cursor leaves
  engine.tick();
  assert.equal(engine.modalKind, "print");
  assert.equal(engine.textRow(22), ">lo" + spaces(37));
  engine.deliverHostAnswer(0x1b); // Escape declines
  engine.tick();
  assert.equal(engine.modalKind, null);
  assert.equal(engine.textRow(22), ">lo_" + spaces(36), "WriteCur after the prompt");

  // Abandoning the confirmation (the host dropping it) brings the cursor
  // straight back, before anything else is typed.
  engine.flags[201] = 1;
  engine.tick();
  assert.equal(engine.modalKind, "print");
  assert.equal(engine.textRow(22), ">lo" + spaces(37));
  engine.abortInteraction();
  assert.equal(engine.textRow(22), ">lo_" + spaces(36), "the cursor returns on abort");

  // Restoring a save over an open confirmation replaces the prompt; the
  // typed line is transient as in any restore, and the cursor is back at
  // once.
  engine.flags[201] = 1;
  engine.tick();
  assert.equal(engine.modalKind, "print");
  engine.restoreImage(image);
  assert.equal(engine.modalKind, null);
  assert.equal(engine.textRow(22), ">_" + spaces(38), "the cursor returns on restore");
  host.keys.push(0x6f); // o
  engine.tick();
  assert.equal(engine.textRow(22), ">o_" + spaces(37));
});

// Amiga status opcodes (docs/fidelity.md "Amiga screen, font and pointer"):
// status.line.on/off return at once while the picture top is row 0;
// status.line.off never touches the configured status row (the interpreter
// stores it and never reads it) and instead blacks out window rows 0..10.
test("Amiga status line: gated by the picture top, off leaves the status row alone and blacks the bar area", () => {
  const amigaEngine = (source: string, host = new Host()) => {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(source, { dictionary: DICT, profile: PROFILES["amiga-2.202"] }).payload,
    );
    const engine = new Engine(container, host, DICT, { profile: PROFILES["amiga-2.202"] });
    engine.tick();
    return engine;
  };
  const off = amigaEngine(
    'configure.screen(1, 22, 2); assignn(v3, 5); assignn(v7, 42); display(2, 0, "KEEP"); status.line.on(); status.line.off(); return;',
  );
  assert.equal(off.getPresentation().statusBar, null, "the title is hidden");
  assert.equal(off.textRow(2).slice(0, 4), "KEEP", "the configured status row survives");
  assert.ok(
    row(off, 0).chars.every((c) => c === 0x20) && row(off, 0).attrs.every((a) => a === 0),
    "row 0 is opaque black",
  );
  assert.ok(
    off
      .getPresentation()
      .visual.subarray(0, 3 * 160)
      .every((p) => p === 0),
    "picture rows 0..2 under the bar are black",
  );
  const on = amigaEngine(
    "configure.screen(1, 22, 0); assignn(v3, 5); assignn(v7, 42); status.line.on(); return;",
  );
  assert.equal(on.getPresentation().statusBar?.slice(0, 13), "Score:5 of 42");
  // With the picture at row 0 the opcodes do nothing, even after the
  // picture top changes later.
  const gated = amigaEngine(
    "if (!isset(f200)) { set(f200); configure.screen(0, 22, 0); status.line.on(); configure.screen(1, 22, 0); } return;",
  );
  assert.equal(gated.getPresentation().statusBar, null, "status.line.on was ignored");
});

test("print: solid-framed window centred in the display area, restored on acknowledgement", () => {
  const host = new Host();
  const engine = new Engine(
    gameWith('configure.screen(1, 22, 0); display(11, 0, "under"); print("Hi there"); return;'),
    host,
    DICT,
  );
  engine.tick();
  assert.deepEqual(host.prints, ["Hi there"]);
  assert.equal(engine.modalKind, "print");
  // "Hi there" -> 8 chars wide, 1 row tall; in 2.936 (winBot = 20, picTop = 1):
  // textTop = ((20 - 1 - 1) >> 1) + 1 + 1 = 11, textLeft = (40 - 8) >> 1 = 16.
  // Fill spans x0 = 8*16 - 10 = 118 .. x1 = 8*24 + 9 = 201,
  // y0 = 8*11 - 5 = 83 .. y1 = 8*12 + 4 = 100.
  const r11 = row(engine, 11);
  assert.equal(engine.textRow(11), "under" + spaces(11) + "Hi there" + spaces(16));
  assert.ok(r11.attrs.slice(16, 24).every((a) => a === BLACK_ON_WHITE));
  const overlay = engine.getPresentation().windowOverlay;
  assert.equal(overlay[83 * 320 + 118], 16, "outer top-left white fill");
  assert.equal(overlay[84 * 320 + 120], 5, "top red bar at y0+1, x0+2");
  assert.equal(overlay[99 * 320 + 201], 16, "outer bottom-right white fill");
  assert.equal(overlay[99 * 320 + 199], 5, "bottom red bar at y1-1, x1-2");
  assert.equal(overlay[88 * 320 + 128], 0, "interior text cell stays transparent in overlay");

  // The interpreter is paused: another tick does not re-run logic 0.
  engine.tick();
  assert.equal(host.prints.length, 1);

  // Enter restores the covered cells and clears the window overlay.
  host.keys.push(0x0d);
  engine.tick();
  assert.equal(engine.modalKind, null);
  assert.equal(engine.textRow(11), "under" + spaces(35));
  assert.ok(engine.getPresentation().windowOverlay.every((b) => b === 0));
});

test("print.at honours row, column and width; width 0 means 30", () => {
  // The row override is relative to the display base and used verbatim
  // (kq1 2.917 WindowNoWait 0x1E69: picTop is added on both paths).
  const host = new Host();
  const engine = new Engine(
    gameWith('print.at("one two three four", 2, 3, 10); return;'),
    host,
    DICT,
  );
  engine.tick();
  // "one two"/"three four" -> 10 cols, 2 text rows at row 1+2 = 3, col 3.
  assert.equal(engine.textRow(3), spaces(3) + "one two   " + spaces(27));
  assert.equal(engine.textRow(4), spaces(3) + "three four" + spaces(27));
  assert.ok(
    row(engine, 3)
      .attrs.slice(3, 13)
      .every((a) => a === BLACK_ON_WHITE),
  );
  assert.ok(
    row(engine, 4)
      .attrs.slice(3, 13)
      .every((a) => a === BLACK_ON_WHITE),
  );
  engine.ackPrint();

  const wide = new Engine(gameWith('print.at("one two three four", 6, 1, 0); return;'), host, DICT);
  wide.tick();
  assert.equal(wide.textRow(7), " " + "one two three four" + spaces(21));
});

test("text.screen fills the surface with the text attribute; graphics restores status and input", () => {
  const host = new Host();
  const engine = new Engine(
    gameWith(`
      configure.screen(1, 22, 0);
      if (!isset(f200)) { set(f200); status.line.on(); accept.input(); display(5, 5, "pic text"); }
      if (isset(f201)) { reset(f201); set.text.attribute(0, 15); text.screen(); display(2, 4, "Help"); }
      if (isset(f202)) { reset(f202); graphics(); }
      return;
    `),
    host,
    DICT,
  );
  engine.tick();
  engine.flags[201] = 1;
  engine.tick();
  assert.equal(engine.textModeActive, true);
  for (let r = 0; r < 25; r++) {
    const { chars, attrs } = row(engine, r);
    assert.ok(
      attrs.every((a) => a === BLACK_ON_WHITE),
      `row ${r} attribute`,
    );
    assert.ok(
      chars.every((c) => c !== 0),
      `row ${r} opaque`,
    );
  }
  assert.equal(engine.textRow(2), "    Help" + spaces(32));
  assert.equal(engine.textRow(5), spaces(40), "picture-area text is gone in text mode");

  engine.flags[202] = 1;
  engine.tick();
  assert.equal(engine.textModeActive, false);
  assert.equal(engine.textRow(2), spaces(40));
  assert.equal(row(engine, 2).chars[4], 0, "transparent again");
  assert.equal(engine.textRow(0), " Score:0 of 0  " + spaces(15) + "Sound:on  ", "status redrawn");
  assert.ok(
    row(engine, 22).chars.every((c) => c === 0x20),
    "input row redrawn",
  );
});

test("show.pic clears text over the picture band only; new.room clears everything", () => {
  const host = new Host();
  const engine = new Engine(
    gameWith(`
      configure.screen(1, 22, 0);
      display(5, 0, "X");
      display(21, 0, "Y");
      display(22, 0, "Z");
      display(0, 0, "S");
      show.pic();
      return;
    `),
    host,
    DICT,
  );
  engine.tick();
  assert.equal(row(engine, 5).chars[0], 0, "row 5 is inside the band (rows 1..21)");
  assert.equal(row(engine, 21).chars[0], 0, "row 21 is the band's last row");
  assert.equal(engine.textRow(22)[0], "Z", "row 22 survives");
  assert.equal(engine.textRow(0)[0], "S", "row 0 survives");
});

test("show.pri.screen waits before the following print instruction", () => {
  const host = new Host();
  const engine = new Engine(gameWith('show.pri.screen(); print("x"); return;'), host, DICT);
  engine.tick();
  assert.equal(engine.modalKind, "showPri");
  engine.tick();
  assert.equal(host.prints.length, 0, "the following print has not executed");
  engine.ackPrint();
  engine.tick();
  assert.equal(engine.modalKind, "print");
  assert.deepEqual(host.prints, ["x"]);
  engine.ackPrint();
  engine.tick();
  assert.equal(engine.modalKind, null);
  assert.deepEqual(host.prints, ["x"], "resuming does not restart logic 0");
});

function objectFile(names: string[]): Uint8Array {
  const pool: number[] = [];
  const offsets: number[] = [];
  for (const n of names) {
    offsets.push(pool.length);
    pool.push(...[...n].map((c) => c.charCodeAt(0)), 0);
  }
  const tableSize = names.length * 3;
  const plain = [tableSize & 0xff, tableSize >> 8, 0];
  for (const off of offsets) plain.push((tableSize + off) & 0xff, (tableSize + off) >> 8, 0);
  plain.push(...pool);
  return Uint8Array.from(plain, (b, i) => b ^ MESSAGE_KEY.charCodeAt(i % MESSAGE_KEY.length));
}

test("inventory: centred single column, selection highlight, Enter/Esc results in v25", () => {
  const files = new Map(createContainer().files);
  files.set("OBJECT", objectFile(["sword", "key", "lamp"]));
  const host = new Host();
  const engine = new Engine(
    gameWith("get(0); get(1); set(f13); status(); return;", files),
    host,
    DICT,
  );
  engine.tick();
  assert.equal(engine.modalKind, "inventory");
  assert.equal(engine.textRow(0), spaces(11) + "You are carrying:" + spaces(12));
  // Longest carried name is 5 -> column (40-5)/2 = 17; items on rows 2, 3.
  assert.equal(engine.textRow(2), spaces(17) + "sword" + spaces(18));
  assert.equal(engine.textRow(3), spaces(17) + "key" + spaces(20));
  assert.deepEqual(
    row(engine, 2).attrs.slice(17, 22),
    Array(5).fill(WHITE_ON_BLACK),
    "selected item is inverse",
  );
  assert.deepEqual(row(engine, 3).attrs.slice(17, 20), Array(3).fill(BLACK_ON_WHITE));
  assert.equal(engine.textRow(24), "  Press ENTER to select, ESC to cancel  ");
  assert.equal(engine.textRow(4), spaces(40), "lamp is not carried");

  engine.modalNavigate(5); // down
  assert.deepEqual(row(engine, 3).attrs.slice(17, 20), Array(3).fill(WHITE_ON_BLACK));
  host.keys.push(0x0d);
  engine.tick();
  assert.equal(engine.modalKind, null);
  assert.equal(engine.vars[25], 1, "Enter stores the selected item number");
  assert.ok(
    row(engine, 2).chars.every((c) => c === 0),
    "surface restored",
  );

  // Escape stores 0xff.
  const e2 = new Engine(gameWith("get(0); set(f13); status(); return;", files), new Host(), DICT);
  e2.tick();
  e2.modalKey(0x1b);
  assert.equal(e2.vars[25], 0xff);

  // Non-interactive: acknowledgement-only, v25 untouched, any key closes.
  const e3 = new Engine(
    gameWith("get(0); assignn(v25, 9); status(); return;", files),
    new Host(),
    DICT,
  );
  e3.tick();
  assert.equal(e3.textRow(24), "   Press a key to return to the game    ");
  e3.modalKey(0x78);
  assert.equal(e3.modalKind, null);
  assert.equal(e3.vars[25], 9);

  // Empty inventory shows the empty text.
  const e4 = new Engine(gameWith("status(); return;", files), new Host(), DICT);
  e4.tick();
  assert.equal(e4.textRow(2), spaces(16) + "nothing" + spaces(17));
});

test("inventory: more than 21 carried items uses two columns", () => {
  const names = Array.from({ length: 23 }, (_, i) => `item${i}`);
  const files = new Map(createContainer().files);
  files.set("OBJECT", objectFile(names));
  const gets = names.map((_, i) => `get(${i});`).join(" ");
  const engine = new Engine(gameWith(`${gets} status(); return;`, files), new Host(), DICT);
  engine.tick();
  assert.equal(engine.textRow(2), " item0" + spaces(15) + "item21" + spaces(13));
  assert.equal(engine.textRow(3), " item1" + spaces(15) + "item22" + spaces(13));
  assert.equal(engine.textRow(22), " item20" + spaces(33));
});

test("hold.key (0xad) gates tracked key releases into a movement-zero event", () => {
  const container = createContainer();
  container.putResource("logic", 0, buildLogicResource(new Uint8Array([0x00]), []));
  container.putResource("logic", 1, buildLogicResource(new Uint8Array([0xad, 0x00]), []));
  const engine = new Engine(container, new Host(), DICT);
  engine.vars[6] = 3;
  engine.releaseTrackedKey();
  engine.tick();
  assert.equal(engine.vars[6], 3, "gate 0: release does nothing");
  engine.execute(1);
  engine.releaseTrackedKey();
  engine.tick();
  assert.equal(engine.vars[6], 0, "gate 1: release stops ego at the next input phase");
});

test("status redraw preserves game text until score or sound changes", () => {
  const engine = new Engine(
    gameWith(`
    if (!isset(f200)) {
      set(f200); assignn(v7,42); status.line.on(); display(0,18,"TIME");
    }
    if (isset(f201)) { reset(f201); increment(v3); }
    if (isset(f202)) { reset(f202); toggle(f9); }
    if (isset(f203)) { reset(f203); assignn(v7,43); }
    return;
  `),
    new Host(),
    DICT,
  );
  engine.setSoundEnabled(false);
  engine.tick();
  assert.equal(engine.textRow(0).slice(18, 22), "TIME");
  engine.tick();
  assert.equal(engine.textRow(0).slice(18, 22), "TIME", "unchanged cycle leaves custom cells");
  engine.flags[203] = 1;
  engine.tick();
  assert.equal(
    engine.textRow(0).slice(1, 14),
    "Score:0 of 42",
    "maximum alone does not trigger redraw",
  );
  engine.flags[201] = 1;
  engine.tick();
  assert.equal(engine.textRow(0), " Score:1 of 43  " + spaces(14) + "Sound:off ");
  engine.flags[202] = 1;
  engine.tick();
  assert.equal(engine.textRow(0).slice(30), "Sound:on  ");
});

test("status change detection spans a suspended modal continuation", () => {
  for (const change of [false, true]) {
    const host = new Host();
    const engine = new Engine(
      gameWith(`
      if (!isset(f200)) { set(f200); assignn(v7,42); status.line.on(); display(0,18,"TIME"); }
      if (isset(f201)) {
        reset(f201); ${change ? "increment(v3);" : ""} print("Continue");
      }
      return;
    `),
      host,
      DICT,
    );
    engine.tick();
    engine.flags[201] = 1;
    engine.tick();
    assert.equal(engine.modalKind, "print");
    host.keys.push(13);
    engine.tick();
    assert.equal(engine.textRow(0).slice(18, 22), change ? spaces(4) : "TIME");
    assert.equal(engine.textRow(0).slice(1, 14), `Score:${change ? 1 : 0} of 42`);
  }
});

test("room reentry refreshes the remembered score before running the next logic pass", () => {
  const container = gameWith(`
    if (!isset(f200)) {
      set(f200); assignn(v7,42); status.line.on(); increment(v3); new.room(1);
    }
    display(0,18,"TIME"); return;
  `);
  container.putResource("logic", 1, assembleLogic("return;", { dictionary: DICT }).payload);
  const engine = new Engine(container, new Host(), DICT);
  engine.tick();
  assert.equal(engine.vars[0], 1);
  assert.equal(engine.textRow(0).slice(18, 22), "TIME");
});

test("room reentry retains the pre-logic sound comparison for the final status redraw", () => {
  // agi-re "Top-level cycle order" refreshes remembered v3 on reentry, not f9.
  const container = gameWith(`
    if (!isset(f200)) {
      set(f200); assignn(v7,42); status.line.on(); set(f9); new.room(1);
    }
    display(0,18,"TIME"); return;
  `);
  container.putResource("logic", 1, assembleLogic("return;", { dictionary: DICT }).payload);
  const engine = new Engine(container, new Host(), DICT);
  engine.setSoundEnabled(false);
  engine.tick();
  assert.equal(engine.vars[0], 1);
  assert.equal(engine.flags[9], 1);
  assert.equal(
    engine.textRow(0),
    " Score:0 of 42  " + spaces(14) + "Sound:on  ",
    "the sound change before new.room redraws over the destination's custom status cells",
  );
});

test("host sound toggle refreshes status immediately or after a modal closes", () => {
  const host = new Host();
  const engine = new Engine(
    gameWith(`
    if (!isset(f200)) { set(f200); status.line.on(); }
    if (isset(f201)) { reset(f201); print("Continue"); }
    return;
  `),
    host,
    DICT,
  );
  engine.tick();
  engine.setSoundEnabled(true);
  assert.equal(engine.textRow(0).slice(30), "Sound:on  ");
  engine.flags[201] = 1;
  engine.tick();
  const modal = engine.textCells.slice();
  engine.setSoundEnabled(false);
  assert.deepEqual(engine.textCells, modal, "host toggle does not replace the open modal");
  host.keys.push(13);
  engine.tick();
  assert.equal(engine.textRow(0).slice(30), "Sound:off ");
});

test("status line formatting matches the three profile families (booter-2.001, early-2.089, common)", () => {
  // Player-visible rule:
  // - 2.001 ("booter-2.001"): " Score:%d  " (no max score) and "Sound:%s" padded to col 40
  // - 2.089 ("early-2.089"): " Score:%d of %d" (no trailing spaces) and "Sound:on"/"Sound:off" (no trailing spaces)
  // - 2.230+ / Amiga / IIgs ("common"): " Score:%d of %d  " and "Sound:on  "/"Sound:off "
  const renderRow = (
    profile: "2.001" | "2.089" | "2.230" | "2.936" | "amiga-2.316" | "iigs-1.014",
    soundOn: boolean,
  ): string => {
    const source = `assignn(v3, 5); assignn(v7, 42); ${soundOn ? "set(f9);" : "reset(f9);"} status.line.on(); return;`;
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(source, { dictionary: DICT, profile: PROFILES[profile] }).payload,
    );
    const engine = new Engine(container, new Host(), DICT, { profile: PROFILES[profile] });
    engine.tick();
    return engine.textRow(0);
  };

  assert.equal(
    renderRow("2.001", true),
    " Score:5  " + spaces(20) + "Sound:on  ",
    "2.001 booter status line omits 'of %d' and pads sound to col 40",
  );
  assert.equal(
    renderRow("2.089", true),
    " Score:5 of 42" + spaces(16) + "Sound:on" + spaces(2),
    "2.089 early status line has no trailing space padding in the format strings",
  );
  for (const profile of ["2.230", "2.936", "iigs-1.014"] as const) {
    assert.equal(
      renderRow(profile, true),
      " Score:5 of 42  " + spaces(14) + "Sound:on  ",
      `${profile} common status line`,
    );
  }
  // The Amiga line is the 39-byte screen title Intuition draws, never a row
  // of the play surface: "Score:%d of %d  " from column 0 and "Sound:%s"
  // from column 26 (docs/fidelity.md "Amiga screen, font and pointer").
  assert.equal(renderRow("amiga-2.316", true), spaces(40), "no status cells on the Amiga");
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      "configure.screen(1, 22, 0); assignn(v3, 5); assignn(v7, 42); set(f9); status.line.on(); return;",
      { dictionary: DICT, profile: PROFILES["amiga-2.316"] },
    ).payload,
  );
  const amiga = new Engine(container, new Host(), DICT, { profile: PROFILES["amiga-2.316"] });
  amiga.tick();
  assert.equal(
    amiga.getPresentation().statusBar,
    "Score:5 of 42  " + spaces(11) + "Sound:on " + spaces(4),
    "amiga-2.316 screen title",
  );
  assert.equal(amiga.textRow(0), spaces(40), "the title is not on the cell grid");
});

test("numeric message fields honor explicit zero-padded widths", () => {
  const engine = new Engine(
    gameWith(`
    assignn(v50,0); assignn(v51,7); assignn(v52,42); assignn(v53,255);
    display(5,0,"%v50|2 %v51|2 %v52|3 %v53|3 %v51");
    return;
  `),
    new Host(),
    DICT,
  );
  engine.tick();
  assert.equal(engine.textRow(5), "00 07 042 255 7" + spaces(25));
});

test("display breaks lines on newlines and wraps after column 39, both at column 0", () => {
  // The interpreters' character output moves CR, LF and the character after
  // column 39 to the next row at the routine's start column, which only a
  // message window sets; a display call therefore resumes at column 0 (the
  // Leisure Suit Larry demonstration captions and the Space Quest intro rely
  // on embedded newlines). Row 24 is the floor: later lines overwrite it.
  const engine = new Engine(
    gameWith(`
      display(0, 2, "  Dance the night away at the\\n Lost Wages Disco.");
      display(5, 30, "wrapped-around");
      display(24, 0, "one\\ntwo");
      return;
    `),
    new Host(),
    DICT,
  );
  engine.tick();
  assert.equal(engine.textRow(0).trimEnd(), "    Dance the night away at the");
  assert.equal(engine.textRow(1).trimEnd(), " Lost Wages Disco.");
  assert.equal(engine.textRow(5).slice(30), "wrapped-ar");
  assert.equal(engine.textRow(6).trimEnd(), "ound");
  assert.equal(engine.textRow(24).trimEnd(), "two");
});

test("glyph IDs: 0x01..0x07 keep their 1.x checkpoint meanings", () => {
  assert.equal(GLYPH_H, 0x01);
  assert.equal(GLYPH_V, 0x02);
  assert.equal(GLYPH_TL, 0x03);
  assert.equal(GLYPH_TR, 0x04);
  assert.equal(GLYPH_BL, 0x05);
  assert.equal(GLYPH_BR, 0x06);
  assert.equal(GLYPH_CURSOR, 0x07, "the cursor code a 1.x checkpoint stores");
});

test("cells read as text: borders and code-page bytes are '#', never raw control characters", () => {
  assert.equal(cellChar(0), " ");
  assert.equal(cellChar(0x41), "A");
  for (const code of [GLYPH_H, GLYPH_V, GLYPH_TL, GLYPH_TR, GLYPH_BL, GLYPH_BR, GLYPH_CURSOR])
    assert.equal(cellChar(code), "#", `glyph 0x${code.toString(16)}`);
  assert.equal(cellChar(0x82), "#", "é in the PC code page");
});

test("wrap consumes the break space and strips continuation leading spaces", () => {
  // Player-visible rule: "aaa  bbb" at width 4 shows "aaa" and "bbb" — the
  // break space is overwritten by the line break (never a trailing cell, so
  // the window is a column narrower) and the continuation's leading spaces
  // are deleted (verified across all 20 shipped PC, Amiga and IIgs binaries:
  // docs/fidelity.md "Original window and status-line text").
  assert.deepEqual(wrapLines("aaa  bbb", 4), ["aaa", "bbb"]);
  // A hard split (no space on the line) does not strip: the space after it
  // stays, as the original's no-space path inserts the break without the
  // strip loop (kq1 2.917 0x2198).
  assert.deepEqual(wrapLines("abcd ef", 4), ["abcd", " ef"]);
  assert.deepEqual(wrapLines("aa bb cc", 5), ["aa", "bb cc"]);
});

test("an overlong message is replaced by the verbose notice (18 lines in 2.001, 19 in 2.089+)", () => {
  // Player-visible rule: a message formatting to more than winBot−1 lines
  // (18 in PC 2.001 where winBot=19; 19 in PC 2.089+, Amiga and IIgs where
  // winBot=20) never clips silently — the window shows "Message too verbose:"
  // quoting the first 20 characters.
  const verbose = windowLines("word ".repeat(120).trimEnd(), 30);
  assert.deepEqual(verbose, [
    "Message too verbose:",
    "",
    '"word word word word ..."',
    "",
    "Press ESC to continue.",
  ]);
  assert.deepEqual(windowLines("short", 30), ["short"]);

  // A 19-line message fits in 2.936 (winBot-1 = 19) but triggers the verbose
  // notice in 2.001 (winBot-1 = 18).
  const nineteenLines = Array.from({ length: 19 }, (_, i) => `L${i + 1}`).join("\\n");
  const e2936 = new Engine(gameWith(`print("${nineteenLines}"); return;`), new Host(), DICT, {
    profile: "2.936",
  });
  e2936.tick();
  assert.ok(
    Array.from({ length: 25 }, (_, r) => e2936.textRow(r))
      .join(" ")
      .includes("L19"),
    "2.936 fits 19 lines without verbose substitution",
  );
  const e2001 = new Engine(gameWith(`print("${nineteenLines}"); return;`), new Host(), DICT, {
    profile: "2.001",
  });
  e2001.tick();
  assert.ok(
    Array.from({ length: 25 }, (_, r) => e2001.textRow(r))
      .join(" ")
      .includes("Message too verbose:"),
    "2.001 substitutes the verbose notice at 19 lines (winBot-1 = 18)",
  );
});

test("print.at overrides place the window verbatim, off-screen included", () => {
  // Player-visible rule: print.at rows/columns are honoured exactly as the
  // script gave them — the original stores the overrides with no clamping
  // and adds picTop even on the override path (verified across all 20 shipped
  // binaries), so a bad override draws off-screen rather than shift.
  const placed = placePrintWindow(["hello"], 1, "pc", { row: 2, col: 3 });
  assert.equal(placed.textTop, 3);
  assert.equal(placed.textLeft, 3);
  assert.equal(placed.textRows, 1);
  assert.equal(placed.textCols, 5);
  assert.deepEqual(
    { x0: placed.x0, y0: placed.y0, x1: placed.x1, y1: placed.y1 },
    { x0: 14, y0: 19, x1: 73, y1: 36 },
  );

  const offscreen = placePrintWindow(["hello"], 1, "pc", { row: 24, col: 38 });
  assert.equal(offscreen.textTop, 25);
  assert.equal(offscreen.textLeft, 38);
  assert.deepEqual(
    { x0: offscreen.x0, y0: offscreen.y0, x1: offscreen.x1, y1: offscreen.y1 },
    { x0: 294, y0: 195, x1: 353, y1: 212 },
  );
});

test("the window frame matches each profile family's decoded pixel geometry (PC 2.001, PC 2.089+, Amiga, IIgs)", () => {
  // Hand-computed for print("Hi") (1 row, 2 cols) with displayBase = 1:
  // textLeft = (40 - 2) >> 1 = 19 -> interior x = 152..167.
  // - PC 2.936 ("pc", winBot = 20): textTop = ((20-1-1)>>1)+1+1 = 11 -> interior y = 88..95.
  //   Fill x0 = 142..x1 = 177 (36px), y0 = 83..y1 = 100 (18px).
  //   Bars: top y = 84, bottom y = 99, x = 144..175; left x = 144..145, right x = 174..175.
  // - PC 2.001 ("pc-2.001", winBot = 19): textTop = ((19-1-1)>>1)+1+1 = 10 -> interior y = 80..87.
  //   Fill x0 = 142..x1 = 177 (36px), y0 = 75..y1 = 92 (18px).
  //   Bars: top y = 76, bottom y = 91, x = 144..175; left x = 144..145, right x = 174..175.
  // - Amiga ("amiga", winBot = 20): textTop = 11 -> interior y = 88..95.
  //   Fill x0 = 142..x1 = 178 (37px), y0 = 82..y1 = 100 (19px).
  //   1px bars inset 2px: top y = 84, bottom y = 98, x = 144..176; left x = 144, right x = 176.
  // - IIgs ("iigs", winBot = 20): textTop = 11 -> interior y = 88..95.
  //   Fill x0 = 142..x1 = 177 (36px), y0 = 83..y1 = 100 (18px).
  //   1px bars inset 2px: top y = 85, bottom y = 98, x = 144..175; left x = 144, right x = 175.
  const pc = new Engine(gameWith('print("Hi"); return;'), new Host(), DICT, { profile: "2.936" });
  pc.tick();
  const pcOv = pc.getPresentation().windowOverlay;
  assert.equal(pc.textRow(11).slice(19, 21), "Hi");
  assert.equal(pcOv[83 * 320 + 141], 0, "pc: outside left of fill");
  assert.equal(pcOv[83 * 320 + 142], 16, "pc: fill x0=142, y0=83");
  assert.equal(pcOv[100 * 320 + 177], 16, "pc: fill x1=177, y1=100");
  assert.equal(pcOv[100 * 320 + 178], 0, "pc: outside right of fill");
  assert.equal(pcOv[84 * 320 + 144], 5, "pc: top bar at y=84, x=144");
  assert.equal(pcOv[99 * 320 + 175], 5, "pc: bottom bar at y=99, x=175");
  assert.equal(pcOv[90 * 320 + 144], 5, "pc: 2px left bar col 144");
  assert.equal(pcOv[90 * 320 + 145], 5, "pc: 2px left bar col 145");
  assert.equal(pcOv[90 * 320 + 146], 16, "pc: white fill inside left bar");
  assert.equal(pcOv[90 * 320 + 174], 5, "pc: 2px right bar col 174");
  assert.equal(pcOv[90 * 320 + 175], 5, "pc: 2px right bar col 175");

  const pc2001 = new Engine(gameWith('print("Hi"); return;'), new Host(), DICT, {
    profile: "2.001",
  });
  pc2001.tick();
  const pc2001Ov = pc2001.getPresentation().windowOverlay;
  assert.equal(pc2001.textRow(10).slice(19, 21), "Hi", "pc-2.001 centers at row 10 (winBot=19)");
  assert.equal(pc2001Ov[75 * 320 + 142], 16, "pc-2.001: fill y0=75");
  assert.equal(pc2001Ov[76 * 320 + 144], 5, "pc-2.001: top bar y=76");
  assert.equal(pc2001Ov[91 * 320 + 175], 5, "pc-2.001: bottom bar y=91");
  assert.equal(pc2001Ov[92 * 320 + 177], 16, "pc-2.001: fill y1=92");

  const amiga = new Engine(gameWith('print("Hi"); return;'), new Host(), DICT, {
    profile: "amiga-2.316",
  });
  amiga.tick();
  const amigaOv = amiga.getPresentation().windowOverlay;
  assert.equal(amigaOv[82 * 320 + 142], 16, "amiga: fill y0=82 (6px above text)");
  assert.equal(amigaOv[100 * 320 + 178], 16, "amiga: fill x1=178 (11px right of text)");
  assert.equal(amigaOv[84 * 320 + 144], 5, "amiga: top bar at y0+2=84");
  assert.equal(amigaOv[98 * 320 + 176], 5, "amiga: bottom bar at y1-2=98, x1-2=176");
  assert.equal(amigaOv[90 * 320 + 144], 5, "amiga: 1px left bar at x0+2=144");
  assert.equal(amigaOv[90 * 320 + 145], 16, "amiga: left bar is 1px wide, col 145 is white");
  assert.equal(amigaOv[90 * 320 + 176], 5, "amiga: 1px right bar at x1-2=176");
  assert.equal(amigaOv[90 * 320 + 175], 16, "amiga: right bar is 1px wide, col 175 is white");

  const iigs = new Engine(gameWith('print("Hi"); return;'), new Host(), DICT, {
    profile: "iigs-1.014",
  });
  iigs.tick();
  const iigsOv = iigs.getPresentation().windowOverlay;
  assert.equal(iigsOv[83 * 320 + 142], 16, "iigs: fill x0=142, y0=83");
  assert.equal(iigsOv[100 * 320 + 177], 16, "iigs: fill x1=177, y1=100");
  assert.equal(iigsOv[85 * 320 + 144], 5, "iigs: top bar at y0+2=85");
  assert.equal(iigsOv[98 * 320 + 175], 5, "iigs: bottom bar at y1-2=98, x1-2=175");
  assert.equal(iigsOv[90 * 320 + 144], 5, "iigs: 1px left bar at x0+2=144");
  assert.equal(iigsOv[90 * 320 + 145], 16, "iigs: left bar is 1px wide, col 145 is white");
  assert.equal(iigsOv[90 * 320 + 175], 5, "iigs: 1px right bar at x1-2=175");
  assert.equal(iigsOv[90 * 320 + 174], 16, "iigs: right bar is 1px wide, col 174 is white");
});

test("version shows the version string modally and never touches string slot 0", () => {
  // Player-visible rule: the version action pops the interpreter version in a
  // window; a game's string slot 0 keeps its contents. The 0x8d handler
  // pushes the CONST versionMsg and calls WindowPrint — a modal key-wait —
  // then returns (verified across all 20 shipped binaries); nothing writes
  // string storage.
  const host = new Host();
  const engine = new Engine(
    gameWith('if (!isset(f200)) { set(f200); set.string(s0, "KEEP"); version(); } return;'),
    host,
    DICT,
  );
  engine.tick();
  assert.equal(engine.modalKind, "print", "the version displays modally");
  assert.ok(host.prints[0]?.includes("AGI"), "the version text is what shows");
  assert.equal(engine.strings[0], "KEEP", "string slot 0 is untouched");
  host.keys.push(0x0d);
  engine.tick();
  assert.equal(engine.modalKind, null);
});

test("an off-screen print.at saves a canonical empty rect that captures and restores cleanly", () => {
  // Player-visible rule: a fully off-screen print.at keeps the requested
  // placement verbatim — nothing is covered and nothing drawn — so the saved
  // rectangle canonicalizes to an empty in-range rect: the checkpoint the
  // parked window rides on validates, and dismissal restores without
  // inventing cells (kq1 2.917 WindowNoWait 0x1E69: the overrides feed the
  // window math unchecked; the SAVE path cannot emit row 25 of 25).
  const host = new Host();
  const container = gameWith(
    'load.pic(0); draw.pic(0); show.pic(); print.at("hello", 24, 38, 30); return;',
  );
  container.putResource("picture", 0, Uint8Array.of(0xff));
  const engine = new Engine(container, host, DICT);
  engine.tick();
  assert.equal(engine.modalKind, "print", "the window parked the pass");
  const state = validateEngineReplayState(engine.captureReplayState());
  const modal = state.continuation?.modals[0];
  assert.ok(modal?.kind === "print", "the parked window serialized");
  const { window: _win, ...savedRect } = modal.saved;
  assert.deepEqual(
    { ...savedRect, cells: savedRect.cells.length, written: savedRect.written.length },
    { top: 0, left: 1, bottom: 0, right: 0, cells: 0, written: 0 },
    "the canonical empty rect",
  );
  const before = Array.from(engine.textCells);
  engine.ackPrint();
  assert.equal(engine.modalKind, null);
  assert.deepEqual(Array.from(engine.textCells), before, "dismissal restores nothing");
});

test("TextSurface: a fully off-screen save canonicalizes to an empty in-range rect", () => {
  const s = new TextSurface();
  s.write(3, 3, "abc", 0x1f);
  const saved = s.save(25, 38, 27, 44);
  assert.deepEqual(
    { top: saved.top, left: saved.left, bottom: saved.bottom, right: saved.right },
    { top: 0, left: 1, bottom: 0, right: 0 },
  );
  assert.equal(saved.cells.length, 0);
  const dirtyBefore = s.dirty;
  s.restore(saved);
  assert.equal(s.dirty, dirtyBefore, "restoring nothing changes nothing");
  assert.equal(s.rowText(3), "   abc" + spaces(34));
  // A partially off-screen rect still clips to the visible overlap.
  const partial = s.save(24, 38, 27, 44);
  assert.deepEqual(
    { top: partial.top, left: partial.left, bottom: partial.bottom, right: partial.right },
    { top: 24, left: 38, bottom: 24, right: 39 },
  );
});

test("show.obj routes through the profile window frame selector with zero legacy border glyphs", () => {
  // Hand-computed for show.obj(1) with description "Hi" (1 row, 2 cols, displayBase = 1):
  // ShowObj calls WindowPrint(description) at row = 2 + displayBase = 3 across all 20
  // shipped binaries, so it stamps the profile's WindowOverlay without writing legacy
  // 0x01..0x06 border glyphs into textCells.
  const viewBytes = new Uint8Array([
    0, 0, 1, 15, 0, 7, 0, 1, 3, 0, 3, 1, 0, 0x53, 0, 0x48, 0x69, 0,
  ]);
  for (const [profile, topBarY, rightBarX] of [
    ["2.936", 20, 175],
    ["2.001", 20, 175],
    ["amiga-2.316", 20, 176],
    ["iigs-1.014", 21, 175],
  ] as const) {
    const container = gameWith("show.obj(1); return;");
    container.putResource("view", 1, viewBytes);
    const engine = new Engine(container, new Host(), DICT, { profile });
    engine.tick();
    assert.equal(engine.modalKind, "showObj", `${profile}: showObj modal open`);
    assert.equal(engine.textRow(3).slice(19, 21), "Hi", `${profile}: description row`);
    for (let i = 0; i < engine.textCells.length; i += 2) {
      assert.ok(
        engine.textCells[i]! === 0 || engine.textCells[i]! >= 0x20,
        `${profile}: no legacy border glyph in textCells at ${i}`,
      );
    }
    const ov = engine.getPresentation().windowOverlay;
    assert.equal(ov[topBarY * 320 + 144], 5, `${profile}: top red bar at y=${topBarY}`);
    assert.equal(ov[26 * 320 + rightBarX], 5, `${profile}: right red bar at x=${rightBarX}`);
  }
});

test("window border pixels compare per-pixel overlay write ages against sprite draw stamps in both orders", () => {
  // Hand-computed for PC 2.936 (displayBase = 1):
  // print("Hi") stamps top red border bar at screen y = 84, x = 144..175 (color 5).
  // Picture pixel (x = 72, y = 76) maps to screen y = 1*8 + 76 = 84, x = 144..145
  // inside text cell (row 10, col 18), while x = 146..151 in the same 8x8 cell
  // are uncovered by a 1x1 cel at (72, 76).
  const onePixelView = new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 1, 0, 0x11, 0]);

  // Order 1: sprite drawn first, then persistent print("Hi") opens on top.
  const c1 = gameWith(`
    if (!isset(f200)) {
      set(f200);
      load.pic(v0); draw.pic(v0); show.pic();
      animate.obj(o0); load.view(1); set.view(o0, 1);
      position(o0, 72, 76); draw(o0); stop.update(o0);
      set(f15); print("Hi");
      return;
    }
    erase(o0);
    return;
  `);
  c1.putResource("picture", 0, Uint8Array.of(0xff));
  c1.putResource("view", 1, onePixelView);
  const e1 = new Engine(c1, new Host(), DICT, { profile: "2.936" });
  e1.tick();
  const ov1Before = e1.getPresentation().windowOverlay;
  assert.equal(
    ov1Before[84 * 320 + 144],
    5,
    "draw then print: newer border pixel x=144 stays visible over older sprite",
  );
  assert.equal(
    ov1Before[84 * 320 + 145],
    5,
    "draw then print: newer border pixel x=145 stays visible over older sprite",
  );
  e1.tick(); // erase(o0) restores pre-window background over (72, 76) -> x=144..145, y=84
  const ov1After = e1.getPresentation().windowOverlay;
  assert.equal(ov1After[84 * 320 + 144], 0, "draw then print then erase: x=144 erased");
  assert.equal(ov1After[84 * 320 + 145], 0, "draw then print then erase: x=145 erased");
  assert.equal(ov1After[84 * 320 + 146], 5, "draw then print then erase: x=146 untouched");

  // Order 2: persistent print("Hi") opens first, then sprite draws on top.
  const c2 = gameWith(`
    if (!isset(f200)) {
      set(f200);
      load.pic(v0); draw.pic(v0); show.pic();
      set(f15); print("Hi");
      animate.obj(o0); load.view(1); set.view(o0, 1);
      position(o0, 72, 76); draw(o0); stop.update(o0);
      return;
    }
    erase(o0);
    return;
  `);
  c2.putResource("picture", 0, Uint8Array.of(0xff));
  c2.putResource("view", 1, onePixelView);
  const e2 = new Engine(c2, new Host(), DICT, { profile: "2.936" });
  e2.tick();
  const ov2Before = e2.getPresentation().windowOverlay;
  assert.equal(
    ov2Before[84 * 320 + 144],
    0,
    "print then draw: newer sprite hides covered border pixel x=144",
  );
  assert.equal(
    ov2Before[84 * 320 + 145],
    0,
    "print then draw: newer sprite hides covered border pixel x=145",
  );
  assert.equal(
    ov2Before[84 * 320 + 146],
    5,
    "print then draw: uncovered border pixel x=146 in same 8x8 cell stays visible",
  );
  e2.tick(); // erase(o0) restores background saved when window was already present
  const ov2After = e2.getPresentation().windowOverlay;
  assert.equal(ov2After[84 * 320 + 144], 5, "print then draw then erase: border x=144 restored");
  assert.equal(ov2After[84 * 320 + 145], 5, "print then draw then erase: border x=145 restored");
});

test("checkpoints preserve erased window border pixels across parked have.key restores and accept legacy window records", () => {
  // Review case: draw sprite at (72, 76), open persistent print("Hi"), erase
  // sprite (clearing top border bar at y=84, x=144..145), then park on have.key.
  class SuspendingKeyHost extends Host {
    waitKey(): number {
      throw new HostWait();
    }
  }
  const onePixelView = new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 1, 0, 0x11, 0]);
  const build = () => {
    const c = gameWith(`
      if (!isset(f200)) {
        set(f200);
        load.pic(v0); draw.pic(v0); show.pic();
        animate.obj(o0); load.view(1); set.view(o0, 1);
        position(o0, 72, 76); draw(o0); stop.update(o0);
        set(f15); print("Hi");
        erase(o0);
      }
      wait:
      if (!have.key()) { goto wait; }
      return;
    `);
    c.putResource("picture", 0, Uint8Array.of(0xff));
    c.putResource("view", 1, onePixelView);
    return c;
  };
  const engine = new Engine(build(), new SuspendingKeyHost(), DICT, { profile: "2.936" });
  engine.tick();
  assert.equal(engine.awaitingKey, true, "parked on have.key");
  const beforeOv = engine.getPresentation().windowOverlay;
  assert.equal(beforeOv[84 * 320 + 144], 0, "before checkpoint: border pixel (144, 84) is erased");
  assert.equal(beforeOv[84 * 320 + 145], 0, "before checkpoint: border pixel (145, 84) is erased");
  assert.equal(beforeOv[84 * 320 + 146], 5, "before checkpoint: border pixel (146, 84) is intact");

  const autosave = engine.autosaveImage();
  assert.ok(autosave, "parked have.key with persistent window is snapshottable");
  const recImage = engine.recordingImage()!;
  const replayState = validateEngineReplayState(engine.captureReplayState());

  const fromAutosave = new Engine(build(), new SuspendingKeyHost(), DICT, { profile: "2.936" });
  fromAutosave.restoreImage(autosave);
  const autoOv = fromAutosave.getPresentation().windowOverlay;
  assert.equal(
    autoOv[84 * 320 + 144],
    0,
    "after autosave restore: border pixel (144, 84) stays erased",
  );
  assert.equal(
    autoOv[84 * 320 + 145],
    0,
    "after autosave restore: border pixel (145, 84) stays erased",
  );
  assert.equal(autoOv[84 * 320 + 146], 5, "after autosave restore: border pixel (146, 84) intact");
  assert.deepEqual(Array.from(autoOv), Array.from(beforeOv), "exact overlay preserved");

  const fromReplay = new Engine(build(), new SuspendingKeyHost(), DICT, { profile: "2.936" });
  fromReplay.restoreImage(recImage);
  fromReplay.restoreReplayState(replayState);
  assert.deepEqual(
    Array.from(fromReplay.getPresentation().windowOverlay),
    Array.from(beforeOv),
    "recordingImage + restoreReplayState preserves exact overlay",
  );

  // Older checkpoints whose window record omits `erased` still validate and restore.
  const legacyState = structuredClone(replayState);
  delete legacyState.continuation!.persistentWindow!.window!.erased;
  const validatedLegacy = validateEngineReplayState(legacyState);
  fromReplay.restoreReplayState(validatedLegacy);
  assert.equal(
    fromReplay.getPresentation().windowOverlay[84 * 320 + 144],
    5,
    "legacy checkpoint without erased field restores the full geometry",
  );
});
