import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
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

test("ResetAll startup and accepted restart tuples match every profile's binary across all 18 promoted profiles", () => {
  // Hand-computed [v8, v20, v22, v24, v26, f5, f11] per profile for soundDevice=1 and soundDevice=0:
  // - v8 (freePages): 255 across all profiles
  // - v20 (machType): 0 on PC (2.001..3.002.149), 5 on Amiga (amiga-2.082..amiga-2.333), 7 on IIgs (iigs-1.014)
  // - v22/f11 (soundType/NOISE):
  //   - 2.001: [0, 0] unconditionally
  //   - 2.230, 2.272, 2.411, amiga-2.082..amiga-2.333, iigs-1.014: [3, 1] unconditionally
  //   - 2.089, 2.440..3.002.149: [3, 1] when soundDevice!=0, [1, 0] when soundDevice==0
  // - v24 (maxInput): 0 on 2.001..2.230, 40 on iigs-1.014, 41 on 2.272..3.002.149 and amiga-2.082..amiga-2.333
  // - v26 (monType): 0 on 2.001..2.272, amiga-2.082 and iigs-1.014; 3 on 2.411..3.002.149 and amiga-2.176..amiga-2.333
  // - f5 (NEW_ROOM): 1 at startup and immediately after ResetAll on accepted restart
  const EXPECTED_SD1: Record<
    keyof typeof PROFILES,
    readonly [number, number, number, number, number, number, number]
  > = {
    "2.001": [255, 0, 0, 0, 0, 1, 0],
    "2.089": [255, 0, 3, 0, 0, 1, 1],
    "2.230": [255, 0, 3, 0, 0, 1, 1],
    "2.272": [255, 0, 3, 41, 0, 1, 1],
    "2.411": [255, 0, 3, 41, 3, 1, 1],
    "2.440": [255, 0, 3, 41, 3, 1, 1],
    "2.917": [255, 0, 3, 41, 3, 1, 1],
    "2.936": [255, 0, 3, 41, 3, 1, 1],
    "3.002.086": [255, 0, 3, 41, 3, 1, 1],
    "3.002.102": [255, 0, 3, 41, 3, 1, 1],
    "3.002.149": [255, 0, 3, 41, 3, 1, 1],
    "amiga-2.082": [255, 5, 3, 41, 0, 1, 1],
    "amiga-2.176": [255, 5, 3, 41, 3, 1, 1],
    "amiga-2.202": [255, 5, 3, 41, 3, 1, 1],
    "amiga-2.310": [255, 5, 3, 41, 3, 1, 1],
    "amiga-2.316": [255, 5, 3, 41, 3, 1, 1],
    "amiga-2.333": [255, 5, 3, 41, 3, 1, 1],
    "iigs-1.014": [255, 7, 3, 40, 0, 1, 1],
  };

  for (const [id, wantSd1] of Object.entries(EXPECTED_SD1) as [
    keyof typeof PROFILES,
    readonly [number, number, number, number, number, number, number],
  ][]) {
    const profile = PROFILES[id];
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `if (isset(f6)) {
           assignv(v100, v8);
           assignv(v101, v20);
           assignv(v102, v22);
           assignv(v103, v24);
           assignv(v104, v26);
           if (isset(f5)) { assignn(v105, 1); }
           if (isset(f11)) { assignn(v106, 1); }
           if (isset(f9)) { assignn(v107, 1); }
           return;
         }
         if (equaln(v75, 1)) {
           assignn(v8, 99);
           assignn(v20, 99);
           assignn(v22, 99);
           assignn(v24, 99);
           assignn(v26, 99);
           reset(f5);
           reset(f11);
           reset(f9);
           set(f16);
           restart.game();
         }
         return;`,
        { dictionary: new Map(), profile },
      ).payload,
    );

    const makeEngine = (soundDevice: 0 | 1) =>
      new Engine(
        container,
        {
          print() {},
          displayAt() {},
          statusLine() {},
          takeInputLine: () => null,
          takeKeys: () => [13],
          soundDevice: () => soundDevice,
        },
        new Map(),
        { profile: id },
      );

    // 1. Construction (startup) with soundDevice = 1
    const e1 = makeEngine(1);
    assert.deepEqual(
      [e1.vars[8], e1.vars[20], e1.vars[22], e1.vars[24], e1.vars[26], e1.flags[5], e1.flags[11]],
      [...wantSd1],
      `${id} startup tuple (soundDevice=1)`,
    );
    assert.equal(e1.flags[9], 1, `${id} startup f9=1`);
    assert.equal(e1.flags[6], 0, `${id} startup f6=0`);

    // 2. Accepted restart.game with soundDevice = 1 (and f9 cleared before restart to verify f9 preservation)
    e1.vars[75] = 1;
    e1.tick();
    assert.deepEqual(
      [
        e1.vars[100],
        e1.vars[101],
        e1.vars[102],
        e1.vars[103],
        e1.vars[104],
        e1.vars[105],
        e1.vars[106],
      ],
      [...wantSd1],
      `${id} accepted restart tuple (soundDevice=1)`,
    );
    assert.equal(e1.vars[107], 0, `${id} accepted restart preserves f9`);

    // 3. Construction and accepted restart with soundDevice = 0
    const usesHostSound =
      id === "2.089" ||
      id === "2.440" ||
      id === "2.917" ||
      id === "2.936" ||
      id.startsWith("3.002.");
    const wantSd0 = usesHostSound
      ? ([wantSd1[0], wantSd1[1], 1, wantSd1[3], wantSd1[4], wantSd1[5], 0] as const)
      : wantSd1;
    const e0 = makeEngine(0);
    assert.deepEqual(
      [e0.vars[8], e0.vars[20], e0.vars[22], e0.vars[24], e0.vars[26], e0.flags[5], e0.flags[11]],
      [...wantSd0],
      `${id} startup tuple (soundDevice=0)`,
    );
    e0.vars[75] = 1;
    e0.tick();
    assert.deepEqual(
      [
        e0.vars[100],
        e0.vars[101],
        e0.vars[102],
        e0.vars[103],
        e0.vars[104],
        e0.vars[105],
        e0.vars[106],
      ],
      [...wantSd0],
      `${id} accepted restart tuple (soundDevice=0)`,
    );
  }
});

test("F-persistence-05: Amiga restart.game and quit(0) display their verified prompts and gadget choices and honor accept/cancel", () => {
  for (const id of [
    "amiga-2.082",
    "amiga-2.176",
    "amiga-2.202",
    "amiga-2.310",
    "amiga-2.316",
    "amiga-2.333",
  ] as const) {
    const profile = PROFILES[id];
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `if (isset(f6)) { assignn(v90, 1); return; }
         if (equaln(v80, 1)) { restart.game(); assignn(v81, 1); return; }
         if (equaln(v80, 2)) { quit(0); assignn(v82, 1); return; }
         return;`,
        { dictionary: new Map(), profile },
      ).payload,
    );

    const makeAmiga = () => {
      const engine = new Engine(
        container,
        {
          print() {},
          displayAt() {},
          statusLine() {},
          takeInputLine: () => null,
          takeKeys: () => [],
          waitKey() {
            throw new HostWait();
          },
        },
        new Map(),
        { profile: id },
      );
      return {
        engine,
        surfaceText: () => Array.from({ length: 25 }, (_, r) => engine.textRow(r)).join("\n"),
      };
    };

    // 1. restart.game — cancel (Escape = 27)
    const rCancel = makeAmiga();
    rCancel.engine.vars[80] = 1;
    rCancel.engine.tick();
    assert.equal(rCancel.engine.modalKind, "print", `${id} restart opens confirmation window`);
    const restartScreen = rCancel.surfaceText();
    assert.match(restartScreen, /Restart the game\?/, `${id} restart prompt text`);
    assert.match(restartScreen, /Restart +Cancel/, `${id} restart gadget choices`);
    rCancel.engine.deliverHostAnswer(27);
    rCancel.engine.tick();
    assert.equal(rCancel.engine.vars[90], 0, `${id} cancelled restart does not restart`);
    assert.equal(rCancel.engine.vars[81], 1, `${id} cancelled restart continues after opcode`);

    // 2. restart.game — accept (Enter = 13)
    const rAccept = makeAmiga();
    rAccept.engine.vars[80] = 1;
    rAccept.engine.tick();
    assert.match(rAccept.surfaceText(), /Restart the game\?/);
    rAccept.engine.deliverHostAnswer(13);
    rAccept.engine.tick();
    assert.equal(rAccept.engine.vars[90], 1, `${id} accepted restart runs Logic 0 with f6=1`);
    assert.equal(rAccept.engine.vars[81], 0, `${id} accepted restart abandons old continuation`);

    // 3. quit(0) — cancel (Escape = 27)
    const qCancel = makeAmiga();
    qCancel.engine.vars[80] = 2;
    qCancel.engine.tick();
    assert.equal(qCancel.engine.modalKind, "print", `${id} quit(0) opens confirmation window`);
    const quitScreen = qCancel.surfaceText();
    assert.match(quitScreen, /Quit the game, or continue\?/, `${id} quit prompt text`);
    assert.match(quitScreen, /Quit +Continue/, `${id} quit gadget choices`);
    qCancel.engine.deliverHostAnswer(27);
    qCancel.engine.tick();
    assert.equal(
      qCancel.engine.readState().terminated,
      false,
      `${id} cancelled quit stays running`,
    );
    assert.equal(qCancel.engine.vars[82], 1, `${id} cancelled quit continues after opcode`);

    // 4. quit(0) — accept (Enter = 13)
    const qAccept = makeAmiga();
    qAccept.engine.vars[80] = 2;
    qAccept.engine.tick();
    assert.match(qAccept.surfaceText(), /Quit the game, or continue\?/);
    qAccept.engine.deliverHostAnswer(13);
    qAccept.engine.tick();
    assert.equal(qAccept.engine.readState().terminated, true, `${id} accepted quit terminates`);
    assert.equal(
      qAccept.engine.vars[82],
      0,
      `${id} accepted quit does not run instructions after quit`,
    );
  }
});
