import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";
import {
  MOTION_CLICK_MOVE,
  MOTION_FOLLOW,
  MOTION_MOVE_OBJ,
  MOTION_NORMAL,
  MOTION_WANDER,
} from "../src/runtime/screenObject.ts";
import { findFixture, fixtureSkip } from "./fixtures.ts";

// docs/fidelity.md "Original player.control handler": the DOS handlers and
// the Amiga 2.082 executable clear object 0's motion word every time the
// action runs. The inspected later Amiga handlers (2.176 through 2.333) test
// the prior player-control field first and return early when it is already
// set, so a repeated player.control leaves an autonomous ego motion — any of
// modes 1..4 — running; only a program→player transition clears it.

const TRANSITION_ONLY: readonly ProfileId[] = [
  "amiga-2.176",
  "amiga-2.202",
  "amiga-2.310",
  "amiga-2.316",
  "amiga-2.333",
];
const UNCONDITIONAL: readonly ProfileId[] = ["2.936", "amiga-2.082"];

const AUTONOMOUS = [
  ["move.obj", MOTION_MOVE_OBJ],
  ["follow.ego", MOTION_FOLLOW],
  ["wander", MOTION_WANDER],
  ["click-move", MOTION_CLICK_MOVE],
] as const;

class QuietHost implements EngineHost {
  clicks: [number, number][] = [];
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return [];
  }
  takePointerClicks(): [number, number][] {
    return this.clicks.splice(0);
  }
  randomByte(): number {
    return 42;
  }
}

/** A container whose logic 0 calls player.control and logic 1 program.control. */
function controlEngine(profile: ProfileId): Engine {
  const container = createContainer();
  const dictionary = new Map<string, number>();
  for (const [num, source] of [
    [0, "player.control(); return;"],
    [1, "program.control(); return;"],
  ] as const) {
    container.putResource(
      "logic",
      num,
      assembleLogic(source, { dictionary, profile: PROFILES[profile] }).payload,
    );
  }
  const engine = new Engine(container, new QuietHost(), dictionary, { profile });
  engine.tick();
  return engine;
}

for (const profile of [...UNCONDITIONAL, ...TRANSITION_ONLY]) {
  const transitionOnly = TRANSITION_ONLY.includes(profile);
  for (const prior of ["player", "program"] as const) {
    for (const [label, mode] of AUTONOMOUS) {
      test(`${profile}: player.control under prior ${prior} control, ego in ${label}`, () => {
        const engine = controlEngine(profile);
        if (prior === "program") engine.execute(1);
        const ego = engine.screenObjects[0]!;
        ego.motionMode = mode;
        ego.direction = 2;
        ego.stepSize = 1;
        ego.stepTime = 2;
        ego.stepCount = 2;
        ego.paramBank = [77, 112, 1, 0];
        engine.vars[6] = 2;
        engine.execute(0);
        assert.equal(engine.movementControlEnabled, true, "player control is selected");
        assert.equal(
          ego.motionMode,
          transitionOnly && prior === "player" ? mode : MOTION_NORMAL,
          "the later Amiga handler preserves autonomous motion while control stays the player's",
        );
        assert.equal(ego.direction, 2, "the direction byte is untouched");
        assert.equal(engine.vars[6], 2, "v6 is untouched");
        assert.deepEqual([...ego.paramBank], [77, 112, 1, 0], "the motion bank is untouched");
        assert.deepEqual(
          [ego.stepSize, ego.stepTime, ego.stepCount],
          [1, 2, 2],
          "the step cadence is untouched",
        );
      });
    }
  }
}

test("later Amiga builds keep autonomous ego motion across repeated player.control calls", () => {
  // The original handler returns as soon as it sees control already coupled
  // to the player, so a per-cycle player.control never ends the motion.
  for (const profile of TRANSITION_ONLY) {
    const engine = controlEngine(profile);
    const ego = engine.screenObjects[0]!;
    ego.motionMode = MOTION_CLICK_MOVE;
    ego.direction = 3;
    engine.execute(0);
    engine.execute(0);
    engine.execute(0);
    assert.equal(ego.motionMode, MOTION_CLICK_MOVE, profile);
    assert.equal(ego.direction, 3, profile);
  }
});

/** 1 loop, 1 cel: a solid width x height block of color 5. */
function solidView(width: number, height: number): Uint8Array {
  const rows = Array.from({ length: height }, () => [0x50 | width, 0]).flat();
  return new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, width, height, 0, ...rows]);
}

/**
 * Ego is a 4-pixel-wide block at (20, 100) on a blank picture; the logic then
 * issues player.control every cycle, the pattern the later Amiga game
 * scripts use. Expected click target from the starter: x = floor(161/2) -
 * floor(4/2) = 78, y = 108 - 8 (play-area top) = 100.
 */
function clickWalkEngine(profile: ProfileId): { engine: Engine; host: QuietHost } {
  const container = createContainer();
  const dictionary = new Map<string, number>();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `
      if (!isset(f200)) {
        set(f200);
        load.pic(v250); draw.pic(v250); show.pic();
        animate.obj(o0); load.view(0); set.view(o0, 0); position(o0, 20, 100);
        assignn(v251, 1); step.size(o0, v251); step.time(o0, v251); draw(o0);
      }
      player.control();
      return;
      `,
      { dictionary, profile: PROFILES[profile] },
    ).payload,
  );
  container.putResource("picture", 0, Uint8Array.of(0xff));
  container.putResource("view", 0, solidView(4, 10));
  const host = new QuietHost();
  const engine = new Engine(container, host, dictionary, { profile });
  engine.tick();
  return { engine, host };
}

for (const profile of TRANSITION_ONLY) {
  test(`${profile}: a click-walk survives a per-cycle player.control and reaches the target`, () => {
    const { engine, host } = clickWalkEngine(profile);
    const ego = engine.screenObjects[0]!;
    host.clicks.push([161, 108]);
    engine.tick();
    assert.equal(ego.motionMode, MOTION_CLICK_MOVE, "the click starts click-move");
    assert.deepEqual(ego.paramBank.slice(0, 2), [78, 100], "the stored click target");
    for (let i = 0; i < 200; i++) {
      engine.tick();
      const mode: number = ego.motionMode;
      if (mode === MOTION_NORMAL) break;
    }
    assert.deepEqual([ego.x, ego.y], [78, 100], "ego stands on the target");
    assert.equal(ego.motionMode, MOTION_NORMAL, "arrival ends click-move");
    assert.equal(ego.direction, 0, "arrival clears ego's heading");
    assert.equal(engine.vars[6], 0);
  });
}

test("amiga-2.082: a per-cycle player.control still cancels an in-flight click-move", () => {
  // The 2.082 handler has no prior-control test: the same-cycle call already
  // ends the walk, and ego keeps the click's heading under player control.
  const { engine, host } = clickWalkEngine("amiga-2.082");
  const ego = engine.screenObjects[0]!;
  host.clicks.push([161, 108]);
  engine.tick();
  assert.equal(ego.motionMode, MOTION_NORMAL, "the same-cycle player.control ends click-move");
  assert.equal(ego.direction, 3, "the click's rightward heading survives");
  const x = ego.x;
  engine.tick();
  assert.equal(ego.x, x + 1, "player control walks ego in the surviving heading");
});

// Original-game replay of the report: PQ1's Amiga logic 0 issues
// player.control on every ordinary cycle, so each fixture click below used
// to strand ego mid-walk. Targets are hand-computed from the shipped ego
// view (width 7, so x = floor(screenX/2) - 3, y = screenY - 8). The SQ1 2.082
// control reaches the same targets because its room does not repeat the
// action on those cycles.
const PORT_CLICKS: {
  alias: string;
  cases: readonly {
    name: string;
    click: [number, number];
    target: readonly [number, number];
  }[];
}[] = [
  {
    alias: "pq1-amiga",
    cases: [
      { name: "horizontal", click: [136, 128], target: [65, 120] },
      { name: "vertical", click: [126, 124], target: [60, 116] },
      { name: "diagonal", click: [136, 124], target: [65, 116] },
    ],
  },
  {
    alias: "sq1-amiga",
    cases: [
      { name: "horizontal", click: [210, 74], target: [102, 66] },
      { name: "vertical", click: [200, 78], target: [97, 70] },
      { name: "diagonal", click: [210, 78], target: [102, 70] },
    ],
  },
];

for (const { alias, cases } of PORT_CLICKS) {
  const skip = fixtureSkip(alias);
  for (const { name, click, target } of cases) {
    test(`${alias}: original-room ${name} click stops at its reachable target`, { skip }, () => {
      const fixture = findFixture(alias)!;
      assert.equal(fixture.known?.alias, alias, "the fixture resolves to its catalogued edition");
      const files = new Map<string, Uint8Array>();
      let dict = new Map<string, number>();
      for (const actual of fixture.files.values()) {
        const path = join(fixture.dir, actual);
        if (!statSync(path).isFile()) continue;
        const bytes = new Uint8Array(readFileSync(path));
        files.set(actual, bytes);
        if (actual.toLowerCase() === "words.tok")
          dict = new Map(parseWordsTok(bytes).map((e) => [e.word, e.id]));
      }
      const host = new QuietHost();
      const engine = new Engine(openContainer(files), host, dict, {
        restarted: true,
        profile: fixture.known!.profile as ProfileId,
      });
      for (let i = 0; i < 60; i++) {
        engine.tick();
        if (engine.modalOpen) engine.ackPrint();
      }
      const ego = engine.screenObjects[0]!;
      host.clicks.push(click);
      for (let i = 0; i < 10; i++) {
        engine.tick();
        if (engine.modalOpen) engine.ackPrint();
      }
      assert.deepEqual([ego.x, ego.y], target);
      assert.equal(ego.motionMode, MOTION_NORMAL);
      assert.equal(ego.direction, 0);
    });
  }
}
