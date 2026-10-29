import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";
import { validateEngineReplayState } from "../src/runtime/replayState.ts";

const HOST: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
};

function gateGame(profile: ProfileId) {
  const keys: number[] = [];
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `
    if (!isset(f200)) { set(f200); set(f14); set.menu("Game"); set.menu.item("Look", 1); submit.menu(); set.key(27, 0, 1); }
    if (controller(c1)) { menu.input(); }
    if (isset(f201)) { reset(f201); hold.key(); ${PROFILES[profile].menuInteractionGate ? "allow.menu(0);" : ""} }
    return;
  `,
      { dictionary: new Map(), profile: PROFILES[profile] },
    ).payload,
  );
  const engine = new Engine(container, { ...HOST, takeKeys: () => keys.splice(0) }, new Map(), {
    profile,
  });
  engine.tick();
  return { engine, keys };
}

// Host restores must restore the recorded input gates even where the original
// save layout has no gate words. Authentic restore.game retains its own rules.
for (const profile of ["2.917", "2.936", "3.002.086", "iigs-1.014"] as const) {
  test(`${profile}: host replay restores the recorded menu and release gates`, () => {
    const { engine, keys } = gateGame(profile);
    const image = engine.recordingImage(true)!;
    const before = engine.captureReplayState(true);
    engine.flags[201] = 1;
    engine.tick();
    const held = engine.captureReplayState(true);
    assert.equal(held.releaseGate, 1, "hold.key records the live release gate");
    assert.equal(held.menuGate, PROFILES[profile].menuInteractionGate ? 0 : 1);
    engine.restoreImage(image);
    engine.restoreReplayState(before);
    assert.equal(engine.releaseGate, 0, "the earlier moment uses tap movement again");
    engine.restoreImage(image);
    engine.restoreReplayState(held);
    assert.equal(engine.releaseGate, 1, "the later moment uses hold movement again");
    if (PROFILES[profile].menuInteractionGate) {
      keys.push(27);
      engine.tick();
      engine.tick();
      assert.equal(engine.modalKind, null, "the recorded allow.menu(0) blocks the menu");
      engine.restoreImage(image);
      engine.restoreReplayState(before);
      keys.push(27);
      engine.tick();
      engine.tick();
      assert.equal(engine.modalKind, "menu", "the earlier moment allows the menu again");
    }
  });
}

test("replay gate fields are optional bytes and reject malformed values", () => {
  const state = gateGame("3.002.086").engine.captureReplayState(true);
  assert.deepEqual(validateEngineReplayState({ ...state, menuGate: 255, releaseGate: 255 }), {
    ...state,
    menuGate: 255,
    releaseGate: 255,
  });
  for (const field of ["menuGate", "releaseGate"] as const) {
    for (const bad of [-1, 256, 0.5, null, true, "1"]) {
      assert.throws(() => validateEngineReplayState({ ...state, [field]: bad }), /out of range/);
    }
  }
});

test("Amiga host replay retains gate bytes even though its dispatch cannot set hold.key", () => {
  const engine = new Engine(createContainer(), HOST, new Map(), { profile: "amiga-2.202" });
  const initial = engine.captureReplayState(true);
  engine.restoreReplayState({ ...initial, releaseGate: 173, menuGate: 1 });
  assert.equal(engine.releaseGate, 173);
  const captured = engine.captureReplayState(true);
  engine.restoreReplayState({ ...initial, releaseGate: 0 });
  engine.restoreReplayState(captured);
  assert.equal(engine.releaseGate, 173, "the host restore carries the recorded byte");
});

test("older replay state without gates keeps the live gates on layouts without gate words", () => {
  const { engine, keys } = gateGame("3.002.086");
  const older = engine.captureReplayState(true);
  delete older.menuGate;
  delete older.releaseGate;
  engine.flags[201] = 1;
  engine.tick();
  engine.restoreReplayState(older);
  assert.equal(engine.releaseGate, 1, "omission keeps the released live release gate");
  keys.push(27);
  engine.tick();
  engine.tick();
  assert.equal(engine.modalKind, null, "omission keeps the released live menu gate");
});
