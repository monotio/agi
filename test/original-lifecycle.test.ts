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

test("F-persistence-05: Amiga confirmation gadgets are selectable at their label cells; PC and IIgs confirmations have none", () => {
  const AMIGA = [
    "amiga-2.082",
    "amiga-2.176",
    "amiga-2.202",
    "amiga-2.310",
    "amiga-2.316",
    "amiga-2.333",
  ] as const;
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (isset(f6)) { assignn(v90, 1); return; }
       if (!isset(f200)) { set(f200); configure.screen(1, 22, 0); load.pic(v250); overlay.pic(v250); show.pic(); }
       if (equaln(v80, 1)) { restart.game(); assignn(v81, 1); return; }
       if (equaln(v80, 2)) { quit(0); assignn(v82, 1); return; }
       return;`,
      { dictionary: new Map() },
    ).payload,
  );
  container.putResource("picture", 0, Uint8Array.of(0xff));
  const open = (id: string, action: 1 | 2): Engine => {
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
      { profile: id as keyof typeof PROFILES },
    );
    engine.vars[80] = action;
    engine.tick();
    assert.equal(engine.modalKind, "print", `${id} confirmation window is open`);
    assert.equal(engine.awaitingKey, true, `${id} confirmation waits for its answer`);
    return engine;
  };

  // Hand-computed layout (textSurface placePrintWindow, display base row 1).
  // WindowPrint adds three rows to a message with gadget labels, so both
  // windows are 4 rows: textTop = 1 + ((20 - 1 - 4) >> 1) + 1 = 9, the labels
  // sit on text row 12 and the frame's bottom edge is y1 = 8 * 13 + 4 = 108.
  // Gadgets (F-persistence-05): 12 px high with top = y1 - 17 = 91 (rows
  // 91..102), width 8 * len + 8, the first at frame left + 10 and the second
  // ending 10 px before frame right. Restart window (17 columns, textLeft 11):
  // frame x 78..234, Restart x 88..151, Cancel (56 wide) x 168..223. Quit
  // window (27 columns, textLeft 6): frame x 38..274, Quit x 48..87, Continue
  // (72 wide) x 192..263.
  const edges = (engine: Engine, name: string, x0: number, x1: number, answer: number): void => {
    for (const [x, y] of [
      [x0, 91],
      [x1, 91],
      [x0, 102],
      [x1, 102],
      [(x0 + x1) >> 1, 96],
    ])
      assert.equal(engine.confirmGadgetAt(x!, y!), answer, `${name} inside at ${x},${y}`);
    for (const [x, y] of [
      [x0 - 1, 96],
      [x1 + 1, 96],
      [(x0 + x1) >> 1, 90],
      [(x0 + x1) >> 1, 103],
    ])
      assert.equal(engine.confirmGadgetAt(x!, y!), null, `${name} outside at ${x},${y}`);
  };
  for (const id of AMIGA) {
    const restart = open(id, 1);
    assert.equal(restart.textRow(9).indexOf("Restart the game?"), 11, `${id} restart prompt row`);
    assert.equal(restart.textRow(12).indexOf("Restart    Cancel"), 11, `${id} restart gadget line`);
    edges(restart, `${id} Restart`, 88, 151, 13);
    edges(restart, `${id} Cancel`, 168, 223, 27);
    assert.equal(restart.confirmGadgetAt(160, 96), null, `${id} between the gadgets`);

    const quit = open(id, 2);
    assert.equal(
      quit.textRow(9).indexOf("Quit the game, or continue?"),
      6,
      `${id} quit prompt row`,
    );
    assert.equal(
      quit.textRow(12).indexOf("Quit               Continue"),
      6,
      `${id} quit gadget line`,
    );
    edges(quit, `${id} Quit`, 48, 87, 13);
    edges(quit, `${id} Continue`, 192, 263, 27);
    assert.equal(quit.confirmGadgetAt(140, 96), null, `${id} between the gadgets`);

    // The visible fill equals the hit rectangle: the pen shows on every
    // pixel inside (overlay fill, or the label cell's background pen under
    // the glyphs) and white outside.
    for (const [engine, rects] of [
      [restart, { 2: [88, 151], 4: [168, 223] }],
      [quit, { 2: [48, 87], 4: [192, 263] }],
    ] as const) {
      const checks = (e: Engine, label: string): void => {
        const { windowOverlay, text } = e.getPresentation();
        const pen = (x: number, y: number): number => {
          const o = windowOverlay[y * 320 + x]!;
          if (o !== 0) return o - 1;
          return text[((y >> 3) * 40 + (x >> 3)) * 2 + 1]! >> 4;
        };
        for (const [p, [x0, x1]] of Object.entries(rects)) {
          const want = Number(p);
          for (const [x, y] of [
            [x0, 91],
            [x1, 91],
            [x0, 102],
            [x1, 102],
            [(x0 + x1) >> 1, 96],
          ])
            assert.equal(pen(x!, y!), want, `${label} pen ${p} inside at ${x},${y}`);
          for (const [x, y] of [
            [x0 - 1, 96],
            [x1 + 1, 96],
            [(x0 + x1) >> 1, 90],
            [(x0 + x1) >> 1, 103],
            [x0, 103],
            [x1, 103],
          ]) {
            assert.equal(pen(x!, y!), 15, `${label} white outside at ${x},${y}`);
            assert.equal(e.confirmGadgetAt(x!, y!), null, `${label} miss at ${x},${y}`);
          }
        }
      };
      // A parked confirmation is never a checkpoint boundary (autosaveImage
      // refuses a suspended host request), so no restore restamps it; the
      // fills still travel in WindowOverlay.gadgets for any restamp path.
      checks(engine, `${id} live`);
      assert.equal(engine.autosaveImage(), null, `${id} parked confirmation refuses a snapshot`);
    }

    // The gadget answer resolves the wait exactly like its key: Restart
    // restarts, Continue resumes after the opcode.
    restart.deliverHostAnswer(restart.confirmGadgetAt(119, 96));
    restart.tick();
    assert.equal(restart.vars[90], 1, `${id} Restart gadget restarts`);
    quit.deliverHostAnswer(quit.confirmGadgetAt(227, 96));
    quit.tick();
    assert.equal(quit.vars[82], 1, `${id} Continue gadget resumes`);
    assert.equal(
      quit.readState().terminated,
      false,
      `${id} Continue gadget keeps the game running`,
    );
  }

  // PC and IIgs builds show the Enter/Escape prompts with no gadgets: every
  // point of their windows misses (2.001..2.230 quit without a prompt).
  for (const id of ["2.001", "2.089", "2.936", "3.002.149", "iigs-1.014"] as const) {
    const restart = open(id, 1);
    for (let y = 0; y < 200; y += 4)
      for (let x = 0; x < 320; x += 4)
        assert.equal(
          restart.confirmGadgetAt(x, y),
          null,
          `${id} restart has no gadget at ${x},${y}`,
        );
    if (PROFILES[id].exitAlwaysImmediate) continue;
    const quit = open(id, 2);
    for (let y = 0; y < 200; y += 4)
      for (let x = 0; x < 320; x += 4)
        assert.equal(quit.confirmGadgetAt(x, y), null, `${id} quit has no gadget at ${x},${y}`);
  }
});

test("F-persistence-05: the IIgs restart prompt asks Restart the game? with Restart and Cancel; Enter restarts and Esc continues", () => {
  // Player-visible rule: the Apple IIgs build asks "Restart the game?" with
  // Restart and Cancel, as its binary does (seg2+0x0348 -> seg2+0x2239 with
  // ~arrays+0x1271/0x1496/0x149e), not the PC text; its quit prompt keeps
  // the PC wording.
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (isset(f6)) { assignn(v90, 1); return; }
       if (equaln(v80, 1)) { restart.game(); assignn(v81, 1); return; }
       if (equaln(v80, 2)) { quit(0); assignn(v82, 1); return; }
       return;`,
      { dictionary: new Map(), profile: PROFILES["iigs-1.014"] },
    ).payload,
  );
  const open = (action: 1 | 2): Engine => {
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
      { profile: "iigs-1.014" },
    );
    engine.vars[80] = action;
    engine.tick();
    assert.equal(engine.modalKind, "print");
    return engine;
  };
  const screen = (engine: Engine) =>
    Array.from({ length: 25 }, (_, r) => engine.textRow(r)).join("\n");

  const declined = open(1);
  assert.match(screen(declined), /Restart the game\?/);
  assert.match(screen(declined), /Restart +Cancel/);
  assert.doesNotMatch(screen(declined), /Press ENTER/);
  declined.deliverHostAnswer(27);
  declined.tick();
  assert.equal(declined.vars[90], 0, "Esc keeps the game");
  assert.equal(declined.vars[81], 1, "Esc continues after restart.game");

  const accepted = open(1);
  accepted.deliverHostAnswer(13);
  accepted.tick();
  assert.equal(accepted.vars[90], 1, "Enter restarts");
  assert.equal(accepted.vars[81], 0);

  assert.match(screen(open(2)), /Press ENTER to quit\.\s+Press ESC to keep playing\./);
});

/**
 * Player-visible rule: a restart or quit prompt reached while a timed message
 * is pending (v21) accepts when its time runs out or on Enter or Esc, and
 * with the leave-window flag (f15) set it accepts at once. The prompts call
 * the shared message routine print uses (docs/fidelity.md "Persistence
 * verdicts", F-persistence-prompt-modes).
 */
function promptGame(id: keyof typeof PROFILES) {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (isset(f6)) { assignn(v90, 1); return; }
       if (equaln(v80, 1)) { restart.game(); assignn(v81, 1); return; }
       ${PROFILES[id].exitOperandBytes === 0 ? "" : "if (equaln(v80, 2)) { quit(0); assignn(v82, 1); return; }"}
       return;`,
      { dictionary: new Map(), profile: PROFILES[id] },
    ).payload,
  );
  let waits = 0;
  const engine = new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
      waitKey() {
        waits++;
        throw new HostWait();
      },
    },
    new Map(),
    { profile: id },
  );
  return {
    engine,
    waits: () => waits,
    ask(action: 1 | 2, { v21 = 0, f15 = false } = {}) {
      engine.vars[21] = v21;
      engine.flags[15] = f15 ? 1 : 0;
      engine.vars[80] = action;
      engine.tick();
    },
    answer(key: number) {
      engine.deliverHostAnswer(key);
      engine.tick();
    },
    restarted: () => engine.vars[90] === 1,
  };
}

test("F-persistence-prompt-modes: a timed restart prompt accepts on Enter, Esc or the timeout and drops other keys", () => {
  for (const id of [
    "2.089",
    "2.936",
    "3.002.149",
    "amiga-2.082",
    "amiga-2.316",
    "iigs-1.014",
  ] as const) {
    const esc = promptGame(id);
    esc.ask(1, { v21: 4 });
    assert.equal(esc.engine.modalKind, "print", `${id}: the prompt shows`);
    esc.answer(0x61);
    assert.equal(esc.restarted(), false, `${id}: another key is dropped`);
    assert.equal(esc.engine.awaitingKey, true, `${id}: the prompt still waits`);
    esc.answer(0x1b);
    assert.equal(esc.restarted(), true, `${id}: Esc accepts a timed prompt`);

    const timeout = promptGame(id);
    timeout.ask(1, { v21: 4 });
    timeout.engine.advanceClock(1900);
    timeout.engine.tick();
    assert.equal(timeout.restarted(), false, `${id}: still waiting before two seconds`);
    timeout.engine.advanceClock(200);
    timeout.engine.tick();
    assert.equal(timeout.restarted(), true, `${id}: v21 half-seconds accept the prompt`);
    assert.equal(timeout.engine.awaitingKey, false);
  }
});

test("F-persistence-prompt-modes: with f15 set the prompt accepts at once on PC 2.411+, Amiga 2.176+ and IIgs", () => {
  for (const id of [
    "2.411",
    "2.936",
    "3.002.149",
    "amiga-2.176",
    "amiga-2.333",
    "iigs-1.014",
  ] as const) {
    const game = promptGame(id);
    game.ask(1, { f15: true });
    assert.equal(game.restarted(), true, `${id}: restarted without a key`);
    assert.equal(game.waits(), 0, `${id}: no key wait`);
  }
  for (const id of ["2.001", "2.089", "2.272", "amiga-2.082"] as const) {
    const game = promptGame(id);
    game.ask(1, { f15: true });
    assert.equal(game.restarted(), false, `${id}: the prompt waits`);
    assert.equal(game.engine.awaitingKey, true, `${id}: for its key`);
    game.answer(0x1b);
    assert.equal(game.restarted(), false, `${id}: Esc declines`);
    assert.equal(game.engine.vars[81], 1, `${id}: the game continues`);
  }
});

test("F-persistence-prompt-modes: 2.001 has no timed prompt; Esc declines it whatever v21 is", () => {
  const game = promptGame("2.001");
  game.ask(1, { v21: 4 });
  game.engine.advanceClock(5000);
  game.engine.tick();
  assert.equal(game.restarted(), false, "the timeout does not accept");
  game.answer(0x1b);
  assert.equal(game.restarted(), false);
  assert.equal(game.engine.vars[81], 1);
});

test("F-persistence-prompt-modes: the quit prompt shares the modes", () => {
  const timed = promptGame("2.936");
  timed.ask(2, { v21: 2 });
  timed.answer(0x1b);
  assert.equal(timed.engine.readState().terminated, true, "Esc accepts a timed quit prompt");

  const expired = promptGame("2.272");
  expired.ask(2, { v21: 2 });
  expired.engine.advanceClock(1100);
  expired.engine.tick();
  assert.equal(expired.engine.readState().terminated, true, "the timeout quits");

  const persistent = promptGame("amiga-2.202");
  persistent.ask(2, { f15: true });
  assert.equal(persistent.engine.readState().terminated, true, "f15 quits at once");

  const plain = promptGame("2.936");
  plain.ask(2);
  plain.answer(0x1b);
  assert.equal(plain.engine.readState().terminated, false, "Esc declines an untimed quit prompt");
  assert.equal(plain.engine.vars[82], 1);
});

test("F-persistence-prompt-modes: with f15 set the restart prompt window stays on screen until the next print", () => {
  // The f15 path returns accept without closing the window, and the restart
  // writes no screen (docs/fidelity.md "Original restart state boundary").
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (isset(f6)) { assignn(v90, 1); return; }
       if (equaln(v80, 1)) { set(f15); restart.game(); return; }
       if (isset(f201)) { reset(f201); print("Next."); }
       return;`,
      { dictionary: new Map() },
    ).payload,
  );
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
  );
  const screen = () => Array.from({ length: 25 }, (_, r) => engine.textRow(r)).join("\n");
  engine.vars[80] = 1;
  engine.tick();
  assert.equal(engine.vars[90], 1, "restarted at once");
  assert.equal(engine.flags[15], 0, "f15 was consumed");
  assert.match(screen(), /Press ENTER to restart/, "the prompt window stays");
  engine.flags[201] = 1;
  engine.tick();
  assert.doesNotMatch(screen(), /Press ENTER to restart/, "the next print closed it");
});
