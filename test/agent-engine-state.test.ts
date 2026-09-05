import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";

/**
 * The host inspection surface the power-up and the agent's runtime tools
 * read: readObjects(), readState() and reenterRoom(). Every expectation below is computed by
 * hand from the logic source in this file.
 */

const DICT = new Map([
  ["look", 100],
  ["east", 101],
]);

class QuietHost implements EngineHost {
  prints: string[] = [];
  inputQueue: (string | null)[] = [];
  engine?: Engine;

  print(text: string): void {
    this.prints.push(text);
    this.engine?.ackPrint();
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return this.inputQueue.shift() ?? null;
  }
  takeKeys(): number[] {
    return [];
  }
}

/** Blue box + a priority line, the same hand-authored picture engine.test uses. */
const PICTURE_1 = new Uint8Array([
  0xf0, 0x01, 0xf6, 10, 10, 60, 10, 60, 40, 10, 40, 10, 10, 0xf8, 30, 20, 0xf1, 0xf2, 0x05, 0xf6, 0,
  150, 159, 150, 0xf3, 0xff,
]);

const LOGIC_0 = `
if (!isset(f200)) {
  set(f200);
  assignn(v0, 1);
  new.room.v(v0);
}
call.v(v0);
return;
`;

/**
 * Room 1 places ego (object 0) at (80, 120) and a second object at (40, 60)
 * moving east with step size 3, so the object table has two active rows with
 * distinct, hand-known values.
 */
const LOGIC_1 = `
#message 1 "You are in room one."
#message 2 "A plain wall."
if (isset(f5)) {
  assignn(v50, 1);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  set.horizon(42);
  animate.obj(o0);
  set.view(o0, 0);
  position(o0, 80, 120);
  draw(o0);
  animate.obj(o1);
  set.view(o1, 0);
  position(o1, 40, 60);
  assignn(v60, 3);
  step.size(o1, v60);
  set.dir(o1, v60);
  draw(o1);
  accept.input();
  print(1);
}
if (said("look")) { print(2); }
return;
`;

function buildGame() {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(LOGIC_0, { dictionary: DICT }).payload);
  container.putResource("logic", 1, assembleLogic(LOGIC_1, { dictionary: DICT }).payload);
  container.putResource("picture", 1, PICTURE_1);
  // Minimal valid view: 1 loop, 1 cel, 1x1 pixel of colour 5.
  container.putResource(
    "view",
    0,
    new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 1, 0, 0x51, 0]),
  );
  return container;
}

function bootedEngine(): { engine: Engine; host: QuietHost } {
  const host = new QuietHost();
  const engine = new Engine(buildGame(), host, DICT);
  host.engine = engine;
  engine.tick();
  return { engine, host };
}

test("readObjects reports only active objects, with their game-visible state", () => {
  const { engine } = bootedEngine();
  const objects = engine.readObjects();

  // Exactly the two objects the room animated.
  assert.equal(objects.length, 2);
  assert.deepEqual(
    objects.map((o) => o.num),
    [0, 1],
  );

  const ego = objects[0]!;
  assert.equal(ego.view, 0);
  assert.equal(ego.loop, 0);
  assert.equal(ego.cel, 0);
  assert.equal(ego.x, 80);
  assert.equal(ego.y, 120);
  // The view is a 1x1 cel, so the cel dimensions are 1x1 once it is selected.
  assert.equal(ego.width, 1);
  assert.equal(ego.height, 1);
  assert.equal(ego.stepSize, 1, "step size defaults to 1");
  assert.equal(ego.motionMode, 0, "normal motion");
  assert.equal(ego.update, true);

  const npc = objects[1]!;
  // Object Behavior: positioning suppresses the first due movement delta.
  // It remains at (40,60) this cycle despite facing east with step size3.
  assert.equal(npc.x, 40);
  assert.equal(npc.y, 60);
  assert.equal(npc.stepSize, 3, "step.size(o1, v60) with v60 = 3");
  assert.equal(npc.direction, 3, "set.dir(o1, v60) is east");
  assert.equal(npc.cycling, true);
  assert.equal(npc.cycleMode, 0, "forward cycling");
});

test("readObjects is a detached snapshot, not the live object records", () => {
  const { engine } = bootedEngine();
  const before = engine.readObjects();
  before[0]!.x = 999;
  assert.equal(engine.readObjects()[0]!.x, 80, "mutating the snapshot cannot move ego");
});

test("readState reports room, ego, the full var/flag arrays and parser state", () => {
  const { engine, host } = bootedEngine();
  host.inputQueue.push("look");
  engine.tick();

  const state = engine.readState();
  assert.equal(state.room, 1, "v0");
  // Logic 0 assigns v0 = 1 BEFORE new.room.v(v0), so the switch records the
  // already-updated room as the previous one.
  assert.equal(state.previousRoom, 1);
  assert.equal(state.egoX, 80);
  assert.equal(state.egoY, 120);
  assert.equal(state.horizon, 42, "set.horizon(42)");
  assert.equal(state.modalKind, null, "the print window was acknowledged");

  // The whole address space is reported, not a slice of it.
  assert.equal(state.vars.length, 256);
  assert.equal(state.flags.length, 256);
  assert.equal(state.vars[0], 1, "v0 mirrors the room");
  assert.equal(state.flags[200], 1, "logic 0 latched f200 on boot");

  // Parser: "look" is one dictionary word, id 100.
  assert.equal(state.lastInputLine, "look");
  assert.deepEqual(state.parsedWords, [100]);
  assert.deepEqual(state.parsedWordTexts, ["look"]);
  assert.equal(state.parserCount, 1);
  assert.deepEqual(host.prints, ["You are in room one.", "A plain wall."]);

  // String slots come from the profile (twelve at 2.936).
  assert.equal(state.strings.length, 12);
  assert.equal(state.profile, engine.profile.id);
});

test("readState is a detached snapshot of the var and flag arrays", () => {
  const { engine } = bootedEngine();
  const state = engine.readState();
  state.vars[0] = 99;
  state.flags[200] = 0;
  assert.equal(engine.vars[0], 1);
  assert.equal(engine.flags[200], 1);
});

test("reenterRoom re-runs the room's init block after a live patch", () => {
  const { engine, host } = bootedEngine();
  assert.deepEqual(host.prints, ["You are in room one."]);

  // A live patch changes the room's greeting; the running interpreter is
  // holding the OLD logic until the room is re-entered.
  const patched = assembleLogic(LOGIC_1.replace("You are in room one.", "The room has changed."), {
    dictionary: DICT,
  });
  engine.patchResource("logic", 1, patched.payload);
  engine.tick();
  assert.deepEqual(host.prints, ["You are in room one."], "no redraw without a room switch");

  engine.reenterRoom();
  assert.equal(engine.flags[5], 1, "f5 (new room) is set for the next cycle");
  assert.equal(engine.vars[0], 1, "still the same room");
  assert.equal(engine.readObjects().length, 0, "objects are unanimated by the switch");

  engine.tick();
  assert.deepEqual(host.prints, ["You are in room one.", "The room has changed."]);
  assert.equal(engine.readObjects().length, 2, "the room re-animated its objects");
  assert.equal(engine.readState().previousRoom, 1, "v1 records the room we came from");
});

test("new.room prepares a destination before changing interpreter state", () => {
  const { engine, host } = bootedEngine();
  const calls: number[][] = [];
  Object.assign(host, {
    prepareRoom(room: number, from: number): boolean {
      calls.push([room, from]);
      assert.equal(engine.vars[0], 1);
      assert.equal(engine.readObjects().length, 2);
      engine.patchResource("logic", room, assembleLogic("return;", { dictionary: DICT }).payload);
      return true;
    },
  });
  engine.patchResource(
    "logic",
    1,
    assembleLogic("new.room(7); return;", { dictionary: DICT }).payload,
  );
  engine.tick();
  assert.deepEqual(calls, [[7, 1]]);
  assert.equal(engine.vars[0], 7);
  assert.equal(engine.vars[1], 1);
});

test("a refused room preparation preserves the current room and permits a retry", () => {
  const { engine, host } = bootedEngine();
  let ready = false;
  Object.assign(host, { prepareRoom: () => ready });
  engine.patchResource(
    "logic",
    1,
    assembleLogic("new.room(7); return;", { dictionary: DICT }).payload,
  );
  const before = engine.readObjects();
  engine.tick();
  assert.equal(engine.vars[0], 1);
  assert.equal(engine.readObjects().length, before.length);
  assert.match(host.prints.at(-1)!, /not available/);
  ready = true;
  engine.patchResource("logic", 7, assembleLogic("return;", { dictionary: DICT }).payload);
  engine.tick();
  assert.equal(engine.vars[0], 7);
});

for (const source of [
  "llm.say(m1, s0);",
  "llm.room(v51);",
  "llm.event(m1, f50);",
  "llm.lexicon(m1, v50);",
]) {
  test(`the assembler rejects retired extension: ${source}`, () => {
    assert.throws(
      () => assembleLogic(`#message 1 "test"\n${source}\nreturn;`, { dictionary: DICT }),
      /unknown/i,
    );
  });
}
