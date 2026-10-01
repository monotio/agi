/**
 * Same-Engine atomic Play-preview admission: a complete candidate container
 * image is staged detached, then commits synchronously into the running
 * Engine at a naturally completed idle-cycle boundary — or refuses without
 * touching live state. Every byte, pixel and priority expectation below is
 * hand-computed from the resources assembled in this file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openContainer, createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { buildObjectFile } from "../src/authoring/inventory.ts";
import { buildView } from "../src/view/view.ts";
import type { GameContainer } from "../src/types.ts";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";

const DICT_WORDS: [string, number][] = [
  ["look", 100],
  ["take", 101],
  ["key", 102],
];
const DICT = new Map(DICT_WORDS);

/** Visual on color 1, flood fill the whole 160x168 area, end. */
const PIC_BLUE = new Uint8Array([0xf0, 1, 0xf8, 80, 80, 0xff]);
/** Visual on color 2, absolute line (10,10)-(20,10), end. */
const PIC_RED_LINE = new Uint8Array([0xf0, 2, 0xf6, 10, 10, 20, 10, 0xff]);
/**
 * Visual on color 3, line (10,30)-(20,30); priority on color 5, full-width
 * line at row 150, priority off, end.
 */
const PIC_GREEN_PRI = new Uint8Array([
  0xf0, 3, 0xf6, 10, 30, 20, 30, 0xf2, 5, 0xf6, 0, 150, 159, 150, 0xf3, 0xff,
]);

/** One-channel two-tick tone, the hand-authored shape host-wait tests use. */
const SOUND_A = new Uint8Array([
  8, 0, 15, 0, 15, 0, 15, 0, 2, 0, 0x23, 0x81, 0x94, 0xff, 0xff, 0xff, 0xff,
]);
/** Same structure, a different tone divisor — a real sound replacement. */
const SOUND_B = new Uint8Array([
  8, 0, 15, 0, 15, 0, 15, 0, 2, 0, 0x24, 0x81, 0x94, 0xff, 0xff, 0xff, 0xff,
]);

function viewSolid(width: number, height: number, color: number): Uint8Array {
  return buildView({
    loops: [{ cels: [{ width, height, pixels: new Array<number>(width * height).fill(color) }] }],
  });
}

const LOGIC_0 = `
if (!isset(f200)) {
  set(f200);
  assignn(v0, 1);
  new.room.v(v0);
}
call.v(v0);
return;
`;

/**
 * Room 1: blue backdrop plus a red overlay line, ego (o0, view 0 at 20,130),
 * a second actor (o1, view 1 at 80,130), sound 1 playing with f30 as the
 * completion flag, parser input accepted. v200 counts logic invocations so a
 * re-init would be observable; v60/v70 drive the scripted probes each test
 * arms. v77 carries one RNG draw per call.
 */
const LOGIC_1 = `
#message 1 "Room one."
#message 2 "Name"
if (isset(f5)) {
  assignn(v10, 1); load.pic(v10); draw.pic(v10);
  assignn(v11, 2); load.pic(v11); overlay.pic(v11);
  show.pic();
  load.view(0); animate.obj(o0); set.view(o0, 0); position(o0, 20, 130); draw(o0);
  load.view(1); animate.obj(o1); set.view(o1, 1); position(o1, 80, 130); draw(o1);
  load.sound(1); sound(1, f30);
  accept.input();
}
addn(v200, 1);
if (equaln(v60, 2)) { get.string(s0, 2, 4, 5, 20); reset(v60); }
if (equaln(v60, 4)) { print(1); reset(v60); }
if (equaln(v60, 5)) { add.to.pic(0, 0, 0, 50, 8, 4, 0); reset(v60); }
if (equaln(v60, 6)) { get(0); reset(v60); }
if (equaln(v60, 7)) { position(o0, 50, 130); reset(v60); }
if (equaln(v60, 8)) { sound(1, f31); reset(v60); }
if (equaln(v60, 9)) { load.view(2); set.view(o1, 2); reset(v60); }
if (equaln(v70, 3)) { call(2); reset(v70); }
random(0, 255, v77);
return;
`;

/**
 * The scan.start probe: the first call runs addn(v54) once, then
 * set.scan.start records the offset of addn(v55). A later call resumes at
 * the recorded offset, skipping v54 — so v54==1 while v55 counts calls.
 */
const LOGIC_2 = `
addn(v54, 1);
set.scan.start();
addn(v55, 1);
return;
`;

/** Same code as LOGIC_2 with one extra message — payload differs, code identical. */
const LOGIC_2_MESSAGES = `
#message 1 "Message only edit."
addn(v54, 1);
set.scan.start();
addn(v55, 1);
return;
`;

/** Code change for the scanStart refusal case. */
const LOGIC_2_CHANGED = `
addn(v54, 1);
set.scan.start();
addn(v55, 2);
return;
`;

/** A different room-1 message plus a different cycle increment. */
const LOGIC_1_CHANGED = `
#message 1 "Room one, edited."
#message 2 "Name"
if (isset(f5)) {
  assignn(v10, 1); load.pic(v10); draw.pic(v10);
  assignn(v11, 2); load.pic(v11); overlay.pic(v11);
  show.pic();
  load.view(0); animate.obj(o0); set.view(o0, 0); position(o0, 20, 130); draw(o0);
  load.view(1); animate.obj(o1); set.view(o1, 1); position(o1, 80, 130); draw(o1);
  load.sound(1); sound(1, f30);
  accept.input();
}
addn(v200, 2);
if (equaln(v60, 2)) { get.string(s0, 2, 4, 5, 20); reset(v60); }
if (equaln(v60, 4)) { print(1); reset(v60); }
if (equaln(v60, 5)) { add.to.pic(0, 0, 0, 50, 8, 4, 0); reset(v60); }
if (equaln(v60, 6)) { get(0); reset(v60); }
if (equaln(v60, 7)) { position(o0, 50, 130); reset(v60); }
if (equaln(v60, 8)) { sound(1, f31); reset(v60); }
if (equaln(v60, 9)) { load.view(2); set.view(o1, 2); reset(v60); }
if (equaln(v70, 3)) { call(2); reset(v70); }
random(0, 255, v77);
return;
`;

class QuietHost implements EngineHost {
  prints: string[] = [];
  inputLines: (string | null)[] = [];
  played: { num: number; payload: Uint8Array }[] = [];
  ackPrints = true;
  private nextRand = 0;
  engine?: Engine;
  print(text: string): void {
    this.prints.push(text);
    if (this.ackPrints) this.engine?.ackPrint();
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return this.inputLines.shift() ?? null;
  }
  takeKeys(): number[] {
    return [];
  }
  /** Deterministic RNG lane: 1, 2, 3, ... modulo 256. */
  randomByte(): number {
    this.nextRand = (this.nextRand + 1) & 255;
    return this.nextRand;
  }
  playSound(num: number, payload: Uint8Array): void {
    this.played.push({ num, payload });
  }
  /** get.string cannot answer synchronously here: it parks via HostWait. */
  promptString(): string {
    throw new HostWait();
  }
}

function buildGame(): GameContainer {
  const container = createContainer();
  container.putFile("WORDS.TOK", buildWordsTok(DICT_WORDS.map(([word, id]) => ({ word, id }))));
  container.putFile("OBJECT", buildObjectFile([{ name: "key", startingRoom: 1 }]));
  container.putResource("logic", 0, assembleLogic(LOGIC_0, { dictionary: DICT }).payload);
  container.putResource("logic", 1, assembleLogic(LOGIC_1, { dictionary: DICT }).payload);
  container.putResource("logic", 2, assembleLogic(LOGIC_2, { dictionary: DICT }).payload);
  container.putResource("picture", 1, PIC_BLUE);
  container.putResource("picture", 2, PIC_RED_LINE);
  container.putResource("view", 0, viewSolid(4, 4, 5));
  container.putResource("view", 1, viewSolid(2, 2, 9));
  container.putResource("sound", 1, SOUND_A);
  return container;
}

function booted(): { engine: Engine; host: QuietHost } {
  const host = new QuietHost();
  const engine = new Engine(buildGame(), host, DICT);
  host.engine = engine;
  engine.tick();
  return { engine, host };
}

/** Build a complete candidate image by replaying edits on a detached container. */
function candidateFiles(
  base: ReadonlyMap<string, Uint8Array>,
  edit: (container: GameContainer) => void,
): Map<string, Uint8Array> {
  const staged = openContainer(base);
  edit(staged);
  return new Map(staged.files);
}

/** Replay state with the intentionally bumped field removed for equality. */
function stateMinusGeneration(state: ReturnType<Engine["captureReplayState"]>) {
  const { patchGeneration: _gen, ...rest } = state;
  return rest;
}

test("coordinated LOGIC+WORDS+OBJECT+PIC update commits atomically and preserves runtime state", () => {
  const { engine, host } = booted();
  engine.tick();
  engine.tick();
  assert.equal(engine.vars[200], 3, "logic 1 ran once per cycle so far");
  engine.advanceClock(61000);
  engine.setEditLine("ta");
  engine.vars[60] = 7;
  engine.tick(); // position(o0, 50, 130)
  assert.equal(engine.screenObjects[0]!.x, 50);
  const replayBefore = engine.captureReplayState();
  const patchGenBefore = engine.patchGeneration;
  const volBefore = engine.containerFiles.get("VOL.0")!.slice();

  const newLogic1 = assembleLogic(LOGIC_1_CHANGED, { dictionary: DICT }).payload;
  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("logic", 1, newLogic1);
    c.putResource("picture", 2, PIC_GREEN_PRI);
    c.putFile(
      "WORDS.TOK",
      buildWordsTok(
        ([...DICT_WORDS, ["now", 103]] as [string, number][]).map(([word, id]) => ({ word, id })),
      ),
    );
    c.putFile(
      "OBJECT",
      buildObjectFile([
        { name: "key", startingRoom: 1 },
        { name: "lamp", startingRoom: 7 },
      ]),
    );
  });

  const v200Before = engine.vars[200]!;
  const clockBefore = [engine.vars[11], engine.vars[12], engine.vars[13], engine.vars[14]];
  const result = engine.applyPreviewUpdate({ files });
  assert.equal(result.status, "committed");
  assert.equal(result.patchGeneration, patchGenBefore + 1);

  // Runtime state preserved exactly (patchGeneration is the one bumped field).
  assert.deepEqual(
    stateMinusGeneration(engine.captureReplayState()),
    stateMinusGeneration(replayBefore),
  );
  assert.equal(engine.vars[200], v200Before, "no initialization rerun");
  assert.deepEqual(
    [engine.vars[11], engine.vars[12], engine.vars[13], engine.vars[14]],
    clockBefore,
    "game clock counters preserved",
  );
  assert.equal(engine.screenObjects[0]!.x, 50, "actor position preserved");
  assert.equal(engine.inputEdit, "ta", "input edit buffer preserved");
  assert.equal(engine.readState().room, 1, "room identity preserved");

  // Installed bytes are the candidate bytes.
  const installed = openContainer(engine.containerFiles);
  assert.deepEqual(installed.getResource("logic", 1), newLogic1);
  assert.deepEqual(installed.getResource("picture", 2), PIC_GREEN_PRI);
  assert.notDeepEqual(engine.containerFiles.get("VOL.0"), volBefore);

  // Rebuilt backdrop: the red row-10 line is gone, the green row-30 line and
  // the row-150 priority line are now the backdrop.
  const frame = engine.getFrame();
  assert.equal(frame.visual[10 * 160 + 10], 1, "old overlay pixel restored to fill");
  assert.equal(frame.visual[30 * 160 + 10], 3, "new overlay line drawn");
  assert.equal(frame.visual[30 * 160 + 20], 3);
  assert.equal(frame.visual[30 * 160 + 21], 1);
  assert.equal(frame.priority[150 * 160 + 0], 5, "new priority line drawn");
  assert.equal(frame.priority[149 * 160 + 0], 4, "untouched priority row preserved");

  // New dictionary parses the added word.
  host.inputLines.push("now");
  engine.tick();
  assert.deepEqual(engine.parsedWords, [103]);

  // Append-only inventory: old location kept, new slot initialized.
  const inventory = engine.readState().inventory;
  assert.deepEqual(
    inventory.map((item) => [item.name, item.room]),
    [
      ["key", 1],
      ["lamp", 7],
    ],
  );

  // The new logic really runs: v200 now advances by 2 per call.
  const v200 = engine.vars[200]!;
  engine.tick();
  assert.equal(engine.vars[200], v200 + 2, "installed LOGIC executes");
});

test("malformed WORDS.TOK refuses the whole candidate and leaves exact prior state", () => {
  const { engine } = booted();
  engine.tick();
  const volBefore = engine.containerFiles.get("VOL.0")!.slice();
  const wordsBefore = engine.containerFiles.get("WORDS.TOK")!.slice();
  const patchGenBefore = engine.patchGeneration;
  const v200 = engine.vars[200]!;

  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("picture", 2, PIC_GREEN_PRI);
    c.putFile("OBJECT", buildObjectFile([{ name: "key", startingRoom: 1 }, { name: "lamp" }]));
    c.putFile("WORDS.TOK", new Uint8Array([0xde, 0xad, 0xbe]));
  });
  const result = engine.applyPreviewUpdate({ files });
  assert.equal(result.status, "refused");
  assert.equal(engine.patchGeneration, patchGenBefore);
  assert.deepEqual(engine.containerFiles.get("VOL.0"), volBefore);
  assert.deepEqual(engine.containerFiles.get("WORDS.TOK"), wordsBefore);
  const frame = engine.getFrame();
  assert.equal(frame.visual[10 * 160 + 10], 2, "old overlay still on screen");
  assert.deepEqual(
    engine.readState().inventory.map((i) => i.name),
    ["key"],
  );
  engine.tick();
  assert.equal(engine.vars[200], v200 + 1, "real progressed state still advances after refusal");
});

test("invalid OBJECT refuses the whole candidate before any live mutation", () => {
  const { engine } = booted();
  const volBefore = engine.containerFiles.get("VOL.0")!.slice();
  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("picture", 2, PIC_GREEN_PRI);
    c.putFile("OBJECT", new Uint8Array([7]));
  });
  const result = engine.applyPreviewUpdate({ files });
  assert.equal(result.status, "refused");
  assert.deepEqual(engine.containerFiles.get("VOL.0"), volBefore);
  assert.equal(engine.getFrame().visual[10 * 160 + 10], 2);
});

test("malformed VIEW refuses and keeps the previously decoded view", () => {
  const { engine } = booted();
  assert.equal(engine.getFrame().visual[130 * 160 + 20], 5, "ego drawn in color 5");
  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("view", 0, new Uint8Array([0, 0, 1, 0])); // shorter than the 5-byte header
  });
  const result = engine.applyPreviewUpdate({ files });
  assert.equal(result.status, "refused");
  assert.equal(
    engine.getFrame().visual[130 * 160 + 20],
    5,
    "objects keep drawing the old view pixels",
  );
});

test("invalid LOGIC syntax refuses atomically", () => {
  const { engine } = booted();
  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("logic", 1, new Uint8Array([1, 2, 3]));
  });
  const result = engine.applyPreviewUpdate({ files });
  assert.equal(result.status, "refused");
  assert.equal(engine.vars[200], 1, "state untouched");
});

test("profile and layout-incompatible candidates require restart", () => {
  const { engine } = booted();
  const profileResult = engine.applyPreviewUpdate({
    files: engine.containerFiles,
    profile: "2.440",
  });
  assert.equal(profileResult.status, "restartRequired");

  const files = new Map(engine.containerFiles);
  files.set("XXDIR", new Uint8Array(256).fill(0xff));
  const layoutResult = engine.applyPreviewUpdate({ files });
  assert.equal(layoutResult.status, "restartRequired");
});

test("a resource removal inside a mixed candidate requires restart and installs nothing", () => {
  const { engine } = booted();
  const wordsBefore = engine.containerFiles.get("WORDS.TOK")!.slice();
  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResources([{ kind: "view", num: 1, payload: null }]);
    c.putFile(
      "WORDS.TOK",
      buildWordsTok(
        ([...DICT_WORDS, ["now", 103]] as [string, number][]).map(([word, id]) => ({ word, id })),
      ),
    );
  });
  const result = engine.applyPreviewUpdate({ files });
  assert.equal(result.status, "restartRequired");
  assert.match(result.reason ?? "", /removes/);
  assert.deepEqual(engine.containerFiles.get("WORDS.TOK"), wordsBefore, "WORDS not installed");
  assert.ok(
    engine.screenObjects.some((o) => o.view === 1),
    "view 1 still bound",
  );
});

test("removing WORDS.TOK or adding unsupported files requires restart", () => {
  const { engine } = booted();
  const noWords = new Map(engine.containerFiles);
  noWords.delete("WORDS.TOK");
  assert.equal(engine.applyPreviewUpdate({ files: noWords }).status, "restartRequired");

  const extra = new Map(engine.containerFiles);
  extra.set("FOO.BAR", new Uint8Array([1]));
  const result = engine.applyPreviewUpdate({ files: extra });
  assert.equal(result.status, "restartRequired");
  assert.match(result.reason ?? "", /FOO\.BAR/);
});

test("a parked host interaction defers; the queued answer defers; commit lands after", () => {
  const { engine } = booted();
  engine.vars[60] = 2;
  engine.tick(); // get.string suspends the pass
  assert.ok(engine.hostInteractionPending, "get.string interaction parked");

  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("picture", 2, PIC_GREEN_PRI);
  });
  const plan = engine.preparePreviewUpdate({ files });
  const first = engine.commitPreviewUpdate(plan);
  assert.equal(first.status, "deferred");
  assert.equal(engine.getFrame().visual[30 * 160 + 10], 1, "surface untouched while deferred");

  engine.deliverHostAnswer("Herald");
  const second = engine.commitPreviewUpdate(plan);
  assert.equal(second.status, "deferred", "a queued answer is not an idle boundary");

  engine.tick(); // the parked pass resumes on the OLD image and completes
  assert.equal(engine.strings[0], "Herald");
  const third = engine.commitPreviewUpdate(plan);
  assert.equal(third.status, "committed");
  assert.equal(engine.getFrame().visual[30 * 160 + 10], 3);
});

test("a debug stop latch defers, and an armed observer defers", () => {
  const { engine } = booted();
  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("picture", 2, PIC_GREEN_PRI);
  });

  engine.pauseExecution();
  assert.equal(engine.applyPreviewUpdate({ files }).status, "deferred");
  engine.resumeExecution();
  engine.tick();
  assert.equal(engine.applyPreviewUpdate({ files }).status, "committed");

  const { engine: armed } = booted();
  armed.setExecutionObserver(() => {});
  assert.equal(armed.applyPreviewUpdate({ files }).status, "deferred");
  armed.setExecutionObserver(null);
  assert.equal(armed.applyPreviewUpdate({ files }).status, "committed");
});

test("a byte-identical plan defers only when flagged source authority moved", () => {
  const { engine } = booted();
  engine.pauseExecution();

  // An exact no-change is an honest "unchanged" answer even at a busy
  // boundary — nothing is being installed.
  assert.equal(
    engine.commitPreviewUpdate(engine.preparePreviewUpdate({ files: engine.containerFiles }))
      .status,
    "unchanged",
  );

  // Flagged source-authority change on identical bytes inherits the same
  // idle boundary: deferred, and the plan stays usable.
  const flagged = engine.preparePreviewUpdate({ files: engine.containerFiles });
  assert.equal(
    engine.commitPreviewUpdate(flagged, { sourceAuthorityChanged: true }).status,
    "deferred",
  );

  // Terminal verdicts report honestly under the flag: a candidate that
  // cannot stage is still refused, not deferred.
  const malformed = engine.preparePreviewUpdate({
    files: { "VOL.0": new Uint8Array(4) },
  });
  assert.equal(
    engine.commitPreviewUpdate(malformed, { sourceAuthorityChanged: true }).status,
    "refused",
  );

  engine.resumeExecution();
  engine.tick();
  assert.equal(
    engine.commitPreviewUpdate(flagged, { sourceAuthorityChanged: true }).status,
    "unchanged",
    "the retained plan re-validates at the natural boundary",
  );
});

test("an open modal window defers", () => {
  const { engine, host } = booted();
  host.ackPrints = false; // leave the print window open
  engine.vars[60] = 4;
  engine.tick(); // print(1) parks on the modal
  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("picture", 2, PIC_GREEN_PRI);
  });
  assert.equal(engine.applyPreviewUpdate({ files }).status, "deferred");
  engine.ackPrint();
  engine.tick();
  assert.equal(engine.applyPreviewUpdate({ files }).status, "committed");
});

test("scan.start: a real code change requires restart, a message-only change commits", () => {
  const { engine } = booted();
  engine.vars[70] = 3;
  engine.tick(); // call(2): v54=1, scanStart[2] recorded, v55=1
  assert.equal(engine.vars[54], 1);
  assert.equal(engine.vars[55], 1);

  const codeChange = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("logic", 2, assembleLogic(LOGIC_2_CHANGED, { dictionary: DICT }).payload);
  });
  const refused = engine.applyPreviewUpdate({ files: codeChange });
  assert.equal(refused.status, "restartRequired");
  assert.match(refused.reason ?? "", /scan\.start/);

  // The same candidate as a message-table-only edit commits: identical code.
  const messageOnly = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("logic", 2, assembleLogic(LOGIC_2_MESSAGES, { dictionary: DICT }).payload);
  });
  assert.equal(engine.applyPreviewUpdate({ files: messageOnly }).status, "committed");

  // The parked offset still governs: the next call resumes past set.scan.start.
  engine.vars[70] = 3;
  engine.tick();
  assert.equal(engine.vars[55], 2, "call resumed at the recorded offset");
  assert.equal(engine.vars[54], 1, "the pre-marker instruction did not rerun");
});

test("append-only OBJECT keeps old locations and initializes the new slot", () => {
  const { engine } = booted();
  engine.vars[60] = 6;
  engine.tick(); // get(0): key becomes carried (room 255)
  assert.deepEqual(
    engine.readState().inventory.map((i) => [i.name, i.room]),
    [["key", 255]],
  );
  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putFile(
      "OBJECT",
      buildObjectFile([
        { name: "key", startingRoom: 1 },
        { name: "lamp", startingRoom: 7 },
      ]),
    );
  });
  assert.equal(engine.applyPreviewUpdate({ files }).status, "committed");
  assert.deepEqual(
    engine.readState().inventory.map((i) => [i.name, i.room]),
    [
      ["key", 255],
      ["lamp", 7],
    ],
    "live location preserved, new slot initialized from metadata",
  );
});

test("OBJECT reorder and record-count changes require restart", () => {
  const { engine } = booted();
  const reordered = candidateFiles(engine.containerFiles, (c) => {
    c.putFile(
      "OBJECT",
      buildObjectFile([
        { name: "lamp", startingRoom: 1 },
        { name: "key", startingRoom: 9 },
      ]),
    );
  });
  const reorderResult = engine.applyPreviewUpdate({ files: reordered });
  assert.equal(reorderResult.status, "restartRequired");
  assert.match(reorderResult.reason ?? "", /OBJECT/);

  const shrunk = candidateFiles(engine.containerFiles, (c) => {
    c.putFile("OBJECT", buildObjectFile([], undefined, 200));
  });
  assert.equal(engine.applyPreviewUpdate({ files: shrunk }).status, "restartRequired");
});

test("a changed SOUND leaves the playing cue alone; the next trigger uses new bytes", () => {
  const { engine, host } = booted();
  assert.deepEqual(
    host.played.map((p) => [p.num, p.payload]),
    [[1, SOUND_A]],
    "boot played the original cue",
  );
  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("sound", 1, SOUND_B);
  });
  assert.equal(engine.applyPreviewUpdate({ files }).status, "committed");
  assert.equal(host.played.length, 1, "the running cue was not restarted");

  // Channel countdown arms at 1: tick 1 decodes the 2-tick note, ticks 2-3
  // count it down, and tick 3's boundary terminates the channel.
  engine.soundTick();
  engine.soundTick();
  engine.soundTick();
  assert.equal(engine.flags[30], 1, "the old decoded stream finished on its own clock");

  engine.vars[60] = 8;
  engine.tick(); // sound(1, f31) triggers the replacement payload
  assert.equal(host.played.length, 2);
  assert.deepEqual(host.played[1]!.payload, SOUND_B);
});

test("byte-identical candidates report unchanged; added resources install", () => {
  const { engine } = booted();
  const genBefore = engine.patchGeneration;
  const unchanged = engine.applyPreviewUpdate({ files: engine.containerFiles });
  assert.equal(unchanged.status, "unchanged");
  assert.equal(engine.patchGeneration, genBefore, "no generation bump for equal bytes");

  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("sound", 9, SOUND_B);
  });
  assert.equal(engine.applyPreviewUpdate({ files }).status, "committed");
  assert.equal(engine.patchGeneration, genBefore + 1);
  assert.deepEqual(openContainer(engine.containerFiles).getResource("sound", 9), SOUND_B);
});

test("prepared plans are engine-bound, single-use, and generation-checked", () => {
  const { engine: first } = booted();
  const { engine: second } = booted();
  const files = candidateFiles(first.containerFiles, (c) => {
    c.putResource("picture", 2, PIC_GREEN_PRI);
  });
  const foreignPlan = first.preparePreviewUpdate({ files });
  assert.equal(
    second.commitPreviewUpdate(foreignPlan).status,
    "refused",
    "a foreign plan does not commit on another engine",
  );
  // The issuing engine still owns it.
  assert.equal(first.commitPreviewUpdate(foreignPlan).status, "committed");
  assert.equal(
    first.commitPreviewUpdate(foreignPlan).status,
    "refused",
    "a settled plan cannot commit twice",
  );

  const stalePlan = second.preparePreviewUpdate({ files });
  second.patchResources([{ kind: "sound", num: 9, payload: SOUND_A }]);
  const stale = second.commitPreviewUpdate(stalePlan);
  assert.equal(stale.status, "refused");
  assert.match(stale.reason ?? "", /stale/);
});

test("add.to.pic composition requires restart and leaves the backdrop intact", () => {
  const { engine } = booted();
  engine.vars[60] = 5;
  engine.tick(); // stamp object pixels into the picture
  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("picture", 2, PIC_GREEN_PRI);
  });
  const result = engine.applyPreviewUpdate({ files });
  assert.equal(result.status, "restartRequired");
  assert.equal(engine.getFrame().visual[10 * 160 + 10], 2, "old overlay still there");
});

test("staged candidate bytes stay detached until commit", () => {
  const { engine } = booted();
  const newLogic1 = assembleLogic(LOGIC_1_CHANGED, { dictionary: DICT }).payload;
  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("logic", 1, newLogic1);
  });
  const plan = engine.preparePreviewUpdate({ files });
  // Mutating the caller's own buffer must not reach the staged image.
  files.get("VOL.0")![0] = 0xee;
  const vol0First = engine.containerFiles.get("VOL.0")![0]!;
  assert.equal(engine.commitPreviewUpdate(plan).status, "committed");
  assert.deepEqual(openContainer(engine.containerFiles).getResource("logic", 1), newLogic1);
  assert.equal(
    engine.containerFiles.get("VOL.0")![0],
    vol0First,
    "caller-side mutation never leaked into the installed image",
  );
});

test("an unused VIEW or PIC change installs for the next normal use", () => {
  const { engine } = booted();
  const newView2 = viewSolid(2, 2, 11);
  const files = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("view", 2, newView2);
    c.putResource("picture", 3, PIC_GREEN_PRI);
  });
  assert.equal(engine.applyPreviewUpdate({ files }).status, "committed");
  assert.equal(engine.getFrame().visual[10 * 160 + 10], 2, "backdrop untouched");

  engine.vars[60] = 9;
  engine.tick(); // load.view(2); set.view(o1, 2)
  assert.equal(engine.screenObjects[1]!.view, 2);
  assert.equal(engine.getFrame().visual[130 * 160 + 80], 11, "new view pixels draw");
});

test("a geometry-preserving VIEW change updates pixels; geometry changes refuse", () => {
  const { engine } = booted();
  const recolor = candidateFiles(engine.containerFiles, (c) => {
    c.putResource("view", 0, viewSolid(4, 4, 7));
  });
  const recolorResult = engine.applyPreviewUpdate({ files: recolor });
  assert.equal(recolorResult.status, "committed");
  const o0 = engine.screenObjects[0]!;
  assert.deepEqual([o0.x, o0.y, o0.width, o0.height], [20, 130, 4, 4], "geometry untouched");
  const frame = engine.getFrame();
  assert.equal(frame.visual[130 * 160 + 20], 7, "recolored pixels draw");
  assert.equal(frame.visual[127 * 160 + 23], 7, "cel top edge at baseline-minus-height");

  const { engine: second } = booted();
  const widened = candidateFiles(second.containerFiles, (c) => {
    c.putResource("view", 0, viewSolid(8, 8, 7));
  });
  const refused = second.applyPreviewUpdate({ files: widened });
  assert.equal(refused.status, "restartRequired");
  assert.match(refused.reason ?? "", /view 0/);
  assert.equal(second.screenObjects[0]!.width, 4, "old geometry still active");
});
