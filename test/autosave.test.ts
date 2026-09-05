import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { SAVE_DESCRIPTION_BYTES } from "../src/runtime/persistence.ts";

/**
 * The host-initiated autosave image.
 *
 * Two claims are worth a test and neither is provable from the app: the bytes
 * an autosave takes are the SAME bytes save.game writes (a different encoder
 * would restore into a subtly different game), and the snapshot is refused at
 * the moments where the save file cannot describe what the player is looking
 * at — an open message window, full-screen text mode, and the gap before a
 * room has drawn anything.
 */

const DICT = new Map([
  ["look", 100],
  ["save", 101],
]);

class RecordingHost implements EngineHost {
  prints: string[] = [];
  /** Images save.game handed over, in order. */
  saved: Uint8Array[] = [];
  inputQueue: (string | null)[] = [];
  keys: number[] = [];
  /** Set post-construction; see saveGame below. */
  engine?: Engine;
  /** The autosave image taken at the instant save.game handed its own over. */
  snapshotAtSave: Uint8Array | null = null;

  print(text: string): void {
    this.prints.push(text);
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return this.inputQueue.shift() ?? null;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
  saveGame(bytes: Uint8Array): void {
    this.saved.push(bytes.slice());
    // Same instant, same interpreter state: the only difference between the
    // two images can be the encoder that produced them.
    this.snapshotAtSave = this.engine?.autosaveImage() ?? null;
  }
}

// Blue box outline (10,10)-(60,40), filled, plus a priority line at y=150.
const PICTURE_1 = new Uint8Array([
  0xf0, 0x01, 0xf6, 10, 10, 60, 10, 60, 40, 10, 40, 10, 10, 0xf8, 30, 20, 0xf1, 0xf2, 0x05, 0xf6, 0,
  150, 159, 150, 0xf3, 0xff,
]);

const LOGIC_0 = `
if (!isset(f200)) {
  set(f200);
  assignn(v0, 1);
  new.room.v(v0);
}
call.v(v0);
return;
`;

const LOGIC_1 = `
#message 1 "You are in room one."
#message 2 "A simple room with four walls."
if (isset(f5)) {
  assignn(v50, 1);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  set.horizon(40);
  animate.obj(o0);
  set.view(o0, 0);
  position(o0, 80, 120);
  draw(o0);
  accept.input();
}
if (said("look")) { print(2); }
if (said("save")) { save.game(); }
return;
`;

function buildGame() {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(LOGIC_0, { dictionary: DICT }).payload);
  container.putResource("logic", 1, assembleLogic(LOGIC_1, { dictionary: DICT }).payload);
  container.putResource("picture", 1, PICTURE_1);
  // Minimal valid view: 1 loop, 1 cel, 1x1 pixel of colour 5.
  container.putResource(
    "view",
    0,
    new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 1, 0, 0x51, 0]),
  );
  return container;
}

/** Block lengths of a save image, in order; also proves the framing is whole. */
function blockLengths(image: Uint8Array, count: number): number[] {
  const lengths: number[] = [];
  let at = SAVE_DESCRIPTION_BYTES;
  for (let i = 0; i < count; i++) {
    lengths.push(image[at]! | (image[at + 1]! << 8));
    at += 2 + lengths[i]!;
  }
  assert.equal(at, image.length, "the blocks account for every byte of the file");
  return lengths;
}

test("an autosave image is byte-identical to what save.game writes", () => {
  const host = new RecordingHost();
  const engine = new Engine(buildGame(), host, DICT);
  engine.tick(); // boot into room 1

  assert.ok(engine.autosaveImage(), "room 1 has drawn, so this boundary is snapshottable");

  // The game saves, and the host takes an autosave from inside save.game's own
  // callback: one interpreter state, two code paths. A cycle boundary would
  // not do — the timer tick and the object update move between cycles, so the
  // images would differ for reasons that say nothing about the encoder.
  host.engine = engine;
  host.inputQueue.push("save");
  engine.tick();
  assert.equal(host.saved.length, 1, "save.game ran once");
  const autosave = host.snapshotAtSave;
  assert.ok(autosave, "the autosave was taken");
  assert.deepEqual(Array.from(autosave), Array.from(host.saved[0]!), "same bytes");

  // Hand-checked envelope (spec "Save-file envelope", profile 2.936): a
  // 31-byte zero-filled description header (the game never called set.simple),
  // then five u16le length-prefixed blocks. Block 1 is the profile's fixed
  // 0x05e1 partition; block 2 is one 0x2b-byte record per drawable object,
  // and with no OBJECT metadata file the profile's own count of 21 applies.
  assert.deepEqual(
    Array.from(autosave.subarray(0, SAVE_DESCRIPTION_BYTES)),
    new Array(SAVE_DESCRIPTION_BYTES).fill(0),
  );
  assert.equal(engine.profile.saveBlocks, 5);
  const lengths = blockLengths(autosave, 5);
  assert.equal(lengths[0], 0x05e1, "block 1");
  assert.equal(lengths[1], 21 * 0x2b, "block 2: 21 object records");
  assert.equal(lengths[2], 0, "block 3: this container ships no OBJECT metadata");
});

test("an autosave is refused while a message window is open", () => {
  const host = new RecordingHost();
  const engine = new Engine(buildGame(), host, DICT);
  engine.tick(); // boot into room 1
  assert.ok(engine.autosaveImage(), "snapshottable while the interpreter runs");

  host.inputQueue.push("look");
  engine.tick();
  assert.equal(engine.modalKind, "print", "the window is up and the world is paused");
  assert.equal(engine.autosaveImage(), null, "no snapshot behind an open window");

  // Dismissed: the next cycle boundary is snapshottable again.
  engine.ackPrint();
  assert.equal(engine.modalKind, null);
  assert.equal(engine.autosaveImage(), null, "the interrupted logic still has to finish");
  engine.tick();
  assert.ok(engine.autosaveImage());
});

test("an autosave is refused before any room has drawn", () => {
  const host = new RecordingHost();
  const engine = new Engine(buildGame(), host, DICT);
  // Nothing has run: the replay sequence is empty, so an image taken here
  // would restore onto a blank screen.
  assert.equal(engine.autosaveImage(), null);
  engine.tick();
  assert.ok(engine.autosaveImage());
});

test("restoreImage replays an autosave into a fresh engine without unwinding", () => {
  const host = new RecordingHost();
  const engine = new Engine(buildGame(), host, DICT);
  engine.tick();
  engine.tick();
  const image = engine.autosaveImage()!;
  const beforeVars = Array.from(engine.vars);
  const beforeVisual = Array.from(engine.surface.visual);

  const freshHost = new RecordingHost();
  const fresh = new Engine(buildGame(), freshHost, DICT);
  assert.equal(new Set(fresh.surface.visual).size, 1, "the fresh surface is blank");

  // The host path returns normally where the bytecode path unwinds.
  fresh.restoreImage(image);

  assert.deepEqual(Array.from(fresh.vars), beforeVars, "v0..v255");
  assert.deepEqual(Array.from(fresh.surface.visual), beforeVisual, "the replayed screen");
  // ...and the restored game keeps cycling.
  fresh.tick();
  assert.equal(fresh.vars[0], 1);
});
