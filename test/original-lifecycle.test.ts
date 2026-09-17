import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES } from "../src/runtime/profile.ts";

function lifecycleGame(profile: "2.936" | "3.002.149", host: Partial<EngineHost> = {}): Engine {
  const container = createContainer();
  const dictionary = new Map<string, number>();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (isset(f6)) { increment(v73); return; }
       if (isset(f12)) { increment(v72); }
       if (equaln(v75, 1)) { restore.game(); increment(v76); }
       if (equaln(v75, 2)) { set(f16); restart.game(); increment(v76); }
       assignn(v50, 1); load.pic(v50); draw.pic(v50); show.pic();
       load.view(3);
       animate.obj(o1); set.view(o1, 3); position(o1, 73, 91); draw(o1);
       follow.ego(o1, 7, f61);
       animate.obj(o2); set.view(o2, 3); position(o2, 30, 91);
       follow.ego(o2, 7, f62);
       animate.obj(o3); set.view(o3, 3); position(o3, 10, 91); draw(o3);
       wander(o3);
       return;`,
      { dictionary },
    ).payload,
  );
  container.putResource("picture", 1, new Uint8Array([0xff]));
  container.putResource(
    "logic",
    2,
    assembleLogic("increment(v70); set.scan.start(); increment(v71); return;", { dictionary })
      .payload,
  );
  container.putResource(
    "logic",
    3,
    assembleLogic("load.logics(2); return;", { dictionary }).payload,
  );
  // Independently authored one-loop, one-cel view with a three-pixel baseline.
  container.putResource(
    "view",
    3,
    new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 3, 1, 0, 0x53, 0]),
  );
  const engine = new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
      ...host,
    },
    dictionary,
    { profile: PROFILES[profile] },
  );
  engine.execute(0); // No movement pass: controlled saved retry state.
  for (const index of [1, 2, 3]) engine.screenObjects[index]!.paramBank = [7, 61, 19, 23];
  return engine;
}

for (const profile of ["2.936", "3.002.149"] as const) {
  for (const action of ["restore", "restart"] as const) {
    test(`${profile} ${action} resumes logic in the same cycle without another input poll`, () => {
      let reads = 0;
      let image: Uint8Array | null = null;
      const engine = lifecycleGame(profile, {
        takeInputLine() {
          reads++;
          return null;
        },
        restoreGame: () => image,
      });
      image = engine.serialize();
      engine.vars[75] = action === "restore" ? 1 : 2;
      engine.tick();
      assert.equal(reads, 1, "the zero continuation result does not restart the input phase");
      assert.equal(engine.vars[action === "restore" ? 72 : 73], 1, "logic 0 resumed immediately");
      assert.equal(engine.vars[76], 0, "the abandoned opcode continuation did not execute");
      assert.equal(
        engine.flags[action === "restore" ? 12 : 6],
        0,
        "the same cycle clears the flag",
      );
      assert.equal(engine.vars[24], 41);
    });
  }

  test(`${profile} startup enables sound and initializes the script input-length variable`, () => {
    const engine = lifecycleGame(profile);
    assert.equal(engine.flags[9], 1);
    assert.equal(engine.vars[24], 41);
    engine.setSoundEnabled(false);
    assert.equal(engine.flags[9], 0, "the host can still apply the player's preference");
  });

  test(`${profile} authentic restore ignores resume records for logics absent from resource replay`, () => {
    const engine = lifecycleGame(profile);
    engine.execute(2);
    engine.restoreImage(engine.serialize());
    engine.execute(2);
    assert.equal(engine.vars[70], 2, "the unmatched saved offset did not pre-load this logic");
    assert.equal(engine.vars[71], 2);
  });

  test(`${profile} replayed logic uses its saved offset and host history retains the stronger loaded set`, () => {
    const replayed = lifecycleGame(profile);
    replayed.execute(3);
    replayed.execute(2);
    replayed.restoreImage(replayed.serialize());
    replayed.execute(2);
    assert.equal(replayed.vars[70], 1);
    assert.equal(replayed.vars[71], 2);

    const history = lifecycleGame(profile);
    history.execute(2);
    const image = history.autosaveImage();
    assert.ok(image);
    history.restoreImage(image);
    history.execute(2);
    assert.equal(history.vars[70], 1);
    assert.equal(history.vars[71], 2);
  });

  test(`${profile} authentic reconstruction resets drawn follow retry, preserving other parameter bytes`, () => {
    // Original execution: flags0x41/0x51 and motion2 reset p3 to255;
    // undrawn follow and drawn wander preserve19. See docs/fidelity.md,
    // "Original save and restart audit". No self-roundtrip expectation.
    const engine = lifecycleGame(profile);
    const image = engine.serialize();
    engine.restoreImage(image);
    assert.deepEqual(engine.screenObjects[1]!.paramBank, [7, 61, 255, 23]);
    assert.deepEqual(engine.screenObjects[2]!.paramBank, [7, 61, 19, 23]);
    assert.deepEqual(engine.screenObjects[3]!.paramBank, [7, 61, 19, 23]);
    assert.deepEqual([engine.screenObjects[1]!.x, engine.screenObjects[1]!.y], [73, 91]);
    assert.equal(engine.flags[12], 1, "successful original restore sets f12");
    engine.tick();
    assert.equal(engine.vars[72], 1, "the first resumed script observes f12");
    assert.equal(engine.flags[12], 0, "the resumed cycle tail clears f12");
  });

  test(`${profile} host history preserves the saved follow retry rather than authentic reconstruction`, () => {
    const engine = lifecycleGame(profile);
    const image = engine.autosaveImage();
    assert.ok(image);
    engine.restoreImage(image);
    assert.deepEqual(engine.screenObjects[1]!.paramBank, [7, 61, 19, 23]);
    assert.equal(engine.flags[12], 0, "exact history does not invent a game restore");
  });
}
