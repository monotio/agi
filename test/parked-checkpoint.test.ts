import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { OperationRecorder } from "../src/agent/recordedReplay.ts";
import { playtestRoom } from "../src/agent/playtest.ts";
import { buildObjectFile, createAgentSessionState } from "../src/agent/tools.ts";

/**
 * Checkpoints at parked boundaries (docs/fidelity.md parked-host-waits). A
 * pass suspended behind a window or a have.key wait is a resumable state:
 * the host autosave serializes the parked continuation, and a restore
 * resumes the identical instruction instead of starting a fresh pass.
 * Prompts, the selector, confirmations and room authoring hold a live host
 * request — they stay non-snapshot points.
 */

/** Every interaction service suspends; keys arrive through a scripted queue. */
class SuspendingHost implements EngineHost {
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
  waitKey(): number {
    throw new HostWait();
  }
  promptString(): string {
    throw new HostWait();
  }
  promptNumber(): number {
    throw new HostWait();
  }
  listSaveGames(): { slot: number; bytes: Uint8Array }[] {
    throw new HostWait();
  }
  promptSaveDescription(): string | null {
    throw new HostWait();
  }
  saveGame(): boolean {
    throw new HostWait();
  }
  restoreGame(): Uint8Array | null {
    throw new HostWait();
  }
}

// Blue box outline (10,10)-(60,40), filled, plus a priority line at y=150.
const PICTURE_1 = new Uint8Array([
  0xf0, 0x01, 0xf6, 10, 10, 60, 10, 60, 40, 10, 40, 10, 10, 0xf8, 30, 20, 0xf1, 0xf2, 0x05, 0xf6, 0,
  150, 159, 150, 0xf3, 0xff,
]);

/**
 * A two-logic game: logic 0 enters room 1 once, logic 1 draws a picture on
 * the new-room flag so the autosave's snapshot guard has a room to resume —
 * then runs `body` every pass.
 */
function gameWith(body: string) {
  const container = createContainer();
  container.putResource("picture", 1, PICTURE_1);
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) { set(f200); assignn(v0, 1); new.room.v(v0); } call.v(v0); return;`,
      { dictionary: new Map() },
    ).payload,
  );
  container.putResource(
    "logic",
    1,
    assembleLogic(
      `#message 1 "Hello"
       if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); }
       ${body}
       return;`,
      { dictionary: new Map() },
    ).payload,
  );
  return container;
}

test("autosave while a print window is up round-trips the window and the pass", () => {
  const container = gameWith(`increment(v60);\nprint(1);\nassignn(v101, 7);`);
  const engine = new Engine(container, new SuspendingHost(), new Map());
  engine.tick();
  assert.equal(engine.modalKind, "print", "the window is up");
  assert.equal(engine.continuationPending, true, "the pass is parked");
  const image = engine.autosaveImage();
  assert.notEqual(image, null, "a parked window snapshots");
  const surface = engine.textCells.slice();
  assert.equal(engine.vars[60], 1);
  assert.equal(engine.vars[101], 0, "the instruction after print has not run");

  const restored = new Engine(container, new SuspendingHost(), new Map());
  restored.restoreImage(image!);
  assert.equal(restored.modalKind, "print", "the parked window is restored");
  assert.equal(restored.continuationPending, true, "the pass is still parked");
  assert.equal(restored.vars[60], 1);
  assert.equal(restored.vars[101], 0, "the suspended instruction has not run yet");
  assert.deepEqual(restored.textCells, surface, "the window is drawn identically");

  const restoredHost = new SuspendingHost();
  const resumed = new Engine(container, restoredHost, new Map());
  resumed.restoreImage(image!);
  restoredHost.keys.push(13); // Enter acknowledges the window
  resumed.tick();
  assert.equal(resumed.modalKind, null, "Enter drained the restored window");
  assert.equal(resumed.vars[101], 7, "the parked pass resumed at its instruction");
  assert.equal(resumed.vars[60], 1, "nothing before the window re-ran");
});

test("a parked have.key round-trips and resumes with the delivered key once", () => {
  const container = gameWith(`
    increment(v60);
    wait: if (!have.key()) { goto wait; }
    assignv(v100,v19);
    assignn(v101, 7);
  `);
  const engine = new Engine(container, new SuspendingHost(), new Map());
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "key");
  const image = engine.autosaveImage();
  assert.notEqual(image, null, "a parked key wait snapshots");

  const restored = new Engine(container, new SuspendingHost(), new Map());
  restored.restoreImage(image!);
  assert.equal(restored.hostInteraction?.kind, "key", "the wait restores armed");
  assert.equal(restored.awaitingKey, true);

  restored.deliverHostAnswer(0x62);
  restored.tick();
  assert.equal(restored.vars[100], 0x62, "the delivered key reached the resumed IF");
  assert.equal(restored.vars[60], 1, "the resumed pass did not re-run earlier actions");
  assert.equal(restored.vars[101], 7, "execution continued past the resumed IF");
});

test("a continuation from a different resource revision is dropped and the windows peel", () => {
  const container = gameWith(`
    increment(v60);
    if (equaln(v60, 2)) { print(1); }
    assignn(v101, 7);
  `);
  const engine = new Engine(container, new SuspendingHost(), new Map());
  engine.tick(); // room draws; v60 = 1, no window yet
  const preWindow = engine.textCells.slice();
  engine.tick(); // v60 = 2: the print parks the pass
  assert.equal(engine.modalKind, "print");
  const image = engine.autosaveImage()!;

  const restored = new Engine(container, new SuspendingHost(), new Map());
  // An authored patch between snapshot and resume supersedes the parked
  // pass's bytecode: the continuation drops, the windows peel back onto the
  // snapshot's surface, and the next tick starts a fresh pass.
  restored.patchResource("logic", 0, assembleLogic("return;", { dictionary: new Map() }).payload);
  restored.restoreImage(image);
  assert.equal(restored.modalKind, null, "no phantom window survives the peel");
  assert.equal(restored.continuationPending, false, "no stale pass resumes");
  assert.deepEqual(
    restored.textCells.slice(),
    preWindow,
    "the cells under the former window match the pre-window surface",
  );
});

test("prompts, selectors and confirmations remain non-snapshot points", () => {
  const stringPrompt = new Engine(
    gameWith(`#message 2 "Name?"\nget.string(s1, 2, 0, 0, 10);`),
    new SuspendingHost(),
    new Map(),
  );
  stringPrompt.tick();
  assert.equal(stringPrompt.hostInteraction?.kind, "getstring");
  assert.equal(stringPrompt.autosaveImage(), null);

  const selector = new Engine(gameWith(`save.game();`), new SuspendingHost(), new Map());
  selector.tick();
  assert.equal(selector.hostInteraction?.kind, "saveDialog");
  assert.equal(selector.autosaveImage(), null);

  const confirm = new Engine(gameWith(`quit(0);`), new SuspendingHost(), new Map());
  confirm.tick();
  assert.equal(confirm.hostInteraction?.kind, "confirm");
  assert.equal(confirm.autosaveImage(), null);
});

test("a recording started on a parked key wait replays the delivered key", () => {
  const state = createAgentSessionState();
  state.objectPayload = buildObjectFile([], state.profile, 20);
  state.container.putResource("picture", 1, PICTURE_1);
  state.container.putResource(
    "logic",
    0,
    assembleLogic(`if (!isset(f200)) { set(f200); new.room(1); } call(1); return;`, {
      dictionary: new Map(),
    }).payload,
  );
  state.container.putResource(
    "logic",
    1,
    assembleLogic(
      `if (isset(f5)) { assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic(); }
       increment(v60);
       wait: if (!have.key()) { goto wait; }
       assignv(v100,v19);
       assignn(v101, 7);
       return;`,
      { dictionary: new Map() },
    ).payload,
  );
  const tape = new OperationRecorder();
  const host = new (class extends SuspendingHost {
    // Host calls record into the open tick exactly as the worker's host does.
    override takeKeys(): number[] {
      const batch = this.keys.splice(0);
      tape.host(["keys", batch]);
      return batch;
    }
    override takeInputLine(): string | null {
      tape.host(["line", null]);
      return null;
    }
  })();
  const engine = new Engine(openContainer(state.getFiles()), host);
  engine.tick();
  assert.equal(engine.awaitingKey, true, "parked on the key wait");

  // The worker's record-start pair captures the armed wait; the arriving key
  // then records its delivery inside the tick it resumes.
  const image = engine.recordingImage()!;
  const initial = engine.captureReplayState();
  tape.run("tick", () => {
    tape.host(["waitKey", 0x62]);
    engine.deliverHostAnswer(0x62);
    engine.tick();
  });

  const result = playtestRoom(
    state,
    {
      room: 1,
      steps: [],
      expect: {
        vars: [
          { id: 100, value: 0x62 },
          { id: 101, value: 7 },
          { id: 60, value: 1 },
        ],
      },
    },
    { setupImage: image, replay: { state: initial, operations: tape.operations } },
  );
  assert.equal(result.success, true, result.error ?? result.message ?? "");
});

test("a malformed continuation is rejected without mutating the engine", () => {
  const engine = new Engine(gameWith(`increment(v60);`), new SuspendingHost(), new Map());
  engine.tick();
  const state = JSON.parse(JSON.stringify(engine.captureReplayState())) as Record<string, unknown>;
  const before = engine.serialize();

  state["continuation"] = {
    patchGeneration: 0,
    frames: [{ logic: 0, pc: 70000 }],
    modals: [],
    persistentWindow: null,
    keyWait: null,
  };
  assert.throws(() => engine.restoreReplayState(state), /Replay state/);

  state["continuation"] = {
    patchGeneration: 0,
    frames: [],
    modals: [{ kind: "bogus" }],
    persistentWindow: null,
    keyWait: null,
  };
  assert.throws(() => engine.restoreReplayState(state), /Replay state/);
  assert.deepEqual(engine.serialize(), before, "rejection left the state untouched");
});
