import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { MESSAGE_KEY } from "../src/logic/resource.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { SCREEN_WIDTH } from "../src/types.ts";

const DICT = new Map([
  ["save", 200],
  ["restore", 201],
  ["mutate", 202],
]);

/** Host with the full contract surface; modal surfaces ack only when told. */
class TestHost implements EngineHost {
  prints: string[] = [];
  logs: string[] = [];
  inputQueue: (string | null)[] = [];
  saved: Uint8Array | null = null;
  promptNumberResult = 0;
  promptStringResult = "";
  showPriCalls = 0;
  statusItems: { num: number; name: string }[] | null = null;
  /** Set post-construction: message windows are instantly acknowledged. */
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
  showPriScreen(): void {
    this.showPriCalls++; // deliberately never acks: stays modal
  }
  statusScreen(items: { num: number; name: string }[]): void {
    this.statusItems = items;
    this.engine?.ackPrint();
  }
  saveGame(bytes: Uint8Array): void {
    this.saved = bytes;
  }
  restoreGame(): Uint8Array | null {
    return this.saved;
  }
  promptNumber(): number {
    return this.promptNumberResult;
  }
  promptString(): string {
    return this.promptStringResult;
  }
  logText(text: string): void {
    this.logs.push(text);
  }
}

/** 1 loop, 1 cel: 3x1 row of color 5 (transparent color 0). */
const VIEW_3PX = new Uint8Array([
  0,
  0,
  1,
  0,
  0,
  7,
  0, // header: 1 loop at offset 7
  1,
  3,
  0, // loop: 1 cel at loop+3
  3,
  1,
  0,
  0x53,
  0, // cel: 3x1, transparent 0, one run of 3 color-5 pixels
]);

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
  10, // box outline
  0xf1,
  0xff,
]);

function gameWith(logic0: string) {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(logic0, { dictionary: DICT }).payload);
  return container;
}

test("add.to.pic paints the cel into the persistent surface with margin control", () => {
  const container = gameWith(`
    load.view(0);
    add.to.pic(0, 0, 0, 10, 20, 15, 4);
    add.to.pic(0, 0, 0, 40, 50, 15, 2);
    return;
  `);
  container.putResource("view", 0, VIEW_3PX);
  const engine = new Engine(container, new TestHost(), DICT);
  engine.tick();

  // Full 3-pixel row drawn: visual color and drawing priority 15 (margin 4 = none).
  for (const x of [10, 11, 12]) {
    assert.equal(engine.surface.visual[20 * SCREEN_WIDTH + x], 5, `visual at x=${x}`);
    assert.equal(engine.surface.priority[20 * SCREEN_WIDTH + x], 15, `priority at x=${x}`);
  }
  // Margin 2 stamps the control color along the cel's baseline row.
  for (const x of [40, 41, 42]) {
    assert.equal(engine.surface.visual[50 * SCREEN_WIDTH + x], 5, `visual at x=${x}`);
    assert.equal(engine.surface.priority[50 * SCREEN_WIDTH + x], 2, `control at x=${x}`);
  }
});

test("add.to.pic.v draws through variable-selected operands", () => {
  const container = gameWith(`
    load.view(0);
    assignn(v100, 0);
    assignn(v101, 10);
    assignn(v102, 20);
    assignn(v103, 15);
    assignn(v104, 4);
    add.to.pic.v(v100, v100, v100, v101, v102, v103, v104);
    return;
  `);
  container.putResource("view", 0, VIEW_3PX);
  const engine = new Engine(container, new TestHost(), DICT);
  engine.tick();
  assert.equal(engine.surface.visual[20 * SCREEN_WIDTH + 10], 5);
});

const SAVE_GAME_LOGIC_0 = `
if (!isset(f200)) {
  set(f200);
  assignn(v0, 1);
  new.room.v(v0);
}
call.v(v0);
return;
`;

const SAVE_GAME_LOGIC_1 = `
#message 1 "init room"
if (isset(f5)) {
  assignn(v50, 1);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  assignn(v100, 11);
  accept.input();
  print(1);
}
if (said("save")) { save.game(); }
if (said("mutate")) { assignn(v100, 22); }
if (said("restore")) { restore.game(); }
return;
`;

test("save -> mutate -> restore replays the saved resource sequence, not the room logic", () => {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(SAVE_GAME_LOGIC_0, { dictionary: DICT }).payload);
  container.putResource("logic", 1, assembleLogic(SAVE_GAME_LOGIC_1, { dictionary: DICT }).payload);
  container.putResource("picture", 1, PICTURE_1);
  const host = new TestHost();
  const engine = new Engine(container, host, DICT);
  host.engine = engine;

  engine.tick(); // boot: room 1 init, v100 = 11
  assert.equal(engine.vars[100], 11);
  assert.equal(host.prints.length, 1);

  host.inputQueue.push("save");
  engine.tick();
  assert.notEqual(host.saved, null, "save.game handed a snapshot to the host");

  host.inputQueue.push("mutate");
  engine.tick();
  assert.equal(engine.vars[100], 22, "mutation visible before restore");

  host.inputQueue.push("restore");
  engine.tick();
  assert.equal(engine.vars[100], 11, "saved state replaced the mutation");
  assert.equal(engine.vars[0], 1, "restored room");
  // Authentic restore does NOT re-enter the room: it replaces game-visible
  // state and replays the recorded resource sequence, so the room's new-room
  // init block never runs again and its message is not printed a second time
  // (spec "Restore action outcomes").
  assert.equal(host.prints.length, 1, "room logic did not re-run its new-room init");
  // The replayed sequence rebuilt the picture. PICTURE_1's box outline runs
  // (10,10)-(60,10)-(60,40)-(10,40)-(10,10) in visual colour 1, so its left
  // edge puts colour 1 at (10,20) on a surface that reset() filled with 15.
  assert.equal(engine.surface.visual[20 * SCREEN_WIDTH + 10], 1, "replay redrew the picture");
});

test("random stays inside the inclusive low..high range", () => {
  const container = gameWith("random(5, 10, v100); return;");
  const engine = new Engine(container, new TestHost(), DICT);
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    engine.tick();
    const v = engine.vars[100]!;
    assert.ok(v >= 5 && v <= 10, `random out of range: ${v}`);
    seen.add(v);
  }
  assert.ok(seen.size > 1, "random is not a constant");
});

test("get.num stores the host-provided number; no host stores 0", () => {
  const source = '#message 1 "How many?"\nget.num(1, v100); return;';

  const host = new TestHost();
  host.promptNumberResult = 42;
  const engine = new Engine(gameWith(source), host, DICT);
  engine.tick();
  assert.equal(engine.vars[100], 42);

  const bare = new Engine(
    gameWith(source),
    new (class implements EngineHost {
      print(): void {}
      displayAt(): void {}
      statusLine(): void {}
      takeInputLine(): string | null {
        return null;
      }
      takeKeys(): number[] {
        return [];
      }
    })(),
    DICT,
  );
  bare.tick();
  assert.equal(bare.vars[100], 0, "no promptNumber host -> stores 0");
});

test("get.string stores the host reply truncated to max length", () => {
  const source = '#message 1 "Name?"\nget.string(s1, 1, 0, 0, 10); return;';
  const host = new TestHost();
  host.promptStringResult = "hello world";
  const engine = new Engine(gameWith(source), host, DICT);
  engine.tick();
  assert.equal(engine.strings[1], "hello worl");
});

test("show.pri.screen pauses the interpreter until ackPrint", () => {
  const container = gameWith('#message 1 "hello"\nshow.pri.screen();\nprint(1);\nreturn;');
  const host = new TestHost();
  const engine = new Engine(container, host, DICT);
  host.engine = engine;

  engine.tick();
  assert.equal(host.showPriCalls, 1);
  assert.deepEqual(host.prints, [], "the following print waits for acknowledgement");

  engine.tick();
  assert.equal(host.showPriCalls, 1, "paused: logic 0 does not re-run");
  assert.equal(host.prints.length, 0);

  engine.ackPrint();
  engine.tick();
  assert.equal(host.showPriCalls, 1, "acknowledged: the existing invocation resumes");
  assert.deepEqual(host.prints, ["hello"]);
});

test("status lists carried items with names from the OBJECT file", () => {
  // OBJECT metadata: 2 items, "sword" and "key" (XOR "Avis Durgan" on disk).
  const plain = new Uint8Array([
    6,
    0,
    21, // table size 6 (2 items), max object index 21
    6,
    0,
    0, // item 0: name at pool+0, location 0
    12,
    0,
    0, // item 1: name at pool+6, location 0
    ...[..."sword\0key\0"].map((c) => c.charCodeAt(0)),
  ]);
  const encrypted = plain.map((b, i) => b ^ MESSAGE_KEY.charCodeAt(i % MESSAGE_KEY.length));
  const files = new Map(createContainer().files);
  files.set("OBJECT", encrypted);
  const container = openContainer(files);
  container.putResource(
    "logic",
    0,
    assembleLogic("get(0);\nget(1);\nstatus();\nreturn;", { dictionary: DICT }).payload,
  );

  const host = new TestHost();
  const engine = new Engine(container, host, DICT);
  host.engine = engine;
  engine.tick();

  assert.deepEqual(host.statusItems, [
    { num: 0, name: "sword" },
    { num: 1, name: "key" },
  ]);
});

test("log, obj.status.v, show.mem and pause route to the host", () => {
  const container = gameWith(
    '#message 1 "note"\nassignn(v50, 3);\nlog(1);\nobj.status.v(v50);\nshow.mem();\npause();\nreturn;',
  );
  const host = new TestHost();
  const engine = new Engine(container, host, DICT);
  host.engine = engine;
  engine.tick();

  assert.deepEqual(host.logs[0], "note", "log expands and routes the message");
  assert.match(host.logs[1]!, /^obj 3: x=\d+ y=\d+ w=\d+ h=\d+ pri=\d+ step=\d+$/);
  assert.match(
    host.logs[2]!,
    /^heap size: \d+\ncurrent\/max use: \d+\/\d+\nmaximum script use: \d+\nrm\.0, etc\.: \d+$/,
  );
  assert.deepEqual(
    host.prints,
    ["Game paused. Press ENTER to continue."],
    "pause shows the fixed message",
  );
});

test("version stores the host string, or the engine fallback, into slot 0", () => {
  const source = "version(); return;";
  const host = new TestHost();
  (host as { versionString?: () => string }).versionString = () => "test-interp 9.9";
  const engine = new Engine(gameWith(source), host, DICT);
  engine.tick();
  assert.equal(engine.strings[0], "test-interp 9.9");

  const bare = new Engine(gameWith(source), new TestHost(), DICT);
  bare.tick();
  assert.equal(bare.strings[0], "AGI IS HERE 1.0.0");
});
