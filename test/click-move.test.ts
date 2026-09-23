import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { AGI_KEY } from "../src/runtime/keys.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";

// docs/fidelity.md "Original click-to-walk": the Amiga and IIgs interpreters
// start ego's click-move on a left-button-down. Expected targets are worked
// by hand from the starter: x = click x / 2 - ego width / 2 (+ nudge),
// y = click y - play-area top (+ nudge).

const DICT = new Map<string, number>();

class ClickHost implements EngineHost {
  keys: number[] = [];
  clicks: [number, number][] = [];
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
  takePointerClicks(): [number, number][] {
    return this.clicks.splice(0);
  }
}

/** 1 loop, 1 cel: a solid width x height block of color 5. */
function solidView(width: number, height: number): Uint8Array {
  const rows = Array.from({ length: height }, () => [0x50 | width, 0]).flat();
  return new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, width, height, 0, ...rows]);
}

/**
 * Ego is a 4-pixel-wide block at (20, 100) on a blank picture; a cold boot
 * zeroes object records, so the setup sets step size and time to 1.
 * Logic 0 mirrors click.move.pending into f221 where the profile has it, and
 * `after` runs every cycle after the setup.
 */
function boot(profile: ProfileId, after = "") {
  const pending = PROFILES[profile].condition0x13 === "click-move";
  const source = `
    if (!isset(f200)) {
      set(f200);
      load.pic(v250); draw.pic(v250); show.pic();
      animate.obj(o0); load.view(0); set.view(o0, 0); position(o0, 20, 100);
      assignn(v251, 1); step.size(o0, v251); step.time(o0, v251); draw(o0);
    }
    ${pending ? "reset(f221); if (click.move.pending()) { set(f221); }" : ""}
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
  const host = new ClickHost();
  const engine = new Engine(container, host, DICT, { profile });
  engine.tick();
  return { engine, host, ego: engine.screenObjects[0]! };
}

function run(engine: Engine, cycles: number): void {
  for (let i = 0; i < cycles; i++) engine.tick();
}

test("a click on 2.31x walks ego to the click and hands control back", () => {
  const { engine, host, ego } = boot("amiga-2.316");
  // Screen (161, 108): target x = 80 - 2 = 78; y = 108 - 8 (display base row 1) = 100.
  host.clicks.push([161, 108]);
  engine.tick();
  assert.equal(ego.motionMode, 4, "the click starts click-move");
  assert.equal(engine.flags[221], 1, "click.move.pending sees it the same cycle");
  assert.equal(engine.flags[19], 1, "the 2.31x click sets f19");
  assert.deepEqual(ego.paramBank.slice(0, 3), [78, 100, 1], "target and saved step");
  run(engine, 80);
  assert.equal(ego.x, 78);
  assert.equal(ego.y, 100);
  assert.equal(ego.motionMode, 0, "arrival ends click-move");
  assert.equal(engine.flags[221], 0);
  assert.equal(engine.vars[6], 0, "arrival clears ego's heading");
  assert.equal(engine.movementControlEnabled, true);
});

test("mouse.posn reports the last click, X halved, Y unadjusted", () => {
  const { engine, host } = boot("amiga-2.316", "mouse.posn(v100, v101);");
  assert.deepEqual([engine.vars[100], engine.vars[101]], [0, 0], "no click yet");
  host.clicks.push([161, 108]);
  engine.tick();
  assert.deepEqual([engine.vars[100], engine.vars[101]], [80, 108]);
});

test("the nudge is two zero-extended bytes added to every later click", () => {
  const { engine, host, ego } = boot("amiga-2.316", "adj.ego.move.to.x.y(255, 2);");
  assert.deepEqual([...engine.clickMoveNudge], [255, 2]);
  host.clicks.push([161, 108]);
  engine.tick();
  assert.deepEqual(ego.paramBank.slice(0, 2), [78 + 255, 100 + 2]);
});

test("a click in the status line stores a negative target word", () => {
  const { engine, host, ego } = boot("amiga-2.316");
  // y = 0 - 8 = -8 -> 0xfff8; nothing clamps the target.
  host.clicks.push([161, 0]);
  engine.tick();
  assert.equal(ego.paramBank[1], 0xfff8);
  run(engine, 3);
  assert.ok(ego.y < 100, "ego heads up toward the negative target");
});

test("a text window blocks the walk but 2.31x still latches the click", () => {
  const { engine, host, ego } = boot(
    "amiga-2.316",
    'if (!isset(f201)) { set(f201); set(f15); print("Hello"); } mouse.posn(v100, v101);',
  );
  engine.tick();
  assert.equal(engine.modalOpen, true, "the non-blocking window is up");
  host.clicks.push([161, 108]);
  engine.tick();
  assert.equal(ego.motionMode, 0);
  assert.equal(engine.flags[19], 1);
  assert.deepEqual([engine.vars[100], engine.vars[101]], [80, 108]);
});

test("program control ignores the click", () => {
  const { engine, host, ego } = boot("amiga-2.316", "program.control();");
  host.clicks.push([161, 108]);
  engine.tick();
  assert.equal(ego.motionMode, 0);
});

test("a direction key under player control cancels the walk", () => {
  const { engine, host, ego } = boot("amiga-2.316");
  host.clicks.push([161, 108]);
  engine.tick();
  assert.equal(ego.motionMode, 4);
  host.keys.push(AGI_KEY.UP);
  engine.tick();
  assert.equal(ego.motionMode, 0);
});

test("reaching the screen edge does not end the walk", () => {
  // Target x = 0 - 2 = -2: ego walks into the left edge and keeps click-move
  // (the edge handler completes only move.obj).
  const { engine, host, ego } = boot("amiga-2.316");
  host.clicks.push([0, 108]);
  run(engine, 40);
  assert.equal(ego.x, 0);
  assert.equal(engine.vars[2], 4, "the left edge is reported");
  assert.equal(ego.motionMode, 4);
});

test("new.room cancels a pending walk and clears ego's heading", () => {
  const { engine, host, ego } = boot("amiga-2.316", "if (isset(f202)) { reset(f202); new.room(0); }");
  host.clicks.push([161, 108]);
  run(engine, 2);
  assert.equal(ego.motionMode, 4);
  engine.flags[202] = 1;
  engine.tick();
  assert.equal(ego.motionMode, 0);
  assert.equal(engine.vars[6], 0);
});

test("earlier Amiga builds walk on a click without the 2.31x bookkeeping", () => {
  for (const id of ["amiga-2.082", "amiga-2.176", "amiga-2.202"] as const) {
    const { engine, host, ego } = boot(id);
    host.clicks.push([161, 108]);
    engine.tick();
    assert.equal(ego.motionMode, 4, id);
    assert.deepEqual(ego.paramBank.slice(0, 2), [78, 100], id);
    assert.equal(engine.flags[19], 0, id);
    assert.deepEqual([engine.pointerX, engine.pointerY], [0, 0], id);
  }
});

test("the IIgs ignores clicks on the menu bar rows", () => {
  const { engine, host, ego } = boot("iigs-1.014");
  host.clicks.push([161, 7]);
  engine.tick();
  assert.equal(ego.motionMode, 0, "row 7 is the menu bar");
  host.clicks.push([161, 108]);
  engine.tick();
  assert.equal(ego.motionMode, 4);
  assert.deepEqual(ego.paramBank.slice(0, 2), [78, 100]);
  assert.equal(engine.flags[19], 0);
});

test("PC profiles take no pointer input", () => {
  const { engine, host, ego } = boot("3.002.149");
  host.clicks.push([161, 108]);
  engine.tick();
  assert.equal(ego.motionMode, 0);
  assert.equal(engine.flags[19], 0);
});

test("a native save keeps the whole click-move target words", () => {
  const { engine, host, ego } = boot("amiga-2.316");
  host.clicks.push([161, 0]);
  engine.tick();
  const image = engine.autosaveImage();
  assert.ok(image);
  const restored = boot("amiga-2.316").engine;
  restored.restoreImage(image);
  const back = restored.screenObjects[0]!;
  assert.equal(back.motionMode, 4);
  assert.deepEqual(back.paramBank.slice(0, 3), [...ego.paramBank.slice(0, 3)]);
  assert.equal(back.paramBank[1], 0xfff8);
});
