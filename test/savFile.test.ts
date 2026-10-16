import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeOriginalSav, encodeOriginalSav } from "../src/runtime/savFile.ts";
import { PROFILES, EQUIVALENT_BUILDS, type ProfileId } from "../src/runtime/profile.ts";

interface Capture {
  build: string;
  hex: string;
  stateBytes: number;
  kind: "pattern" | "game";
}
const captures = JSON.parse(
  readFileSync(new URL("./savFile-captures.json", import.meta.url), "utf8"),
) as Capture[];

// Captured builds can share a promoted profile without sharing capture evidence.
function captureProfile(build: string): AgiProfile {
  const id = EQUIVALENT_BUILDS[build] ?? (build === "2.903" ? "2.917" : build);
  return PROFILES[id as ProfileId];
}

describe("original save writer captures", () => {
  for (const capture of captures.filter((capture) => capture.kind === "pattern")) {
    test(`${capture.build} imports controlled state and exports every original byte`, () => {
      const profile = captureProfile(capture.build);
      const bytes = Uint8Array.from(Buffer.from(capture.hex, "hex"));
      const state = decodeOriginalSav(bytes, profile);
      assert.equal(state.description, "Original probe");
      assert.equal(state.replayCapacity, 3);
      assert.equal(state.replayActive, 2);
      assert.deepEqual(state.replay, [
        { kind: 0, value: 21 },
        { kind: 3, value: 2 },
        { kind: 0, value: 0 },
      ]);
      assert.deepEqual(
        state.inventory,
        Uint8Array.from({ length: 30 }, (_, i) => i),
      );
      assert.equal(state.objects.length, 2);
      assert.equal(state.objects[0]!.motionMode, 1);
      assert.equal(state.objects[0]!.cycleMode, 2);
      // Native 0x70 is animated, cycling and updating, observes all three gates.
      assert.equal(state.objects[0]!.state, 0x76);
      assert.deepEqual(encodeOriginalSav(state, profile), bytes);
    });
  }
});

// Original files contain only interpreter state. These checks exercise the
// public engine boundary and the player-visible state after reconstruction.
import { Engine } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { decodeSave, newSaveState, newObjectRecord } from "../src/runtime/persistence.ts";
import { importOriginalSav, exportOriginalSav } from "../src/runtime/savFile.ts";
import type { AgiProfile } from "../src/runtime/profile.ts";

function game(profile: AgiProfile, suffix = "", effects?: string[]): Engine {
  const container = createContainer();
  const dictionary = new Map<string, number>();
  const logic = assembleLogic(
    `
    if (!isset(f200)) {
      set(f200);
      set.game.id("TEST");
      assignn(v50, 1);
      load.pic(v50);
      draw.pic(v50);
      show.pic();
      assignn(v100, 37);
      set(f100);
      set.string(s0, "Hello");
      get(0);
      animate.obj(0);
      load.view(3);
      set.view(0, 3);
      position(0, 40, 80);
      draw(0);
      stop.motion(0);
    }
    ${suffix}
    return;
  `,
    { dictionary, profile },
  );
  assert.deepEqual(logic.diagnostics, []);
  container.putResource("logic", 0, logic.payload);
  container.putResource("picture", 1, new Uint8Array([0xf0, 1, 0xff]));
  container.putResource(
    "view",
    3,
    new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 3, 1, 0, 0x53, 0]),
  );
  const stride = profile.inventoryEntryBytes;
  const metadata = new Uint8Array(profile.inventoryHeaderBytes + stride + 4);
  metadata.set([stride, 0, 1]);
  metadata.set([stride, 0, 0], profile.inventoryHeaderBytes);
  metadata.set([107, 101, 121, 0], profile.inventoryHeaderBytes + stride);
  container.putFile("OBJECT", metadata);
  return new Engine(
    container,
    {
      print() {
        effects?.push("print");
      },
      displayAt() {
        effects?.push("display");
      },
      statusLine() {
        effects?.push("status");
      },
      takeInputLine() {
        return null;
      },
      takeKeys() {
        return [];
      },
    },
    dictionary,
    { profile },
  );
}

for (const profile of Object.values(PROFILES).filter((p) => p.id !== "2.001")) {
  test(`${profile.id} imports position, inventory, strings, flags and variables`, () => {
    const engine = game(profile);
    engine.tick();
    const bytes = exportOriginalSav(engine, "A room");
    const original = decodeOriginalSav(bytes, profile);
    assert.equal(original.description, "A room");
    // Independently inspect the original object word after animate + draw:
    // drawn, updating, cycling, animated. stop.motion does not alter these.
    let at = 31;
    const be = profile.id === "iigs-1.014";
    const count = be ? 2 : 1;
    for (let i = 0; i < count; i++) at += 2 + (bytes[at]! | (bytes[at + 1]! << 8));
    const flagAt = at + 2 + (profile.id.startsWith("amiga-") || be ? 0x3e : 0x25);
    assert.deepEqual(
      [...bytes.subarray(flagAt, flagAt + 2)],
      profile.id.startsWith("amiga-") ? [0x40, 0x71] : [0x71, 0x40],
    );
    engine.vars[100] = 99;
    engine.flags[100] = 0;
    engine.setItemLocation(0, 2);
    importOriginalSav(engine, bytes);
    const report = engine.readState();
    assert.equal(report.vars[100], 37);
    assert.equal(report.flags[100], 1);
    assert.equal(report.flags[12], 1);
    assert.equal(report.strings[0], "Hello");
    assert.equal(engine.itemLocation(0), 255);
    assert.equal(engine.readObjects()[0]!.x, 40);
    assert.equal(engine.readObjects()[0]!.y, 80);
    assert.equal(decodeSave(engine.serialize(), profile).replayActive, original.replayActive);
  });
}

test("failed imports preserve game state and caller bytes", () => {
  const engine = game(PROFILES["2.936"]);
  engine.tick();
  const bytes = exportOriginalSav(engine);
  const before = engine.serialize();
  const bad = decodeOriginalSav(bytes, engine.profile);
  bad.signature[0] = 88;
  const foreign = encodeOriginalSav(bad, engine.profile);
  assert.throws(() => importOriginalSav(engine, foreign), /signature/);
  bad.signature[0] = 84;
  bad.inventory = new Uint8Array(0);
  const missing = encodeOriginalSav(bad, engine.profile);
  assert.throws(() => importOriginalSav(engine, missing), /inventory/);
  assert.throws(
    () => importOriginalSav(engine, bytes.subarray(0, bytes.length - 1)),
    /inside block/,
  );
  assert.deepEqual(engine.serialize(), before);
  assert.deepEqual(bytes, exportOriginalSav(engine));
});

test("original file boundaries reject extra bytes and missing resume terminators", () => {
  const engine = game(PROFILES["2.936"]);
  engine.tick();
  const bytes = exportOriginalSav(engine);
  assert.throws(
    () => decodeOriginalSav(new Uint8Array([...bytes, 0]), engine.profile),
    /trailing bytes/,
  );
  const bad = bytes.slice();
  bad[bad.length - 4] = 0;
  assert.throws(() => decodeOriginalSav(bad, engine.profile), /terminator/);
  assert.throws(() => decodeOriginalSav(bytes, PROFILES["2.001"]), /disk sectors/);
});

test("PC export rejects ego click motion with a clear error", () => {
  const profile = PROFILES["2.936"];
  const state = newSaveState(profile);
  const ego = newObjectRecord();
  ego.motionMode = 4;
  state.objects = [ego];
  assert.throws(() => encodeOriginalSav(state, profile), {
    name: "RangeError",
    message: "Click motion cannot be represented in an original PC save",
  });
});

test("export waits for a complete room and for an open interaction to finish", () => {
  const engine = game(PROFILES["2.936"], 'print("Wait");');
  assert.throws(() => exportOriginalSav(engine), /complete room/);
  engine.tick();
  assert.equal(engine.modalOpen, true);
  assert.throws(() => exportOriginalSav(engine), /interaction/);
});

for (const capture of captures.filter((capture) => capture.kind === "game")) {
  const profile = captureProfile(capture.build);
  test(`${capture.build} exports fresh state equal to the original writer and imports its file`, () => {
    // This state is independently specified, without decoding the expected file,
    // reserved images, raw objects or the preservation map. The original binary
    // saved hand-initialized memory containing these same values.
    const state = newSaveState(profile);
    state.description = "Original probe";
    state.signature.set([84, 69, 83, 84]);
    state.vars[100] = 37;
    state.flags[100] = 1;
    state.flags[200] = 1;
    state.strings[0] = "Hello";
    state.lastPicture = 1;
    state.replayCapacity = 4;
    state.replayActive = 3;
    state.replay = [
      { kind: 2, value: 1 },
      { kind: 4, value: 1 },
      { kind: 1, value: 3 },
      { kind: 0, value: 0 },
    ];
    const ego = newObjectRecord();
    Object.assign(ego, {
      stepTime: 1,
      stepCount: 1,
      x: 40,
      y: 80,
      view: 3,
      loopCount: 1,
      celCount: 1,
      prevX: 40,
      prevY: 80,
      width: 3,
      height: 1,
      stepSize: 1,
      cycleTime: 1,
      cycleCount: 1,
      state: 0x77,
    });
    const other = newObjectRecord();
    other.event = 1;
    other.state = 0x70;
    state.objects = [ego, other];
    const stride = profile.inventoryEntryBytes;
    state.inventory = Uint8Array.from([
      stride,
      0,
      255,
      ...(stride === 4 ? [0] : []),
      107,
      101,
      121,
      0,
    ]);
    const original = Uint8Array.from(Buffer.from(capture.hex, "hex"));
    assert.deepEqual(encodeOriginalSav(state, profile), original);
    const engine = game(profile);
    engine.tick();
    engine.vars[100] = 99;
    engine.flags[100] = 0;
    engine.setItemLocation(0, 2);
    importOriginalSav(engine, original);
    const restored = engine.readState();
    const expectedVars = [...state.vars];
    const expectedFlags = [...state.flags];
    expectedFlags[12] = 1;
    if (profile.restoreRewritesMachineState) {
      expectedVars[20] = 0;
      expectedVars[22] = 3;
      expectedVars[26] = 3;
      expectedFlags[11] = 1;
    }
    assert.deepEqual(restored.vars, expectedVars);
    assert.deepEqual(restored.flags, expectedFlags);
    assert.deepEqual(restored.strings.slice(0, state.strings.length), state.strings);
    assert.equal(restored.vars[100], 37);
    assert.equal(restored.flags[100], 1);
    assert.equal(restored.flags[200], 1);
    assert.equal(restored.flags[12], 1);
    assert.equal(restored.strings[0], "Hello");
    assert.equal(engine.itemLocation(0), 255);
    assert.deepEqual(
      engine.readObjects().map((o) => ({
        num: o.num,
        x: o.x,
        y: o.y,
        view: o.view,
        motion: o.motionMode,
        cycling: o.cycling,
      })),
      [{ num: 0, x: 40, y: 80, view: 3, motion: 0, cycling: true }],
    );
  });
}

test("a broken resource replay is rejected before live state or host output changes", () => {
  const effects: string[] = [];
  const engine = game(PROFILES["2.936"], "", effects);
  engine.tick();
  const before = engine.serialize();
  const report = engine.readState();
  const beforeEffects = [...effects];
  for (const pair of [
    { kind: 255, value: 0 },
    { kind: 1, value: 254 },
    { kind: 5, value: 0 },
  ]) {
    const state = decodeOriginalSav(exportOriginalSav(engine), engine.profile);
    state.replayActive = 1;
    state.replay = [pair];
    const bytes = encodeOriginalSav(state, engine.profile);
    assert.throws(
      () => importOriginalSav(engine, bytes),
      /unknown replay|not in container|truncated/,
    );
    assert.deepEqual(engine.serialize(), before);
    assert.deepEqual(engine.readState(), report);
    assert.deepEqual(effects, beforeEffects);
  }
});
