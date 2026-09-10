import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { SCREEN_WIDTH } from "../src/types.ts";

const DICT = new Map([
  ["look", 100],
  ["east", 101],
]);

class ScriptedHost implements EngineHost {
  prints: string[] = [];
  displays: { row: number; col: number; text: string }[] = [];
  status: string[] = [];
  inputQueue: (string | null)[] = [];
  keys: number[] = [];
  /** Set post-construction: message windows are instantly acknowledged. */
  engine?: Engine;

  print(text: string): void {
    this.prints.push(text);
    this.engine?.ackPrint();
  }
  displayAt(row: number, col: number, text: string): void {
    this.displays.push({ row, col, text });
  }
  statusLine(text: string): void {
    this.status.push(text);
  }
  takeInputLine(): string | null {
    return this.inputQueue.shift() ?? null;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
}

// Hand-authored picture: blue box outline (10,10)-(60,40), filled; priority
// line 5 across y=150.
const PICTURE_1 = new Uint8Array([
  0xf0,
  0x01, // visual color 1
  0xf6,
  10,
  10,
  60,
  10,
  60,
  40,
  10,
  40,
  10,
  10, // absolute polyline box
  0xf8,
  30,
  20, // seed fill inside
  0xf1, // visual off
  0xf2,
  0x05, // priority value 5
  0xf6,
  0,
  150,
  159,
  150, // priority line
  0xf3,
  0xff,
]);

// Boot pattern: f200 latches so the post-new.room re-entry of logic 0
// does not re-trigger initialization.
const LOGIC_0 = `
if (!isset(f200)) {
  set(f200);
  assignn(v0, 1);
  new.room.v(v0);
}
call.v(v0);
return;
`;

const LOGIC_1 = `
#message 1 "You are in room one."
#message 2 "A simple room with four walls."
if (isset(f5)) {
  assignn(v50, 1);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  set.horizon(40);
  animate.obj(o0);
  set.view(o0, 0);
  position(o0, 80, 120);
  draw(o0);
  accept.input();
  print(1);
}
if (said("look")) { print(2); }
if (said("east")) { assignn(v50, 2); new.room.v(v50); }
return;
`;

const LOGIC_2 = `
#message 1 "You are in room two."
if (isset(f5)) { print(1); }
return;
`;

function buildGame() {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(LOGIC_0, { dictionary: DICT }).payload);
  container.putResource("logic", 1, assembleLogic(LOGIC_1, { dictionary: DICT }).payload);
  container.putResource("logic", 2, assembleLogic(LOGIC_2, { dictionary: DICT }).payload);
  container.putResource("picture", 1, PICTURE_1);
  // Minimal valid view: 1 loop, 1 cel, 1x1 pixel of color 5.
  container.putResource(
    "view",
    0,
    new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 1, 0, 0x51, 0]),
  );
  return container;
}

test("boot: room 1 initializes through the full toolchain", () => {
  const host = new ScriptedHost();
  const engine = new Engine(buildGame(), host, DICT);
  engine.tick();

  assert.deepEqual(host.prints, ["You are in room one."]);
  assert.equal(engine.vars[0], 1); // v0 = current room
  // Picture was decoded into the surface: filled interior, border, priority line.
  const surface = engine.surface;
  assert.equal(surface.visual[20 * SCREEN_WIDTH + 30], 1, "fill interior");
  assert.equal(surface.visual[10 * SCREEN_WIDTH + 10], 1, "box corner");
  assert.equal(surface.visual[0 * SCREEN_WIDTH + 0], 15, "outside stays white");
  assert.equal(surface.priority[150 * SCREEN_WIDTH + 100], 5, "priority line");
  // The opening message interrupts the initialization cycle.
  assert.equal(engine.flags[5], 1);
  engine.ackPrint();
  engine.tick();
  // f5 clears only after the interrupted cycle finishes.
  assert.equal(engine.flags[5], 0);
});

test("parser: said('look') prints the room description", () => {
  const host = new ScriptedHost();
  const engine = new Engine(buildGame(), host, DICT);
  host.engine = engine;
  engine.tick(); // boot
  host.inputQueue.push("look");
  engine.tick();
  assert.deepEqual(host.prints, ["You are in room one.", "A simple room with four walls."]);
});

test("parser: unknown input does not match said()", () => {
  const host = new ScriptedHost();
  const engine = new Engine(buildGame(), host, DICT);
  engine.tick();
  host.inputQueue.push("dance");
  engine.tick();
  assert.deepEqual(host.prints, ["You are in room one."]);
});

test("new.room: walking east switches rooms with full spec semantics", () => {
  const host = new ScriptedHost();
  const engine = new Engine(buildGame(), host, DICT);
  host.engine = engine;
  engine.tick();
  host.inputQueue.push("east");
  engine.tick();

  assert.equal(engine.vars[0], 2, "v0 = new room");
  assert.equal(engine.vars[1], 1, "v1 = previous room");
  assert.deepEqual(host.prints, ["You are in room one.", "You are in room two."]);
});

test("scalar ops: increment saturates, assignn works through real bytecode", () => {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `
      assignn(v100, 254);
      increment(v100);
      increment(v100);
      addn(v101, 250);
      addn(v101, 20);
      return;
      `,
      { dictionary: DICT },
    ).payload,
  );
  const engine = new Engine(container, new ScriptedHost(), DICT);
  engine.tick();
  assert.equal(engine.vars[100], 255, "increment saturates at 255");
  assert.equal(engine.vars[101], (250 + 20) & 0xff, "addn wraps mod 256");
});

test("byte outside the action table throws a descriptive error", () => {
  const container = createContainer();
  // 0xb0 is not a valid action opcode in the 2.936 profile (table gap).
  container.putResource("logic", 0, buildLogicResource(new Uint8Array([0xb0, 0x00]), []));
  const engine = new Engine(container, new ScriptedHost(), DICT);
  assert.throws(() => engine.tick(), /unimplemented opcode 0xb0 \(<not an action>\) at logic 0/);
});

test("presentation caching reuses composed frame across repeated queries and invalidates on tick", () => {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `
      #message 1 "Hello world"
      if (isset(f5)) {
        assignn(v50, 1);
        load.pic(v50);
        draw.pic(v50);
        show.pic();
      }
      if (isset(f200)) {
        display(10, 5, 1);
      }
      return;
      `,
      { dictionary: DICT },
    ).payload,
  );
  container.putResource("picture", 1, PICTURE_1);
  const host = new ScriptedHost();
  const engine = new Engine(container, host, DICT);
  host.engine = engine;

  engine.tick();
  const p1 = engine.getPresentation();
  const p2 = engine.getPresentation();
  assert.deepEqual(p1.visual, p2.visual);
  assert.deepEqual(p1.priority, p2.priority);
  assert.deepEqual(p1.text, p2.text);

  // Triggering text print invalidates cached presentation
  engine.flags[200] = 1;
  engine.tick();
  const p3 = engine.getPresentation();
  assert.notDeepEqual(p1.text, p3.text);
});
