import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { decodeSave } from "../src/runtime/persistence.ts";

function setup(
  action: "save" | "restore",
  keys: number[],
  description: string | null = "At the well",
) {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(`${action}.game(); assignn(v100, 99); return;`, { dictionary: new Map() })
      .payload,
  );
  const slots: { slot: number; bytes: Uint8Array }[] = [];
  const writes: { slot: number | undefined; bytes: Uint8Array }[] = [];
  const reads: (number | undefined)[] = [];
  const screens: string[] = [];
  const kinds: (string | null)[] = [];
  let failWrite = false;
  let failRead = false;
  let edits = 0;
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
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
      return description;
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
    edits: () => edits,
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
  assert.throws(() => s.engine.tick());
  assert.ok(s.screens.some((screen) => screen.includes("Unable to restore")));
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
