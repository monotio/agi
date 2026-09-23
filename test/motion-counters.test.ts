import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";

// docs/fidelity.md "Original motion counter width": the Amiga and IIgs keep
// the wander countdown and follow delay in signed words, the PC in bytes.
// Every random draw below returns 20, so a reroll lands on 20 % 51 = 20 and
// a direction on 20 % 9 = 2.

const DICT = new Map<string, number>();

class FixedHost implements EngineHost {
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return [];
  }
  randomByte(): number {
    return 20;
  }
}

function solidView(width: number, height: number): Uint8Array {
  const rows = Array.from({ length: height }, () => [0x50 | width, 0]).flat();
  return new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, width, height, 0, ...rows]);
}

/** Ego at (20, 100) and object 1 at (100, 100), both step 1; `after` runs every cycle. */
function boot(profile: ProfileId, after = "") {
  const source = `
    if (!isset(f200)) {
      set(f200);
      load.pic(v250); draw.pic(v250); show.pic(); load.view(0); assignn(v251, 1);
      animate.obj(o0); set.view(o0, 0); position(o0, 20, 100);
      step.size(o0, v251); step.time(o0, v251); draw(o0);
      animate.obj(o1); set.view(o1, 0); position(o1, 100, 100);
      step.size(o1, v251); step.time(o1, v251); draw(o1);
    }
    ${after}
    return;
  `;
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(source, { dictionary: DICT, profile: PROFILES[profile] }).payload,
  );
  container.putResource("picture", 0, Uint8Array.of(0xff));
  container.putResource("view", 0, solidView(4, 10));
  const engine = new Engine(container, new FixedHost(), DICT, { profile });
  engine.tick();
  return { engine, o1: engine.screenObjects[1]! };
}

function run(engine: Engine, cycles: number): void {
  for (let i = 0; i < cycles; i++) engine.tick();
}

test("an exhausted wander count rerolls on a word counter and wraps to 255 on a byte", () => {
  for (const [id, expected] of [
    ["amiga-2.316", 20],
    ["iigs-1.014", 20],
    ["2.936", 255],
  ] as const) {
    const { engine, o1 } = boot(id, "if (isset(f201)) { reset(f201); wander(o1); }");
    engine.flags[201] = 1;
    engine.tick(); // wander starts; its first pass draws from an exhausted count
    o1.paramBank[0] = 0;
    engine.tick();
    assert.equal(o1.paramBank[0], expected, id);
  }
});

test("wander keeps the countdown word on Amiga and IIgs and zeroes the PC byte", () => {
  for (const [id, expected] of [
    ["amiga-2.316", 40 - 1],
    ["iigs-1.014", 40 - 1],
    ["2.936", 255],
  ] as const) {
    const { engine, o1 } = boot(id, "if (isset(f201)) { reset(f201); wander(o1); }");
    o1.paramBank[0] = 40;
    engine.flags[201] = 1;
    engine.tick(); // wander runs in logic, after this cycle's motion pass
    engine.tick();
    // Word: 40 carried into wander and decremented once. Byte: zeroed at the
    // command, so the first pass wraps the exhausted count to 255.
    assert.equal(o1.paramBank[0], expected, id);
  }
});

test("a follow delay above 127 counts down on a word and is dropped on a signed byte", () => {
  for (const [id, expected] of [
    ["amiga-2.316", 199],
    ["iigs-1.014", 199],
    ["2.936", 0],
  ] as const) {
    const { engine, o1 } = boot(id, "if (isset(f201)) { reset(f201); follow.ego(o1, 1, f210); }");
    engine.flags[201] = 1;
    engine.tick(); // follow.ego runs in logic, after this cycle's motion pass
    engine.tick(); // the 255 retry byte clears and o1 heads for ego
    engine.tick(); // o1 has moved, so it is no longer stationary
    o1.paramBank[2] = 200;
    engine.tick();
    assert.equal(o1.paramBank[2], expected, id);
  }
});

test("a negative wander word survives a native save", () => {
  const { engine, o1 } = boot("amiga-2.316", "if (isset(f201)) { reset(f201); wander(o1); }");
  engine.flags[201] = 1;
  run(engine, 3); // wander starts, rerolls the stationary object, and it moves
  o1.paramBank[0] = 0xfffe; // e.g. a click target carried into wander
  engine.tick();
  assert.equal(o1.paramBank[0], 0xfffd, "-2 is not exhausted: it only counts down");
  const image = engine.autosaveImage();
  assert.ok(image);
  const restored = boot("amiga-2.316").engine;
  restored.restoreImage(image);
  assert.equal(restored.screenObjects[1]!.paramBank[0], 0xfffd);
});
