import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { MESSAGE_KEY, buildLogicResource } from "../src/logic/resource.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { validateEngineReplayState } from "../src/runtime/replayState.ts";
import {
  GLYPH_BL,
  GLYPH_BOTTOM,
  GLYPH_BR,
  GLYPH_CURSOR,
  GLYPH_LEFT,
  GLYPH_RIGHT,
  GLYPH_TL,
  GLYPH_TOP,
  GLYPH_TR,
  TEXT_COLS,
  TextSurface,
  attr,
  cellChar,
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
  // 8 chars + frame = 10 cols, 3 rows; top = 1 + (21-3)/2 = 10, left = (40-10)/2 = 15.
  // The frame is the measured OpenWndw geometry: a white fill plus four
  // 1-pixel edge bars (kq1 2.917 OpenWndw 0x54C8, colour word 0x040F), drawn
  // as edge glyph cells whose font masks carry the bar (app/src/render/
  // font8x8.ts) — never full character-cell bands.
  const FRAME = attr(4, 15);
  const r10 = row(engine, 10);
  assert.deepEqual(r10.chars.slice(15, 25), [
    GLYPH_TL,
    ...Array(8).fill(GLYPH_TOP),
    GLYPH_TR,
  ]);
  assert.ok(r10.attrs.slice(15, 25).every((a) => a === FRAME));
  const r11 = row(engine, 11);
  assert.equal(engine.textRow(11), "under" + spaces(10) + "#Hi there#" + spaces(15));
  assert.equal(r11.chars[15], GLYPH_LEFT);
  assert.equal(r11.chars[24], GLYPH_RIGHT);
  assert.equal(r11.attrs[15], FRAME);
  assert.equal(r11.attrs[24], FRAME);
  assert.ok(r11.attrs.slice(16, 24).every((a) => a === BLACK_ON_WHITE));
  const r12 = row(engine, 12);
  assert.deepEqual(r12.chars.slice(15, 25), [
    GLYPH_BL,
    ...Array(8).fill(GLYPH_BOTTOM),
    GLYPH_BR,
  ]);
  assert.ok(r12.attrs.slice(15, 25).every((a) => a === FRAME));

  // The interpreter is paused: another tick does not re-run logic 0.
  engine.tick();
  assert.equal(host.prints.length, 1);

  // Enter restores the covered cells (the display text survives underneath).
  host.keys.push(0x0d);
  engine.tick();
  assert.equal(engine.modalKind, null);
  assert.equal(engine.textRow(11), "under" + spaces(35));
  assert.equal(row(engine, 10).chars[15], 0);
});

test("print.at honours row, column and width; width 0 means 30", () => {
  // The row override is relative to the display base and used verbatim
  // (kq1 2.917 WindowNoWait 0x1E69: picTop is added on both paths).
  const FRAME = attr(4, 15);
  const host = new Host();
  const engine = new Engine(
    gameWith('print.at("one two three four", 2, 3, 10); return;'),
    host,
    DICT,
  );
  engine.tick();
  // "one two"/"three four" -> 10 + 2 frame = 12 cols, 4 rows at row 1+2, col 3.
  assert.ok(
    row(engine, 3)
      .attrs.slice(3, 15)
      .every((a) => a === FRAME),
  );
  assert.equal(engine.textRow(4), spaces(3) + "#one two   #" + spaces(25));
  assert.equal(engine.textRow(5), spaces(3) + "#three four#" + spaces(25));
  assert.ok(
    row(engine, 6)
      .attrs.slice(3, 15)
      .every((a) => a === FRAME),
  );
  engine.ackPrint();

  const wide = new Engine(gameWith('print.at("one two three four", 6, 1, 0); return;'), host, DICT);
  wide.tick();
  assert.equal(wide.textRow(8), " #" + "one two three four" + "#" + spaces(19));
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

test("cells read as text: borders and code-page bytes are '#', never raw control characters", () => {
  assert.equal(cellChar(0), " ");
  assert.equal(cellChar(0x41), "A");
  for (const code of [
    GLYPH_TOP,
    GLYPH_BOTTOM,
    GLYPH_LEFT,
    GLYPH_RIGHT,
    GLYPH_TL,
    GLYPH_TR,
    GLYPH_BL,
    GLYPH_BR,
    GLYPH_CURSOR,
  ])
    assert.equal(cellChar(code), "#", `glyph 0x${code.toString(16)}`);
  assert.equal(cellChar(0x82), "#", "é in the PC code page");
});

test("wrap consumes the break space and strips continuation leading spaces", () => {
  // Player-visible rule: "aaa  bbb" at width 4 shows "aaa" and "bbb" — the
  // break space is overwritten by the line break (never a trailing cell, so
  // the window is a column narrower) and the continuation's leading spaces
  // are deleted (kq1 2.917 _Print wrap block 0x2191: the break space becomes
  // '\n' and maxLength excludes it).
  assert.deepEqual(wrapLines("aaa  bbb", 4), ["aaa", "bbb"]);
  // A hard split (no space on the line) does not strip: the space after it
  // stays, as the original's no-space path inserts the break without the
  // strip loop (kq1 2.917 0x2198).
  assert.deepEqual(wrapLines("abcd ef", 4), ["abcd", " ef"]);
  assert.deepEqual(wrapLines("aa bb cc", 5), ["aa", "bb cc"]);
});

test("an overlong message is replaced by the verbose notice", () => {
  // Player-visible rule: a message formatting to more than winBot−1 (19)
  // lines never clips silently — the window shows "Message too verbose:"
  // quoting the first 20 characters (kq1 2.917 WindowNoWait 0x1E0C, ovl
  // DS+0xCCB "Message too verbose:\n\n\"%s...\"\n\nPress ESC to continue.").
  const verbose = windowLines("word ".repeat(120).trimEnd(), 30);
  assert.deepEqual(verbose, [
    "Message too verbose:",
    "",
    '"word word word word ..."',
    "",
    "Press ESC to continue.",
  ]);
  assert.deepEqual(windowLines("short", 30), ["short"]);
});

test("print.at overrides place the window verbatim, off-screen included", () => {
  // Player-visible rule: print.at rows/columns are honoured exactly as the
  // script gave them — the original stores the overrides with no clamping
  // and adds picTop even on the override path (kq1 2.917 WindowNoWait
  // 0x1E69-0x1EBB), so a bad override draws off-screen rather than shift.
  assert.deepEqual(placeWindow(["hello"], 1, { row: 2, col: 3 }), {
    top: 3,
    left: 3,
    rows: 3,
    cols: 7,
  });
  assert.deepEqual(placeWindow(["hello"], 1, { row: 24, col: 38 }), {
    top: 25,
    left: 38,
    rows: 3,
    cols: 7,
  });
});

test("the window frame is the measured OpenWndw geometry: fill plus four 1-pixel edge bars", () => {
  // Player-visible rule: the message window is a white fill framed by solid
  // red bars one nibble (one logical pixel) wide, inset one pixel from the
  // fill's edge — not full character-cell bands and no line-drawing corners.
  // OpenWndw issues five DrawWndw calls on the colour word 0x040F: one
  // bottom-anchored fill (dl = 0x0F white), then four edge rects with
  // `mov dl,dh` (red) and 1-wide adjustments — top (x+1, y-h+2, w-2, 1),
  // bottom (x+1, y-1, w-2, 1), left (x+1, y-2, 1, h-4), right
  // (x+w-2, y-2, 1, h-4) (kq1 2.917 OpenWndw 0x54C8; fill geometry
  // width = chars*4+10, height = lines*8+10 at WindowNoWait 0x1E4B/0x1ECC).
  // On the cell surface each edge is a glyph cell whose font mask carries
  // exactly that bar (app/src/render/font8x8.ts, pixel-verified in
  // app/test/composite.test.ts).
  const host = new Host();
  const engine = new Engine(gameWith('print("Hi"); return;'), host, DICT);
  engine.tick();
  assert.equal(engine.modalKind, "print");
  // "Hi" -> 2 + 2 frame = 4 cols, 3 rows; left = (40-4)/2 = 18, top = 1+9 = 10.
  const FRAME = attr(4, 15); // red bar pixels over the white fill
  const top = row(engine, 10);
  assert.deepEqual(top.chars.slice(18, 22), [GLYPH_TL, GLYPH_TOP, GLYPH_TOP, GLYPH_TR]);
  assert.ok(
    top.attrs.slice(18, 22).every((a) => a === FRAME),
    "the edge cells carry the frame colour over the fill",
  );
  const middle = row(engine, 11);
  assert.equal(middle.chars[18], GLYPH_LEFT);
  assert.equal(middle.chars[21], GLYPH_RIGHT);
  assert.equal(middle.attrs[18], FRAME);
  assert.equal(middle.attrs[21], FRAME);
  assert.equal(middle.chars[19], 0x48, "the interior carries the message, not a band");
  assert.equal(middle.attrs[19], BLACK_ON_WHITE);
  const bottom = row(engine, 12);
  assert.deepEqual(bottom.chars.slice(18, 22), [GLYPH_BL, GLYPH_BOTTOM, GLYPH_BOTTOM, GLYPH_BR]);
});

test("version shows the version string modally and never touches string slot 0", () => {
  // Player-visible rule: the version action pops the interpreter version in a
  // window; a game's string slot 0 keeps its contents. The 0x8d handler
  // pushes the CONST versionMsg and calls WindowPrint — a modal key-wait —
  // then returns (kq3 2.936 0x733C / kq1 2.917 0x7275 / gr1 3.002.149
  // 0x7670); nothing writes string storage.
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
  assert.deepEqual(
    { ...modal.saved, cells: modal.saved.cells.length, written: modal.saved.written.length },
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
