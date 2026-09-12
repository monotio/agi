import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

const TARGET_HASH = KNOWN_GAME_HASH.KQ3;
const skip = fixtureSkip(TARGET_HASH);

function game(restarted = true, overrides: Partial<EngineHost> = {}) {
  const { container, dict } = loadGame(TARGET_HASH);
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeKeys: () => [],
    takeInputLine: () => null,
    randomWord: () => 66,
    ...overrides,
  };
  const engine = new Engine(container, host, dict, { profile: "2.936", restarted });
  return { engine, container, dict, host };
}

function settle(engine: Engine, cycles: number): void {
  for (let i = 0; i < cycles; i++) {
    engine.soundTick();
    engine.tick();
    if (engine.modalKind === "print") engine.ackPrint();
  }
}

test(
  "KQ3: the study cat keeps its floor constraint after title animation and restore",
  { skip },
  () => {
    const { engine, container, dict, host } = game(false);
    settle(engine, 1);
    // Select a study visit with the cat present. Object 13 was also used by the intro.
    engine.vars[127] = 0;
    engine.flags[116] = 0;
    engine.flags[98] = 0;
    engine.reenterRoom(5);
    settle(engine, 1);
    const cat = engine.screenObjects[13]!;
    assert.equal(cat.active, true);
    assert.equal(cat.fixedPriority, false);
    assert.equal(cat.loopFixed, false);
    const restored = new Engine(container, host, dict, { profile: "2.936" });
    restored.restoreImage(engine.serialize());
    assert.deepEqual(restored.getFrame().visual, engine.getFrame().visual);
    assert.equal(restored.screenObjects[13]!.fixedPriority, false);
    for (let i = 0; i < 1500; i++) {
      settle(restored, 1);
      const actor = restored.screenObjects[13]!;
      assert.equal(actor.active, true);
      assert.equal(
        restored.surface.priority[actor.y * 160 + actor.x + actor.width - 1],
        3,
        "the cat's baseline stays on the floor control region",
      );
    }
  },
);

test(
  "KQ3: kitchen teleport waits for its message, draws ego and survives restore",
  { skip },
  () => {
    const { engine, container, dict, host } = game();
    settle(engine, 30);
    // Kitchen arrival selected by the game's punishment state.
    engine.vars[44] = 21;
    engine.reenterRoom(6);
    for (let i = 0; i < 500 && engine.modalKind !== "print"; i++) {
      engine.soundTick();
      engine.tick();
    }
    assert.equal(engine.modalKind, "print", "arrival reaches its blocking message");
    // The parked arrival is a resume point now: the window and the pass
    // behind it serialize, and a restored engine finishes the arrival after
    // the same acknowledgement.
    const midImage = engine.autosaveImage();
    assert.ok(midImage, "the parked arrival is a resume point");
    const resumed = new Engine(container, host, dict, { profile: "2.936" });
    resumed.restoreImage(midImage);
    assert.equal(resumed.modalKind, "print", "the window comes back with the image");
    resumed.ackPrint();
    settle(resumed, 500);
    assert.equal(resumed.vars[0], 6);
    assert.equal(resumed.screenObjects[0]!.view, 18, "the resumed arrival selects its pose");
    engine.ackPrint();
    settle(engine, 500);
    assert.equal(engine.vars[0], 6);
    assert.equal(engine.screenObjects[0]!.active, true);
    assert.equal(engine.modalKind, null, "the arrival message is acknowledged");
    assert.equal(engine.screenObjects[0]!.view, 18, "the game selects its hanging pose");
    const image = engine.autosaveImage();
    assert.ok(image, "the completed arrival can be saved");
    const restored = new Engine(container, host, dict, { profile: "2.936" });
    restored.restoreImage(image);
    assert.deepEqual(restored.getFrame().visual, engine.getFrame().visual);
    settle(restored, 1);
    assert.equal(restored.screenObjects[0]!.active, true);
  },
);

test(
  "KQ3: restored exercise punishment plays sound and ends after one game minute",
  { skip },
  () => {
    const sounds: number[] = [];
    let currentSound = -1;
    let completed = false;
    const { engine, container, dict, host } = game(true, {
      soundDevice: () => 1,
      playSound(id) {
        currentSound = id;
        sounds.push(id);
      },
      stopSound() {
        if (currentSound === 36) completed = true;
        currentSound = -1;
      },
    });
    settle(engine, 30);
    // Enter the exercise sequence with 60 seconds left before its expiry flag.
    engine.vars[44] = 23;
    engine.vars[111] = 61;
    engine.vars[112] = 0;
    engine.reenterRoom(7);
    settle(engine, 3000);
    assert.equal(engine.screenObjects[0]!.view, 29);
    assert.equal(engine.vars[10], 0, "this sequence uses the fastest logic speed");
    assert.ok(sounds.includes(36), "the game starts the exercise sound");
    assert.equal(completed, true, "the bounded sound resource completes without crashing");
    const restored = new Engine(container, host, dict, { profile: "2.936" });
    restored.restoreImage(engine.serialize());
    for (let i = 0; i < 3600; i++) {
      restored.advanceClock(1000 / 60);
      settle(restored, 1);
      if (i === 3539) assert.equal(restored.vars[44], 23, "still exercising after 59 seconds");
    }
    assert.equal(restored.vars[44], 0);
    assert.equal(restored.screenObjects[0]!.view, 0);
    assert.equal(restored.screenObjects[0]!.active, true);
  },
);
