import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../src/runtime/engine.ts";
import { createContainer, openContainer } from "../src/container/container.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { migrateRecordedReplayState } from "../src/runtime/recordingState.ts";
import { decodeRecordedReplay } from "../src/agent/recordedReplay.ts";
import { createAgentSessionState } from "../src/agent/agentState.ts";
import { Simulation } from "../src/agent/playtest.ts";
import { runGameTests } from "../src/agent/gameTestsRunner.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildSound } from "../src/sound/build.ts";
import type { SoundOutput } from "../src/sound/sound.ts";
import { releasedSound, assertSoundContinuation } from "./released-sound.ts";

const profile = PROFILES["2.001"];

test("silent recordings and room launches keep the released replay form across profiles", () => {
  for (const p of Object.values(PROFILES)) {
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic("return;", { dictionary: new Map(), profile: p }).payload,
    );
    const engine = new Engine(
      container,
      {
        print() {},
        displayAt() {},
        statusLine() {},
        takeKeys: () => [],
        takeInputLine: () => null,
      },
      new Map(),
      { profile: p },
    );
    engine.tick();
    const state = engine.captureReplayState(true);
    assert.equal(Object.hasOwn(state, "version"), false, p.id);
    assert.deepEqual(
      migrateRecordedReplayState(state, p, () => null),
      state,
      p.id,
    );
    assert.equal(Object.hasOwn(engine.captureRoomLaunchState().replay, "version"), false, p.id);
  }
});

test("released playback outside the booter profile keeps every recorded field", () => {
  for (const p of Object.values(PROFILES)) {
    if (p.sound === "booter-2.001") continue;
    const container = createContainer();
    container.putResource(
      "sound",
      0,
      p.sound === "iigs"
        ? Uint8Array.of(0x02, 0x00, 0x00, 0x90, 0x3c, 0x40, 0x08, 0xfc)
        : buildSound([{ notes: [{ note: "A4", duration: 10, attenuation: 0 }] }]),
    );
    container.putResource(
      "logic",
      0,
      assembleLogic("load.sound(0);sound(0,40);return;", {
        dictionary: new Map(),
        profile: p,
      }).payload,
    );
    const engine = new Engine(
      container,
      {
        print() {},
        displayAt() {},
        statusLine() {},
        takeKeys: () => [],
        takeInputLine: () => null,
      },
      new Map(),
      { profile: p },
    );
    engine.tick();
    const state = engine.captureReplayState(true);
    assert.notEqual(state.sound, null, p.id);
    assert.equal(Object.hasOwn(state, "version"), false, p.id);
    const before = structuredClone(state);
    assert.deepEqual(
      migrateRecordedReplayState(state, p, () => {
        assert.fail("unchanged playback needs no resource migration");
      }),
      state,
      p.id,
    );
    engine.restoreReplayState(state);
    assert.deepEqual(engine.captureReplayState(true), state, p.id);
    assert.deepEqual(state, before, p.id);
  }
});

for (const capture of releasedSound.captures) {
  const files = () =>
    new Map(
      Object.entries(capture.history.segments[0]!.boot.files).map(([name, data]) => [
        name,
        new Uint8Array(Buffer.from(data, "base64")),
      ]),
    );
  test(`released ${capture.name} resumes with corrected commands and game completion`, () => {
    const outputs: SoundOutput[] = [];
    const engine = new Engine(
      openContainer(files(), { profile }),
      {
        print() {},
        displayAt() {},
        statusLine() {},
        takeKeys: () => [],
        takeInputLine: () => null,
        soundDevice: () => capture.device,
        soundOutput: (output) => outputs.push(output),
      },
      new Map(),
      { profile },
    );
    engine.restoreImage(
      new Uint8Array(Buffer.from(capture.history.segments[0]!.boot.image!, "base64")),
      { preservePresentation: true },
    );
    const tape = decodeRecordedReplay(JSON.stringify(capture.tape));
    const before = structuredClone(tape.state);
    engine.restoreReplayState(tape.state);
    assert.deepEqual(tape.state, before, "conversion preserves released bytes");
    const current = engine.captureReplayState(true);
    assert.equal(current.version, 2, "new captures identify corrected sound semantics");
    engine.restoreReplayState(current);
    assert.deepEqual(
      engine.captureReplayState(true),
      current,
      "current state does not migrate twice",
    );
    const launch = engine.captureRoomLaunchState().replay;
    assert.equal(launch.sound, null);
    assert.equal(Object.hasOwn(launch, "version"), false, "silent launches keep released form");
    assertSoundContinuation(engine, capture.name, outputs);

    const sim = new Simulation(
      createAgentSessionState(openContainer(files(), { profile }), profile),
    );
    sim.engine.restoreImage(
      new Uint8Array(Buffer.from(capture.history.segments[0]!.boot.image!, "base64")),
      { preservePresentation: true },
    );
    sim.replay(tape);
    sim.tick();
    assert.equal(sim.engine.flags[40], 1, "operation tape reaches completion");
    assert.equal(sim.engine.vars[41], 77, "operation tape resumes game logic");
  });

  test(`released ${capture.name} runs through the stored recorded-test reader`, () => {
    const container = openContainer(files(), { profile });
    // The captured logic runs in room 1 without calling a room resource. Supply
    // an empty room for the stored-test runner's authoring reference check.
    container.putResource(
      "logic",
      1,
      assembleLogic("return;", { dictionary: new Map(), profile }).payload,
    );
    const session = createAgentSessionState(container, profile);
    session.testsPayload = new TextEncoder().encode(capture.tests);
    const result = runGameTests(session, null);
    assert.equal(result.success, true, JSON.stringify(result));
  });
}

test("recording readers refuse unknown replay versions without changing released input", () => {
  const input = structuredClone(releasedSound.captures[0]!.tape);
  Object.assign(input.state, { version: 999 });
  const before = structuredClone(input);
  assert.throws(() => decodeRecordedReplay(JSON.stringify(input)), /version.*not supported/i);
  const capture = releasedSound.captures[0]!;
  const engine = new Engine(
    openContainer(
      new Map(
        Object.entries(capture.history.segments[0]!.boot.files).map(([name, data]) => [
          name,
          new Uint8Array(Buffer.from(data, "base64")),
        ]),
      ),
      { profile },
    ),
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeKeys: () => [],
      takeInputLine: () => null,
    },
    new Map(),
    { profile },
  );
  assert.throws(() => engine.restoreReplayState(input.state), /version.*not supported/i);
  const current = structuredClone(capture.tape.state);
  Object.assign(current, { version: 2 });
  // Seven is valid in released rows and outside this resource's corrected rows.
  assert.throws(() => engine.restoreReplayState(current), /outside the current resource/);
  assert.deepEqual(input, before);
});

test("released booter migration rejects impossible active cursors and playback fields", () => {
  const capture = releasedSound.captures.find((c) => c.name === "psg-review")!;
  const engine = new Engine(
    openContainer(
      new Map(
        Object.entries(capture.history.segments[0]!.boot.files).map(([name, data]) => [
          name,
          new Uint8Array(Buffer.from(data, "base64")),
        ]),
      ),
      { profile },
    ),
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeKeys: () => [],
      takeInputLine: () => null,
    },
    new Map(),
    { profile },
  );
  const invalid = [
    { cursor: 10 },
    { cursor: 11 },
    { countdown: 2 },
    { terminated: true },
    { base: 14 },
    { envelopeIndex: 0 },
    { envelopeValue: 1 },
  ];
  for (const fields of invalid) {
    const state = structuredClone(capture.tape.state);
    Object.assign(state.sound!.playback.channels[0]!, fields);
    const before = structuredClone(state);
    assert.throws(
      () => engine.restoreReplayState(state),
      /released booter/i,
      JSON.stringify(fields),
    );
    assert.deepEqual(state, before);
  }
  for (const fields of [
    { active: false },
    { channels: [] },
    { fade: { pace: 1, countdown: 1, budget: 255 } },
  ]) {
    const state = structuredClone(capture.tape.state);
    Object.assign(state.sound!.playback, fields);
    assert.throws(() => engine.restoreReplayState(state), /released booter/i);
  }
});
