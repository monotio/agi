import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../src/runtime/engine.ts";
import { createAgentSessionState } from "../src/agent/tools.ts";
import { openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { playtestRoom } from "../src/agent/playtest.ts";
test("recording restoration preserves discarded view caches instead of reviving object references", () => {
  const state = createAgentSessionState();
  state.container.putResource(
    "view",
    1,
    buildView({
      loops: [
        {
          cels: [
            { width: 1, height: 1, pixels: [1] },
            { width: 1, height: 1, pixels: [2] },
          ],
        },
      ],
    }),
  );
  state.container.putResource(
    "logic",
    0,
    assembleLogic(
      `
    if (!isset(f200)) {
      set(f200); set.game.id("DEMO"); load.view(1); animate.obj(1); set.view(1,1); discard.view(1);
    }
    last.cel(1,v40); return;
  `,
      { dictionary: new Map() },
    ).payload,
  );
  const host = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
  };
  const source = new Engine(openContainer(state.getFiles()), host);
  source.tick();
  const image = source.recordingImage()!;
  const replay = source.captureReplayState();
  const restored = new Engine(openContainer(state.getFiles()), host);
  restored.restoreImage(image, { preservePresentation: true });
  restored.restoreReplayState(replay);
  assert.deepEqual(restored.recordingImage(), image);
  source.tick();
  restored.tick();
  assert.equal(restored.vars[40], source.vars[40]);
  assert.equal(source.vars[40], 0);
});

function world() {
  const state = createAgentSessionState();
  state.objectPayload = buildObjectFile([], state.profile, 20);
  state.container.putResource("picture", 1, Uint8Array.of(0xff));
  state.container.putResource(
    "logic",
    0,
    assembleLogic(`if (!isset(f200)) {set(f200); new.room(1);} call(1); return;`, {
      dictionary: new Map(),
    }).payload,
  );
  state.container.putResource(
    "logic",
    1,
    assembleLogic(
      `if (isset(f5)) {load.pic(v0);draw.pic(v0);show.pic();display(10,0,"Persistent caption");} increment(v40);return;`,
      { dictionary: new Map() },
    ).payload,
  );
  const engine = new Engine(openContainer(state.getFiles()), {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine() {
      return null;
    },
    takeKeys() {
      return [];
    },
  });
  engine.tick();
  return { state, engine };
}

test("recorded setup preserves caption, parser state and fractional clock through an idle tail", () => {
  const { state, engine } = world();
  engine.advanceClock(990);
  engine.vars[19] = 65;
  engine.flags[2] = 1;
  const image = engine.autosaveImage()!;
  const replayState = engine.captureReplayState();
  const result = playtestRoom(
    state,
    {
      room: 1,
      steps: [],
      expect: {
        text: "Persistent caption",
        vars: [
          { id: 11, value: 1 },
          { id: 19, value: 65 },
        ],
        flags: [{ id: 2, value: true }],
      },
    },
    { setupImage: image, replay: { state: replayState, operations: [["clock", 1]] } },
  );
  assert.equal(result.success, true, result.message ?? "");
});

import {
  OperationRecorder,
  validateRecordedReplay,
  type RecordedHostCall,
} from "../src/agent/recordedReplay.ts";
import { buildRecordedTest } from "../app/src/gameRecording.ts";
import { buildSound, buildObjectFile } from "../src/agent/tools.ts";

function capture(
  logic: string,
  configure?: (state: ReturnType<typeof createAgentSessionState>) => void,
) {
  const state = createAgentSessionState();
  state.objectPayload = buildObjectFile([], state.profile, 20);
  state.container.putResource("picture", 1, Uint8Array.of(0xff));
  state.container.putResource(
    "sound",
    1,
    buildSound([
      { notes: [{ note: "A4", duration: 10, attenuation: 0 }] },
      { notes: [] },
      { notes: [] },
      { notes: [] },
    ]),
  );
  state.container.putResource(
    "logic",
    0,
    assembleLogic("if (!isset(f200)) {set(f200);new.room(1);} call(1);return;", {
      dictionary: new Map(),
    }).payload,
  );
  state.container.putResource(
    "logic",
    1,
    assembleLogic(
      `if (isset(f5)) {load.pic(v0);draw.pic(v0);show.pic();accept.input();} ${logic} return;`,
      { dictionary: new Map() },
    ).payload,
  );
  configure?.(state);
  let tape: OperationRecorder | null = null;
  let keys: number[] = [];
  let random = 410;
  const record = (call: RecordedHostCall) => tape?.host(call);
  const engine = new Engine(openContainer(state.getFiles()), {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine() {
      record(["line", null]);
      return null;
    },
    takeKeys() {
      const batch = keys;
      keys = [];
      record(["keys", batch]);
      return batch;
    },
    randomByte() {
      const value = ++random;
      record(["random", value]);
      return value;
    },
    soundDevice() {
      record(["soundDevice", 1]);
      return 1;
    },
    promptString() {
      for (let i = 0; i < 60; i++) {
        tape?.clock();
        engine.advanceClock(1000 / 60);
        engine.soundTick();
      }
      record(["string", "Ada"]);
      return "Ada";
    },
    promptNumber() {
      record(["number", 42]);
      return 42;
    },
  });
  engine.tick();
  return {
    state,
    engine,
    start() {
      const image = engine.autosaveImage()!;
      const initial = engine.captureReplayState();
      tape = new OperationRecorder();
      return { image, initial, tape };
    },
    keys(batch: number[]) {
      keys = batch;
    },
    tick() {
      if (tape) tape.run("tick", () => engine.tick());
      else engine.tick();
    },
    clock(n: number) {
      for (let i = 0; i < n; i++) {
        tape?.clock();
        engine.advanceClock(1000 / 60);
        engine.soundTick();
      }
    },
  };
}

function success(result: ReturnType<typeof playtestRoom>) {
  assert.equal(result.success, true, result.error ?? result.message ?? "");
}

test("recorded random draws remain exact after randomness consumed before recording", () => {
  const game = capture("random(1,100,v50);");
  game.tick();
  game.tick();
  const recording = game.start();
  game.tick();
  game.tick();
  success(
    playtestRoom(
      game.state,
      { room: 1, steps: [], expect: { vars: [{ id: 50, value: game.engine.vars[50] }] } },
      {
        setupImage: recording.image,
        replay: { state: recording.initial, operations: recording.tape.operations },
      },
    ),
  );
  const altered = recording.tape.operations.map((op) =>
    op[0] === "tick" ? ["tick", op[1].filter((call) => call[0] !== "random")] : op,
  );
  const bad = playtestRoom(
    game.state,
    { room: 1, steps: [] },
    {
      setupImage: recording.image,
      replay: validateRecordedReplay({ state: recording.initial, operations: altered }),
    },
  );
  assert.equal(bad.success, false);
  assert.match(bad.error ?? "", /diverged/);
});

test("same-cycle inputs and idle trailing cycles replay without inserted ticks", () => {
  const game = capture(
    "if (isset(f5)) {set.key(65,0,30);set.key(66,0,31);} if (controller(30)) {increment(v50);} if (controller(31)) {increment(v51);} increment(v40);",
  );
  const recording = game.start();
  game.keys([65, 66]);
  game.tick();
  for (let i = 0; i < 4; i++) game.tick();
  success(
    playtestRoom(
      game.state,
      {
        room: 1,
        steps: [],
        expect: {
          vars: [
            { id: 40, value: 6 },
            { id: 50, value: 1 },
            { id: 51, value: 1 },
          ],
        },
      },
      {
        setupImage: recording.image,
        replay: { state: recording.initial, operations: recording.tape.operations },
      },
    ),
  );
  assert.equal(recording.tape.operations.length, 5);
});

test("prompt replies do not consume extra cycles and retain clocks spent in blocking prompts", () => {
  const game = capture(
    'increment(v40);if (equaln(v40,2)) {get.string(s1,"Name?",0,0,10);get.num("Number?",v50);}',
  );
  const recording = game.start();
  game.tick();
  success(
    playtestRoom(
      game.state,
      {
        room: 1,
        steps: [],
        expect: {
          vars: [
            { id: 40, value: 2 },
            { id: 50, value: 42 },
            { id: 11, value: 1 },
          ],
        },
      },
      {
        setupImage: recording.image,
        replay: { state: recording.initial, operations: recording.tape.operations },
      },
    ),
  );
});

test("touch acknowledgements resume modal continuation without an ordinary logic cycle", () => {
  const game = capture(
    'increment(v40);if (equaln(v40,2)) {print("Touch to continue");increment(v41);}',
  );
  const recording = game.start();
  game.tick();
  assert.equal(game.engine.modalKind, "print");
  game.clock(70);
  game.tick();
  recording.tape.record(["ack"]);
  game.engine.ackPrint();
  game.tick();
  success(
    playtestRoom(
      game.state,
      {
        room: 1,
        steps: [],
        expect: {
          vars: [
            { id: 40, value: 2 },
            { id: 41, value: 1 },
            { id: 11, value: 1 },
          ],
          printed: "Touch to continue",
        },
      },
      {
        setupImage: recording.image,
        replay: { state: recording.initial, operations: recording.tape.operations },
      },
    ),
  );
});

test("recording restores an already-playing sound at its channel position", () => {
  const game = capture("if (isset(f5)) {set(f9);load.sound(1);sound(1,f30);}");
  game.clock(6);
  assert.equal(game.engine.flags[30], 0);
  const recording = game.start();
  game.clock(5);
  assert.equal(game.engine.flags[30], 1);
  success(
    playtestRoom(
      game.state,
      { room: 1, steps: [], expect: { flags: [{ id: 30, value: true }] } },
      {
        setupImage: recording.image,
        replay: { state: recording.initial, operations: recording.tape.operations },
      },
    ),
  );
  const missingSound = { ...recording.initial, sound: null };
  const bad = playtestRoom(
    game.state,
    { room: 1, steps: [], expect: { flags: [{ id: 30, value: true }] } },
    {
      setupImage: recording.image,
      replay: { state: missingSound, operations: recording.tape.operations },
    },
  );
  assert.equal(bad.success, false);
});

test("long recordings derive their budget from actual engine tick calls", () => {
  const game = capture("increment(v40);");
  const recording = game.start();
  for (let i = 0; i < 701; i++) game.tick();
  const snapshotState = {
    room: 1,
    vars: [...game.engine.vars],
    flags: [...game.engine.flags],
    inventory: [],
  };
  const stored = buildRecordedTest(
    "long idle",
    {
      start: {
        image: Buffer.from(recording.image).toString("base64"),
        cycle: 1,
        state: snapshotState,
        replayState: recording.initial,
      },
      events: [],
      operations: recording.tape.operations,
      printed: [],
      endState: snapshotState,
      endCycle: 702,
      tainted: null,
    },
    [],
  );
  assert.equal(stored["cycleBudget"], 701);
  success(
    playtestRoom(game.state, stored, {
      setupImage: recording.image,
      replay: { state: recording.initial, operations: recording.tape.operations },
    }),
  );
});

test("recorded replay rejects unused host calls, unknown operations and oversized clocks", () => {
  const game = capture("");
  const recording = game.start();
  game.tick();
  const extra = recording.tape.operations.map((op) =>
    op[0] === "tick" ? ["tick", [...op[1], ["random", 42]]] : op,
  );
  const result = playtestRoom(
    game.state,
    { room: 1, steps: [] },
    {
      setupImage: recording.image,
      replay: validateRecordedReplay({ state: recording.initial, operations: extra }),
    },
  );
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /unconsumed/);
  assert.throws(
    () => validateRecordedReplay({ state: recording.initial, operations: [["teleport", 5]] }),
    /Unknown/,
  );
  assert.throws(
    () =>
      validateRecordedReplay({
        state: recording.initial,
        operations: Array.from({ length: 7 }, () => ["clock", 60000]),
      }),
    /execution limits/,
  );
});

test("recording preserves an object beyond authentic save.game allocation", () => {
  const game = capture("");
  const object = game.engine.screenObjects[100]!;
  object.x = 73;
  object.y = 115;
  object.direction = 3;
  object.stepCount = 4;
  const image = game.engine.recordingImage()!;
  const initial = game.engine.captureReplayState();
  const restored = new Engine(openContainer(game.state.getFiles()), {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine() {
      return null;
    },
    takeKeys() {
      return [];
    },
  });
  restored.restoreImage(image);
  restored.restoreReplayState(initial);
  assert.equal(restored.screenObjects[100]!.x, 73);
  assert.equal(restored.screenObjects[100]!.stepCount, 4);
});

import { executeAgentTool } from "../src/agent/tools.ts";
import { parseGameTests, serializeGameTests } from "../src/agent/gameTests.ts";
import { decodeSave } from "../src/runtime/persistence.ts";

test("recording payload roundtrips through tool validation, TESTS.JSON and execution", () => {
  const game = capture("increment(v40);");
  const recording = game.start();
  game.tick();
  const data = {
    room: 1,
    vars: [...game.engine.vars],
    flags: [...game.engine.flags],
    inventory: [],
  };
  const stored = buildRecordedTest(
    "roundtrip",
    {
      start: {
        image: Buffer.from(game.engine.recordingImage()!).toString("base64"),
        cycle: 1,
        state: data,
        replayState: game.engine.captureReplayState(),
      },
      events: [],
      operations: [],
      printed: [],
      endState: data,
      endCycle: 1,
      tainted: null,
    },
    [],
  );
  const written = executeAgentTool(game.state, "write_game_tests", {
    mode: "merge",
    names: null,
    tests: [stored],
  });
  success(written);
  const parsed = parseGameTests(game.state.testsPayload!, game.state.profile);
  assert.equal(typeof parsed.tests[0]!.setup!.replay, "string");
  assert.deepEqual(parseGameTests(serializeGameTests(parsed.tests), game.state.profile), parsed);
  success(executeAgentTool(game.state, "run_game_tests", { names: null }));
  assert.equal(
    decodeSave(game.engine.serialize(), game.engine.profile).objects.length,
    21,
    "recording must not change authentic save allocation",
  );
  assert.equal(recording.tape.error, null);
});

test("authored answer queues a prompt reply without spending a logic cycle", () => {
  const game = capture('increment(v40);if (equaln(v40,2)) {get.num("Number?",v50);}');
  const result = playtestRoom(
    game.state,
    {
      room: 1,
      steps: [{ action: "answer", answer: "42" }, { action: "wait" }],
      expect: {
        vars: [
          { id: 40, value: 2 },
          { id: 50, value: 42 },
        ],
      },
    },
    { setupImage: game.engine.recordingImage()! },
  );
  success(result);
  const invalid = playtestRoom(game.state, {
    room: 1,
    steps: [{ action: "answer", answer: "42", ticks: 2 }],
  });
  assert.equal(invalid.success, false);
  assert.match(invalid.error ?? "", /without advancing/);
});

test("tracked-key release retains keys consumed outside an engine tick", () => {
  const game = capture("if (isset(f5)) {set.key(65,0,30);} if (controller(30)) {increment(v50);}");
  const recording = game.start();
  game.keys([65]);
  recording.tape.run("release", () => game.engine.releaseTrackedKey(true));
  game.tick();
  assert.equal(game.engine.vars[50], 1);
  success(
    playtestRoom(
      game.state,
      { room: 1, steps: [], expect: { vars: [{ id: 50, value: 1 }] } },
      {
        setupImage: recording.image,
        replay: { state: recording.initial, operations: recording.tape.operations },
      },
    ),
  );
});

test("recorded setup preserves game captions painted over the status and input rows", () => {
  const game = capture(
    'if (isset(f5)) {status.line.on();display(0,0,"Special game caption");display(22,0,"Input row caption");}',
  );
  const recording = game.start();
  assert.match(game.engine.textRow(0), /Special game caption/);
  for (const text of ["Special game caption", "Input row caption"])
    success(
      playtestRoom(
        game.state,
        { room: 1, steps: [], expect: { text } },
        { setupImage: recording.image, replay: { state: recording.initial, operations: [] } },
      ),
    );
});

import { buildView } from "../src/view/view.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { Simulation } from "../src/agent/playtest.ts";
import type { RecordedOperation } from "../src/agent/recordedReplay.ts";
import {
  HISTORY_FORMAT_VERSION,
  validateHistoryRecording,
  stampBoot,
} from "../src/agent/history.ts";
import { requireProjectId, requireResourceRevision } from "../src/gameIdentity.ts";

/** 1 loop, 1 cel: a solid width x height block of color 5 (test/click-move's fixture). */
function solidView(width: number, height: number): Uint8Array {
  const rows = Array.from({ length: height }, () => [0x50 | width, 0]).flat();
  return new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, width, height, 0, ...rows]);
}

test("the tape validator accepts a bounded click batch and rejects bad points", () => {
  const { engine } = world();
  const replayState = engine.captureReplayState();
  const withCalls = (calls: unknown[]) => ({
    state: replayState,
    operations: [["tick", calls]],
  });
  const good = validateRecordedReplay(
    withCalls([
      ["keys", []],
      ["clicks", [[161, 108]]],
      ["line", null],
    ]),
  );
  assert.deepEqual(good.operations[0], [
    "tick",
    [
      ["keys", []],
      ["clicks", [[161, 108]]],
      ["line", null],
    ],
  ]);
  for (const calls of [
    [["clicks", [[320, 0]]]],
    [["clicks", [[0, 200]]]],
    [["clicks", [[-1, 0]]]],
    [["clicks", [[1.5, 10]]]],
    [["clicks", [[0, 0, 0]]]],
    [["clicks", "161,108"]],
    [["clicks", Array.from({ length: 257 }, () => [0, 0])]],
  ])
    assert.throws(() => validateRecordedReplay(withCalls(calls)), /click|range|tuple/i);
});

test("a recorded click batch replays through the tape host into click-move", () => {
  // Same ego setup as test/click-move.test.ts boot(), under the GR hunk's
  // detected profile: a click at (161,108) walks ego to x 78, y 100.
  const container = openContainer(
    new Map([["GR", Uint8Array.of(0, 0, 3, 0xf3)]]), // hunk magic → amiga-2.316
  );
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         load.pic(v250); draw.pic(v250); show.pic();
         animate.obj(o0); load.view(0); set.view(o0, 0); position(o0, 20, 100);
         assignn(v251, 1); step.size(o0, v251); step.time(o0, v251); draw(o0);
       }
       return;`,
      { dictionary: new Map(), profile: PROFILES["amiga-2.316"] },
    ).payload,
  );
  container.putResource("picture", 0, Uint8Array.of(0xff));
  container.putResource("view", 0, solidView(4, 10));
  const state = createAgentSessionState(container);
  assert.equal(state.profile.id, "amiga-2.316");

  const sim = new Simulation(state);
  sim.tick();
  assert.equal(sim.engine.screenObjects[0]!.x, 20);
  const image = sim.engine.recordingImage()!;
  const initial = sim.engine.captureReplayState();
  const operations: RecordedOperation[] = [
    [
      "tick",
      [
        ["keys", []],
        ["clicks", [[161, 108]]],
        ["line", null],
      ],
    ],
    ...Array.from({ length: 80 }, (): RecordedOperation => [
      "tick",
      [
        ["keys", []],
        ["line", null],
      ],
    ]),
  ];
  success(
    playtestRoom(
      state,
      { room: 1, steps: [], expect: { object: { num: 0, x0: 78, x1: 78 } } },
      { setupImage: image, replay: { state: initial, operations } },
    ),
  );
});

test("the history parser round-trips a click cause and rejects bad coordinates", () => {
  const recording = (cause: unknown) => ({
    version: HISTORY_FORMAT_VERSION,
    identity: {
      project: requireProjectId("click-history"),
      revision: requireResourceRevision("0".repeat(64)),
    },
    profile: "amiga-2.316",
    resourceSet: "rev-1",
    startedAt: 0,
    segments: [
      {
        id: "s.1",
        boot: stampBoot({
          files: { "VOL.0": "eA==" },
          dictionary: [],
          authorRooms: false,
          rng: 1,
          soundDevice: 1,
          resourceSet: "rev-1",
          requestSerial: 0,
        }),
        anchors: [],
        events: [{ seq: 0, tick: 0, cycle: 0, cause }],
        marks: [],
        sync: [],
      },
    ],
  });
  assert.deepEqual(
    validateHistoryRecording(recording({ kind: "click", x: 161, y: 108 })).segments[0]!.events[0]!
      .cause,
    { kind: "click", x: 161, y: 108 },
  );
  for (const cause of [
    { kind: "click", x: 320, y: 108 },
    { kind: "click", x: 161, y: 200 },
    { kind: "click", x: -1, y: 108 },
    { kind: "click", x: 161, y: 108.5 },
    { kind: "click", x: "161", y: 108 },
  ])
    assert.throws(() => validateHistoryRecording(recording(cause)), /click/);
});

test("recording preserves the historical ego visibility flag with custom priority bands", () => {
  const game = capture(
    "if (isset(f5)) {set.pri.base(68);load.view(0);animate.obj(o0);set.view(o0,0);position(o0,80,60);draw(o0);} if (isset(f1)) {increment(v50);}",
    (state) => {
      state.container.putResource("picture", 1, Uint8Array.of(0xf2, 5, 0xf8, 0, 0, 0xff));
      state.container.putResource(
        "view",
        0,
        buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
      );
    },
  );
  assert.equal(game.engine.flags[1], 1);
  const recording = game.start();
  game.tick();
  const args = { room: 1, steps: [], expect: { vars: [{ id: 50, value: 2 }] } };
  success(
    playtestRoom(game.state, args, {
      setupImage: recording.image,
      replay: { state: recording.initial, operations: recording.tape.operations },
    }),
  );
  assert.equal(
    playtestRoom(game.state, args, {
      setupImage: recording.image,
      replay: {
        state: { ...recording.initial, egoHidden: 0 },
        operations: recording.tape.operations,
      },
    }).success,
    false,
  );
});
