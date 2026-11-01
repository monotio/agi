import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { decodeSave } from "../src/runtime/persistence.ts";
import { createSaveDialog, stepSaveDialog, type SaveSlot } from "../src/runtime/saveDialog.ts";
import { TextSurface } from "../src/runtime/textSurface.ts";

interface SyncDialogHost {
  list(): SaveSlot[];
  waitKey(): number;
  describe?(initial: string, maxLen: number, row: number, col: number): string | null;
  write(slot: number, description: string): boolean | void;
  read(slot: number): Uint8Array | null;
}

/** Drive the selector to completion against a synchronous host. */
function runSaveDialog(
  mode: "save" | "restore",
  text: TextSurface,
  signature: string,
  host: SyncDialogHost,
): Uint8Array | null {
  const dialog = createSaveDialog(mode, text, signature, host.describe !== undefined);
  try {
    let answer: unknown;
    for (;;) {
      const step = stepSaveDialog(dialog, answer);
      if (step.done) return step.image;
      const need = step.need;
      switch (need.kind) {
        case "list":
          try {
            answer = host.list();
          } catch {
            answer = null;
          }
          break;
        case "key":
          answer = host.waitKey();
          break;
        case "describe":
          answer = host.describe
            ? host.describe(need.initial, need.maxLen, need.row, need.col)
            : null;
          break;
        case "write":
          try {
            answer = host.write(need.slot, need.description) !== false;
          } catch {
            answer = false;
          }
          break;
        case "read":
          try {
            answer = host.read(need.slot);
          } catch {
            answer = null;
          }
          break;
      }
    }
  } finally {
    // An unwinding host call still restores the cells the dialog covered.
    if (!dialog.done) text.restore(dialog.saved);
  }
}

function setup(
  action: "save" | "restore",
  keys: number[],
  description: string | null = "At the well",
  describe?: () => string | null,
) {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (isset(f12)) { assignn(v101, 1); return; } ${action}.game(); assignn(v100, 99); return;`,
      { dictionary: new Map() },
    ).payload,
  );
  const slots: { slot: number; bytes: Uint8Array }[] = [];
  const writes: { slot: number | undefined; bytes: Uint8Array }[] = [];
  const reads: (number | undefined)[] = [];
  const screens: string[] = [];
  const kinds: (string | null)[] = [];
  const prints: string[] = [];
  const queued: number[] = [];
  let failWrite = false;
  let failRead = false;
  let edits = 0;
  const host: EngineHost = {
    print(text) {
      prints.push(text);
    },
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => queued.splice(0),
    listSaveGames: () => slots,
    waitKey() {
      screens.push(
        Array.from(engine.textCells)
          .filter((_, i) => i % 2 === 0)
          .map((c) => String.fromCharCode(c))
          .join(""),
      );
      kinds.push(engine.modalKind);
      return keys.shift() ?? 0x1b;
    },
    promptSaveDescription() {
      edits++;
      return describe ? describe() : description;
    },
    saveGame(bytes, slot) {
      writes.push({ bytes, slot });
      return !failWrite;
    },
    restoreGame(slot) {
      reads.push(slot);
      return failRead ? null : (slots.find((s) => s.slot === slot)?.bytes ?? null);
    },
  };
  const engine = new Engine(container, host, new Map());
  return {
    engine,
    slots,
    writes,
    reads,
    screens,
    kinds,
    prints,
    edits: () => edits,
    pressKeys: (...codes: number[]) => queued.push(...codes),
    failWrite: () => {
      failWrite = true;
    },
    failRead: () => {
      failRead = true;
    },
  };
}

test("save selector wraps up to slot 12 and serializes its new description", () => {
  const s = setup("save", [0x4800, 13, 13]);
  s.engine.tick();
  assert.equal(s.writes[0]?.slot, 12);
  assert.equal(decodeSave(s.writes[0]!.bytes, s.engine.profile).description, "At the well");
  assert.equal(s.edits(), 1);
  assert.ok(s.screens[0]?.includes("Save game"));
  assert.ok(s.kinds.every((k) => k === "save"));
  assert.equal(s.engine.modalKind, null);
  assert.equal(s.engine.vars[100], 99);
});

test("native description prompt opens over the describe screen", () => {
  const rows: string[] = [];
  const s = setup("save", [13], "unused", () => {
    rows.push(s.engine.textRow(1), s.engine.textRow(6));
    return "Name";
  });
  s.engine.tick();
  assert.match(rows[0]!, /Describe this saved game:/);
  assert.match(rows[1]!, /ENTER: accept {3}ESC: cancel/);
});

test("Escape from slot selection or description performs no file write", () => {
  for (const [keys, description] of [
    [[27], "unused"],
    [[13], null],
  ] as const) {
    const s = setup("save", [...keys], description);
    s.engine.tick();
    assert.equal(s.writes.length, 0);
    assert.equal(s.engine.vars[100], 99);
  }
});

test("occupied slot keeps its description and requires overwrite confirmation", () => {
  for (const confirm of [27, 13]) {
    const s = setup("save", [13, confirm]);
    const saved = s.engine.serialize();
    saved.set([79, 108, 100]);
    s.slots.push({ slot: 1, bytes: saved });
    s.engine.tick();
    assert.equal(s.edits(), 0);
    assert.equal(s.writes.length, confirm === 13 ? 1 : 0);
    assert.ok(s.screens.some((screen) => screen.includes("Replace")));
    if (confirm === 13)
      assert.equal(decodeSave(s.writes[0]!.bytes, s.engine.profile).description, "Old");
  }
});

test("restore lists matching slots only and reads the selected slot after wrapping", () => {
  const s = setup("restore", [0x4800, 13]);
  const first = s.engine.serialize();
  const last = s.engine.serialize();
  const foreign = s.engine.serialize();
  foreign[33] = 88;
  s.slots.push(
    { slot: 1, bytes: first },
    { slot: 3, bytes: foreign },
    { slot: 9, bytes: last },
    { slot: 4, bytes: new Uint8Array(4) },
  );
  s.engine.tick();
  assert.deepEqual(s.reads, [9]);
  assert.equal(s.engine.vars[100], 0, "restore aborts current continuation");
  assert.equal(s.engine.vars[101], 1, "restored logic resumes inside the same cycle");
  assert.equal(s.engine.flags[12], 0, "normal cycle tail clears restore");
  assert.ok(!s.screens[0]?.includes(" 3."));
  assert.ok(s.kinds.every((k) => k === "restore"));
});

test("save storage failure and restore open failure are recoverable", () => {
  const save = setup("save", [13, 13, 13]);
  save.failWrite();
  save.engine.tick();
  assert.equal(save.engine.vars[100], 99);
  assert.ok(save.screens.some((screen) => screen.includes("Unable to save")));
  const restore = setup("restore", [13, 13]);
  restore.slots.push({ slot: 1, bytes: restore.engine.serialize() });
  restore.failRead();
  restore.engine.tick();
  assert.equal(restore.engine.vars[100], 99);
  assert.ok(restore.screens.some((screen) => screen.includes("Unable to open")));
});

test("empty restore selection and cancellation preserve the previous text surface", () => {
  for (const action of ["save", "restore"] as const) {
    const s = setup(action, [27]);
    const text = s.engine.textCells.slice();
    s.engine.tick();
    assert.equal(s.engine.modalKind, null);
    assert.equal(s.writes.length + s.reads.length, 0);
    // Ordinary end-of-cycle status/input can redraw; all other rows are restored.
    assert.deepEqual(s.engine.textCells.slice(80, 23 * 80), text.slice(80, 23 * 80));
  }
});

test("restored save description remains available in subsequent save images", () => {
  const s = setup("restore", [13]);
  const saved = s.engine.serialize();
  saved.set([66, 114, 105, 100, 103, 101]);
  s.slots.push({ slot: 1, bytes: saved });
  s.engine.tick();
  assert.equal(decodeSave(s.engine.serialize(), s.engine.profile).description, "Bridge");
});

test("selected malformed save shows a restore error before aborting execution", () => {
  const s = setup("restore", [13, 13]);
  s.slots.push({ slot: 1, bytes: s.engine.serialize().slice(0, 40) });
  // The failed image parks behind its error window; the pass does not abort
  // until the player has seen and acknowledged the dialog.
  s.engine.tick();
  assert.ok(s.prints.some((text) => text.includes("Unable to restore")));
  s.pressKeys(13);
  assert.throws(() => s.engine.tick());
  assert.equal(s.engine.vars[100], 0);
});

function batchedSaveHost(keys: number[], nativeDescription = true) {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `
    save.game();
    if (have.key()) { assignv(v100,v19); }
    return;
  `,
      { dictionary: new Map() },
    ).payload,
  );
  const writes: { slot: number | undefined; bytes: Uint8Array }[] = [];
  let selectorStarted = false;
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => (selectorStarted ? keys.splice(0) : []),
    listSaveGames() {
      selectorStarted = true;
      return [];
    },
    ...(nativeDescription ? { promptSaveDescription: () => "Before the bridge" } : {}),
    saveGame(bytes, slot) {
      writes.push({ bytes, slot });
    },
  };
  return { engine: new Engine(container, host, new Map()), writes };
}

test("save selector consumes a takeKeys batch one key at a time without waitKey", () => {
  const { engine, writes } = batchedSaveHost([0x5000, 0x0101, 0x0301, 0x62]);
  engine.tick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.slot, 2, "Down selects slot 2, then the two Enters select and confirm");
  assert.equal(decodeSave(writes[0]!.bytes, engine.profile).description, "Before the bridge");
  assert.equal(engine.vars[100], 0x62, "the unread suffix reaches the following have.key");
});

test("cancelling a save selector preserves the rest of a takeKeys batch", () => {
  const { engine, writes } = batchedSaveHost([0x0201, 0x62]);
  engine.tick();
  assert.equal(writes.length, 0);
  assert.equal(engine.vars[100], 0x62, "Escape cancels only the selector, not later input");
});

test("save description fallback consumes text and confirmation from the same key batch", () => {
  const { engine, writes } = batchedSaveHost(
    [0x5000, 13, 80, 97, 116, 104, 0x0101, 0x0301, 0x62],
    false,
  );
  engine.tick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.slot, 2);
  assert.equal(decodeSave(writes[0]!.bytes, engine.profile).description, "Path");
  assert.equal(engine.vars[100], 0x62);
});

for (const alias of [0x0101, 0x0301]) {
  test(`raw description editor accepts Enter alias ${alias.toString(16)}`, () => {
    const keys = [13, 65, alias, 13];
    const writes: string[] = [];
    runSaveDialog("save", new TextSurface(), "", {
      list: () => [],
      waitKey: () => keys.shift() ?? 0,
      read: () => null,
      write: (_slot, description) => {
        writes.push(description);
      },
    });
    assert.deepEqual(writes, ["A"]);
  });
}

for (const alias of [0x0201, 0x0401]) {
  test(`raw description editor cancels on Escape alias ${alias.toString(16)}`, () => {
    const keys = [13, 65, alias, 13, 13];
    const writes: string[] = [];
    runSaveDialog("save", new TextSurface(), "", {
      list: () => [],
      waitKey: () => keys.shift() ?? 0,
      read: () => null,
      write: (_slot, description) => {
        writes.push(description);
      },
    });
    assert.deepEqual(writes, []);
    assert.deepEqual(keys, [13, 13], "cancellation leaves following keys unread");
  });
}

test("raw description editing reserves the header terminator before accepting characters", () => {
  const keys = [13, ...Array<number>(31).fill(65), 8, 66, 13, 13];
  const text = new TextSurface();
  const writes: string[] = [];
  const confirmations: string[] = [];
  runSaveDialog("save", text, "", {
    list: () => [],
    waitKey() {
      if (text.charAt(1, 2) === "S".charCodeAt(0) && text.charAt(1, 7) === "i".charCodeAt(0)) {
        confirmations.push(
          Array.from({ length: 31 }, (_, i) => String.fromCharCode(text.charAt(3, 2 + i))).join(""),
        );
      }
      return keys.shift() ?? 0;
    },
    read: () => null,
    write: (_slot, description) => {
      writes.push(description);
    },
  });
  assert.deepEqual(writes, ["A".repeat(29) + "B"]);
  assert.deepEqual(confirmations, ["A".repeat(29) + "B "]);
});

test("native description editor and final write use the same 30-character capacity", () => {
  const limits: number[] = [];
  const writes: string[] = [];
  runSaveDialog("save", new TextSurface(), "", {
    list: () => [],
    waitKey: () => 13,
    describe(_initial, maxLen) {
      limits.push(maxLen);
      return "A".repeat(30) + "Z";
    },
    read: () => null,
    write: (_slot, description) => {
      writes.push(description);
    },
  });
  assert.deepEqual(limits, [30]);
  assert.deepEqual(writes, ["A".repeat(30)], "defensively bound an overlong host reply");
});

// ---- Amiga: the original WindowPrint dialogs (docs/fidelity.md "Original Amiga save and restore dialogs") ----

import { PROFILES } from "../src/runtime/profile.ts";
import { TEXT_COLS, attr } from "../src/runtime/textSurface.ts";

/** Row `r` of the engine's cells as text, with transparent cells as spaces. */
function rowText(engine: Engine, r: number): string {
  let s = "";
  for (let c = 0; c < TEXT_COLS; c++)
    s += String.fromCharCode(engine.textCells[(r * TEXT_COLS + c) * 2]! || 0x20);
  return s;
}

function amigaSetup(
  action: "save" | "restore",
  keys: number[],
  slots: { slot: number; description: string }[] = [],
  suspend = false,
) {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) { set(f200); configure.screen(1, 22, 0); set.game.id("sq2"); }
       if (isset(f12)) { assignn(v101, 1); return; } ${action}.game(); assignn(v100, 99); return;`,
      { dictionary: new Map() },
    ).payload,
  );
  const writes: { slot: number | undefined; bytes: Uint8Array }[] = [];
  const reads: number[] = [];
  const screens: { rows: string[]; gadgets: unknown; cells: Uint8Array }[] = [];
  let failWrite = false;
  const queued: number[] = [];
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => queued.splice(0),
    listSaveGames: () => files,
    waitKey() {
      const p = engine.getPresentation();
      screens.push({
        rows: Array.from({ length: 25 }, (_, r) => rowText(engine, r)),
        gadgets: p.gadgets,
        cells: p.text,
      });
      const key = keys.shift();
      if (key === undefined && suspend) throw new HostWait();
      return key ?? 0x1b;
    },
    saveGame(bytes, slot) {
      writes.push({ bytes, slot });
      return !failWrite;
    },
    restoreGame(slot) {
      reads.push(slot ?? 0);
      return files.find((f) => f.slot === slot)?.bytes ?? null;
    },
  };
  const engine = new Engine(container, host, new Map(), { profile: PROFILES["amiga-2.202"] });
  // The first cycle only initializes the game (f12 short-circuits the save).
  engine.flags[12] = 1;
  engine.tick();
  const files: SaveSlot[] = slots.map(({ slot, description }) => {
    const bytes = engine.serialize();
    const desc = new TextEncoder().encode(description);
    bytes.set(desc.subarray(0, 30), 0);
    bytes[Math.min(desc.length, 30)] = 0;
    return { slot, bytes };
  });
  engine.flags[12] = 0;
  return {
    engine,
    writes,
    reads,
    screens,
    pressKeys: (...codes: number[]) => queued.push(...codes),
    failWrite: () => (failWrite = true),
  };
}

const amigaGadget = (p: unknown, i: number) =>
  (p as { x0: number; y0: number; x1: number; y1: number; pen: number; text: string }[])[i]!;

test("Amiga save: the slot window lists twelve slots at 34 columns with the pointer, OK and Cancel", () => {
  const s = amigaSetup("save", [0x1b], [{ slot: 2, description: "At the well" }]);
  s.engine.tick();
  const [screen] = s.screens;
  assert.equal(screen!.rows[2], "   Select the slot in which you wish    ");
  assert.equal(screen!.rows[3], "   to save the game.                    ");
  assert.equal(screen!.rows[4], " ".repeat(40));
  assert.equal(screen!.rows[5], "   »-" + " ".repeat(35));
  assert.equal(screen!.rows[6], "    - At the well                       ");
  assert.equal(screen!.rows[16], "    -                                   ");
  assert.equal(screen!.rows[17], " ".repeat(40), "three rows for the gadgets");
  const ok = amigaGadget(screen!.gadgets, 0);
  const cancel = amigaGadget(screen!.gadgets, 1);
  assert.deepEqual([ok.x0, ok.y0, ok.x1, ok.y1, ok.pen, ok.text], [24, 147, 63, 158, 2, " OK "]);
  assert.deepEqual(
    [cancel.x0, cancel.y0, cancel.x1, cancel.y1, cancel.pen, cancel.text],
    [240, 147, 295, 158, 4, "Cancel"],
  );
  assert.equal(s.writes.length, 0, "Escape saves nothing");
  assert.equal(s.engine.vars[100], 99);
  assert.equal(
    s.engine.getPresentation().windowOverlay.every((v) => v === 0),
    true,
    "the window is gone",
  );
});

test("Amiga save: arrows move the pointer with wrap, Enter opens the describe window, typing and Enter confirm into the game's file", () => {
  const up = 0x4800;
  const down = 0x5000;
  const s = amigaSetup("save", [up, down, down, 13, 0x61, 0x62, 13, 13]);
  s.engine.tick();
  assert.equal(s.screens[0]!.rows[5]!.charCodeAt(3), 0xbb);
  assert.equal(
    s.screens[1]!.rows[16]!.charCodeAt(3),
    0xbb,
    "Up from the first slot wraps to slot 12",
  );
  assert.equal(s.screens[2]!.rows[5]!.charCodeAt(3), 0xbb, "Down wraps back to slot 1");
  assert.equal(s.screens[3]!.rows[6]!.charCodeAt(3), 0xbb);
  // The describe window: 31 columns, the question, a blank row, the input row in pen 0.
  const describe = s.screens[4]!;
  assert.equal(describe.rows[8], "    How would you like to describe      ");
  assert.equal(describe.rows[9], "    this saved game?                    ");
  assert.equal(describe.rows[10], " ".repeat(40));
  assert.equal(describe.rows[11], "    _" + " ".repeat(35));
  assert.equal(
    describe.cells[(11 * TEXT_COLS + 4) * 2 + 1],
    attr(15, 0),
    "white on black input row",
  );
  assert.equal(describe.cells[(11 * TEXT_COLS + 34) * 2 + 1], attr(15, 0));
  assert.equal(amigaGadget(describe.gadgets, 0).text, " OK ");
  assert.equal(s.screens[6]!.rows[11], "    ab_" + " ".repeat(33));
  const confirm = s.screens[7]!;
  assert.deepEqual(confirm.rows.slice(6, 13), [
    "         About to save the game         ",
    "         described as:                  ",
    "                                        ",
    "         ab                             ",
    "                                        ",
    "         in file:                       ",
    "         save/sq2sg.2                   ",
  ]);
  assert.equal(amigaGadget(confirm.gadgets, 0).text, "Save");
  assert.equal(amigaGadget(confirm.gadgets, 1).text, "Cancel");
  assert.equal(s.writes[0]?.slot, 2);
  assert.equal(decodeSave(s.writes[0]!.bytes, s.engine.profile).description, "ab");
});

test("Amiga save: an occupied slot's description is edited in place, and Escape at any window saves nothing", () => {
  for (const keys of [[0x1b], [13, 0x1b], [13, 13, 0x1b]]) {
    const s = amigaSetup("save", keys, [{ slot: 1, description: "At the well" }]);
    s.engine.tick();
    assert.equal(s.writes.length, 0);
    assert.equal(s.engine.vars[100], 99);
  }
  const s = amigaSetup("save", [13, 0x73, 13, 13], [{ slot: 1, description: "At the well" }]);
  s.engine.tick();
  assert.equal(s.screens[1]!.rows[11], "    At the well_" + " ".repeat(24));
  assert.equal(decodeSave(s.writes[0]!.bytes, s.engine.profile).description, "At the wells");
});

test("Amiga restore: only existing games list, the confirm names the file, and no games shows the original notice", () => {
  const s = amigaSetup(
    "restore",
    [down(), 13, 13],
    [
      { slot: 3, description: "Cave" },
      { slot: 7, description: "Shop" },
    ],
  );
  s.engine.tick();
  const list = s.screens[0]!;
  assert.equal(list.rows[7], "   Select the game which you wish to    ");
  assert.equal(list.rows[8], "   restore.                             ");
  assert.equal(list.rows[10], "   »- Cave" + " ".repeat(30));
  assert.equal(list.rows[11], "    - Shop                              ");
  assert.equal(list.rows[12], " ".repeat(40));
  const confirm = s.screens[2]!;
  assert.deepEqual(confirm.rows.slice(6, 13), [
    "       About to restore the game        ",
    "       described as:                    ",
    "                                        ",
    "       Shop                             ",
    "                                        ",
    "       from file:                       ",
    "       save/sq2sg.7                     ",
  ]);
  assert.equal(amigaGadget(confirm.gadgets, 0).text, "Restore");
  assert.deepEqual(s.reads, [7]);
  const none = amigaSetup("restore", [13]);
  none.engine.tick();
  assert.deepEqual(none.screens[0]!.rows.slice(9, 13), [
    "         There are no games to          ",
    "         restore in                     ",
    "                                        ",
    "         save                           ",
  ]);
  assert.equal(none.screens[0]!.gadgets, undefined);
  assert.deepEqual(none.reads, []);
  assert.equal(none.engine.vars[100], 99);
  function down() {
    return 0x5000;
  }
});

test("Amiga: a click on a slot line, on OK or on Cancel answers the window like the original gadgets", () => {
  const s = amigaSetup("save", [], [{ slot: 1, description: "At the well" }], true);
  // Click on slot 4's line selects it (the invisible gadget covers the text from column 6).
  s.engine.tick();
  assert.equal(s.engine.modalKind, "save");
  assert.equal(s.engine.pointerKeyAt(10, 70), null, "the pointer column is not a gadget");
  assert.equal(s.engine.pointerKeyAt(100, 70), 0x0a03);
  assert.equal(s.engine.pointerKeyAt(30, 150), 13, "OK");
  assert.equal(s.engine.pointerKeyAt(250, 150), 0x1b, "Cancel");
  s.engine.deliverHostAnswer(0x0a03);
  s.engine.tick();
  assert.equal(s.engine.modalKind, "save");
  s.engine.deliverHostAnswer(0x1b);
  s.engine.tick();
  assert.equal(s.engine.modalKind, null);
  assert.equal(s.writes.length, 0);
});

test("Amiga: a rejected write shows its notice in a window and the game goes on", () => {
  const s = amigaSetup("save", [13, 13, 13, 13]);
  s.failWrite();
  s.engine.tick();
  assert.ok(s.screens.some((screen) => screen.rows.some((r) => r.includes("Unable to save"))));
  assert.equal(s.engine.vars[100], 99);
  assert.equal(
    s.engine.getPresentation().windowOverlay.every((v) => v === 0),
    true,
  );
});

test("an Apple IIgs game lists its own saves, and a PC save with the same signature stays out", () => {
  // Player-visible rule: an IIgs game lists its saves. The IIgs image holds
  // the 0x38-byte ~globals lead block first and the set.game.id signature
  // at the start of the second block (docs/fidelity.md "Game signature
  // across restore").
  const source = `if (!isset(f200)) { set(f200); set.game.id("SQ2"); }
     if (isset(f12)) { assignn(v101, 1); return; }
     if (isset(f201)) { reset(f201); restore.game(); }
     return;`;
  const image = (profile: "iigs-1.014" | "2.936", description: string): Uint8Array => {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(source, { dictionary: new Map(), profile: PROFILES[profile] }).payload,
    );
    const engine = new Engine(
      container,
      {
        print() {},
        displayAt() {},
        statusLine() {},
        takeInputLine: () => null,
        takeKeys: () => [],
      },
      new Map(),
      { profile },
    );
    engine.tick();
    const bytes = engine.serialize();
    bytes.fill(0, 0, 31);
    for (let i = 0; i < description.length; i++) bytes[i] = description.charCodeAt(i);
    return bytes;
  };
  const slots = [
    { slot: 1, bytes: image("2.936", "PC GAME") },
    { slot: 2, bytes: image("iigs-1.014", "IIGS GAME") },
  ];
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(source, { dictionary: new Map(), profile: PROFILES["iigs-1.014"] }).payload,
  );
  const reads: (number | undefined)[] = [];
  const screens: string[] = [];
  const engine: Engine = new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
      listSaveGames: () => slots,
      waitKey() {
        screens.push(Array.from({ length: 25 }, (_, r) => engine.textRow(r)).join("\n"));
        return 0x0d;
      },
      restoreGame(slot) {
        reads.push(slot);
        return slots.find((s) => s.slot === slot)?.bytes ?? null;
      },
    },
    new Map(),
    { profile: "iigs-1.014" },
  );
  engine.tick();
  engine.flags[201] = 1;
  engine.tick();
  assert.match(screens[0] ?? "", /IIGS GAME/, "the IIgs save is listed");
  assert.doesNotMatch(screens[0] ?? "", /PC GAME/, "the PC save is not");
  assert.deepEqual(reads, [2]);
  // The IIgs restore ends in the dissolve; logic 0 runs again after it.
  for (let t = 0; t < 40 && engine.vars[101] === 0; t++) {
    engine.advanceClock(100);
    engine.tick();
  }
  assert.equal(engine.vars[101], 1, "the restored game runs with f12");
});
