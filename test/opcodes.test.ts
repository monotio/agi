import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSessionState } from "../src/agent/agentState.ts";
import { Simulation } from "../src/agent/playtest.ts";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { MESSAGE_KEY } from "../src/logic/resource.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { AGI_KEY } from "../src/runtime/keys.ts";
import { PROFILES, type ProfileId } from "../src/runtime/profile.ts";
import { SCREEN_WIDTH } from "../src/types.ts";
import { buildView } from "../src/view/view.ts";

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

/** 1 loop, 1 cel: a solid width x height block of color 5 (width at most 15). */
function solidView(width: number, height: number): Uint8Array {
  const rows = Array.from({ length: height }, () => [0x50 | width, 0]).flat();
  return new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, width, height, 0, ...rows]);
}

test("add.to.pic substitutes the baseline band for a zero priority operand", () => {
  // docs/fidelity.md, "Original add.to.pic control box": a priority operand
  // whose low nibble is zero takes the baseline's band. At y=100 with the
  // default base of 48 the band is 9, so the cel wins over a destination
  // priority of 8 that a literal zero would lose to.
  const container = gameWith(`
    load.view(0);
    add.to.pic(0, 0, 0, 40, 100, 0, 4);
    return;
  `);
  container.putResource("view", 0, VIEW_3PX);
  const engine = new Engine(container, new TestHost(), DICT);
  for (const x of [40, 41, 42]) engine.surface.priority[100 * SCREEN_WIDTH + x] = 8;
  engine.tick();
  for (const x of [40, 41, 42]) {
    assert.equal(engine.surface.visual[100 * SCREEN_WIDTH + x], 5, `visual at x=${x}`);
    assert.equal(engine.surface.priority[100 * SCREEN_WIDTH + x], 9, `priority at x=${x}`);
  }
});

test("add.to.pic outlines a control box as tall as the baseline's priority band", () => {
  // docs/fidelity.md, "Original add.to.pic control box". With the default
  // priority base of 48, band 9 is rows 96..107 (5 + floor((y - 48) * 10 / 120)).
  const container = gameWith(`
    load.view(0);
    load.view(1);
    add.to.pic(0, 0, 0, 40, 100, 15, 1);
    add.to.pic(1, 0, 0, 80, 107, 15, 3);
    return;
  `);
  container.putResource("view", 0, solidView(5, 20));
  container.putResource("view", 1, solidView(6, 3));
  const engine = new Engine(container, new TestHost(), DICT);
  engine.tick();
  const at = (x: number, y: number): number => engine.surface.priority[y * SCREEN_WIDTH + x]!;

  // Rows 100..96 lie in the baseline's band: five rows, fewer than the cel's twenty.
  for (let x = 40; x <= 44; x++) assert.equal(at(x, 100), 1, `bottom row x=${x}`);
  for (let y = 96; y <= 99; y++) {
    assert.equal(at(40, y), 1, `left column y=${y}`);
    assert.equal(at(44, y), 1, `right column y=${y}`);
  }
  for (let x = 41; x <= 43; x++) assert.equal(at(x, 96), 1, `top row x=${x}`);
  assert.equal(at(42, 98), 15, "the interior keeps the cel's priority");
  assert.equal(at(40, 95), 15, "the box stops at the band's top row");
  assert.equal(at(39, 98), 4, "nothing is stamped outside the cel");

  // Twelve band rows above y=107, but the cel is three rows tall.
  for (let x = 80; x <= 85; x++) assert.equal(at(x, 107), 3, `short bottom row x=${x}`);
  assert.equal(at(80, 106), 3);
  assert.equal(at(85, 106), 3);
  for (let x = 80; x <= 85; x++) assert.equal(at(x, 105), 3, `short top row x=${x}`);
  assert.equal(at(82, 106), 15, "short interior");
  assert.equal(at(80, 104), 4, "nothing above a three-row cel");
});

test("show.obj formats the view description like any printed message", () => {
  // docs/fidelity.md, "Original show.obj description formatting". The
  // description follows the cel data; header bytes 3..4 hold its offset.
  const description = [..."account number %v48"].map((ch) => ch.charCodeAt(0));
  const view = new Uint8Array([0, 0, 1, 15, 0, 7, 0, 1, 3, 0, 3, 1, 0, 0x53, 0, ...description, 0]);
  const container = gameWith(`
    assignn(v48, 137);
    show.obj(0);
    return;
  `);
  container.putResource("view", 0, view);
  const engine = new Engine(container, new TestHost(), DICT);
  engine.tick();
  const screen = Array.from({ length: 25 }, (_, row) => engine.textRow(row)).join("\n");
  assert.match(screen, /account number 137/);
  assert.doesNotMatch(screen, /%v48/);
});

test("message codes expand in one pass with recursive inserts, as the original formatter does", () => {
  // docs/fidelity.md, "Original message formatter". The %v value 142 must not
  // complete the preceding %m1 into %m142; %m and %s contents are formatted;
  // an unknown letter is dropped; %g reads logic 0's messages.
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `
      #message 1 "zero-%v48"
      #message 2 "unused"
      if (!isset(f200)) { set(f200); assignn(v48, 142); set.string(s1, "in %v48"); call(1); }
      return;
      `,
      { dictionary: DICT },
    ).payload,
  );
  container.putResource(
    "logic",
    1,
    assembleLogic(
      `
      #message 1 "one"
      #message 2 "%m1%v48 <%s1> %q %g1"
      print(m2);
      return;
      `,
      { dictionary: DICT },
    ).payload,
  );
  const host = new TestHost();
  const engine = new Engine(container, host, DICT);
  engine.tick();
  assert.deepEqual(host.prints, ["one142 <in 142>  zero-142"]);
});

test("v8 reports ample free memory from boot on and after a script overwrites it", () => {
  // docs/fidelity.md, "Free memory in v8": Gold Rush refuses the bible and
  // the help menu below eight pages.
  const container = gameWith(`
    if (!isset(f200)) { set(f200); assignv(v100, v8); assignn(v8, 1); }
    return;
  `);
  const engine = new Engine(container, new TestHost(), DICT);
  assert.equal(engine.vars[8], 255, "set before the first logic runs");
  engine.tick();
  assert.equal(engine.vars[100], 255);
  engine.tick();
  assert.equal(engine.vars[8], 255, "refreshed each cycle like the original's heap measure");
});

test("add.to.pic paints its colour over control pixels but keeps their control value", () => {
  // docs/fidelity.md, "Original cel blit over control pixels". PICTURE_1 has no
  // control pixels; the test seeds a control-2 trigger column under the cel.
  const container = gameWith(`
    load.view(0);
    add.to.pic(0, 0, 0, 40, 100, 7, 4);
    return;
  `);
  container.putResource("view", 0, solidView(3, 4));
  const engine = new Engine(container, new TestHost(), DICT);
  // Seed before the first tick: the engine's surface persists across ticks.
  for (let y = 97; y <= 100; y++) engine.surface.priority[y * SCREEN_WIDTH + 41] = 2;
  engine.tick();
  const at = (x: number, y: number): number => engine.surface.priority[y * SCREEN_WIDTH + x]!;
  for (let y = 97; y <= 100; y++) {
    assert.equal(at(41, y), 2, `trigger survives at y=${y}`);
    assert.equal(engine.surface.visual[y * SCREEN_WIDTH + 41], 5, `colour painted at y=${y}`);
    assert.equal(at(40, y), 7, `plain pixel takes the cel priority at y=${y}`);
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
  engine.tick();

  assert.deepEqual(host.logs[0], "note", "log expands and routes the message");
  // obj.status.v opens the original's message box: the pass suspends until a
  // key acknowledges it (docs/fidelity.md, "Original obj.status.v modal").
  assert.equal(engine.modalKind, "print");
  assert.deepEqual(
    host.prints[0],
    "Object 3:\nx: 0  xsize: 0\ny: 0  ysize: 0\npri: 0\nstepsize: 0",
  );
  engine.modalKey(AGI_KEY.ENTER);
  engine.tick();
  assert.match(
    host.logs[1]!,
    /^heap size: \d+\ncurrent\/max use: \d+\/\d+\nmaximum script use: \d+\nrm\.0, etc\.: \d+$/,
  );
  assert.deepEqual(
    host.prints.slice(1),
    ["Game paused. Press ENTER to continue."],
    "pause shows the fixed message",
  );
});

test("version prints the host string, or the binary-verified interpreter banner per profile, without overwriting slot 0", () => {
  const source = 'set.string(s0, ">"); version(); return;';
  const host = new TestHost();
  (host as { versionString?: () => string }).versionString = () => "test-interp 9.9";
  const engine = new Engine(gameWith(source), host, DICT);
  engine.tick();
  assert.deepEqual(host.prints, ["test-interp 9.9"]);
  assert.equal(engine.strings[0], ">");

  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    const profile = PROFILES[id];
    const bareHost = new TestHost();
    const container = createContainer();
    container.putResource("logic", 0, assembleLogic(source, { dictionary: DICT, profile }).payload);
    const bare = new Engine(container, bareHost, DICT, { profile });
    bare.tick();
    const expectedVersion = id.replace(/^(amiga|iigs)-/, "");
    const expectedSuffix = id === "2.001" ? "\n" : "";
    assert.deepEqual(
      bareHost.prints,
      [`Adventure Game Interpreter\n      Version ${expectedVersion}${expectedSuffix}`],
      `${id}: exact version() banner`,
    );
    assert.equal(bare.strings[0], ">");
  }

  // Detected Amiga and IIgs editions supply prefixed profileBuild identifiers;
  // both Engine and PlaytestSession must strip the amiga-/iigs- prefix.
  const detectedCases: {
    file: [string, Uint8Array];
    expectedBuild: string;
    expectedBanner: string;
  }[] = [
    {
      file: ["KQ2", new Uint8Array([0x00, 0x00, 0x03, 0xf3])],
      expectedBuild: "amiga-2.176",
      expectedBanner: "Adventure Game Interpreter\n      Version 2.176",
    },
    {
      file: [
        "SQ2.SYS16",
        new TextEncoder().encode("Adventure Game Interpreter\n      Version 1.014"),
      ],
      expectedBuild: "iigs-1.014",
      expectedBanner: "Adventure Game Interpreter\n      Version 1.014",
    },
    {
      file: ["AGIDATA.OVL", new TextEncoder().encode("Version 2.915")],
      expectedBuild: "2.915",
      expectedBanner: "Adventure Game Interpreter\n      Version 2.915",
    },
  ];
  for (const { file, expectedBuild, expectedBanner } of detectedCases) {
    const base = createContainer();
    base.putResource("logic", 0, assembleLogic(source, { dictionary: DICT }).payload);
    const files = new Map(base.files);
    files.set(file[0], file[1]);
    const detectedContainer = openContainer(files);
    const detectedHost = new TestHost();
    const detectedEngine = new Engine(detectedContainer, detectedHost, DICT);
    assert.equal(detectedEngine.profileKind, "binary");
    assert.equal(detectedEngine.profileBuild, expectedBuild);
    detectedEngine.tick();
    assert.deepEqual(detectedHost.prints, [expectedBanner], `${expectedBuild}: Engine version()`);

    const session = new Simulation(createAgentSessionState(detectedContainer));
    session.tick();
    assert.deepEqual(session.messages, [expectedBanner], `${expectedBuild}: Simulation`);
  }
});

test("F-motion-10: new.room preserves newlyPositioned and cycleDelay across all 18 binary-verified profiles", () => {
  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    const profile = PROFILES[id];
    const container = createContainer();
    container.putResource("picture", 1, new Uint8Array([0xff]));
    container.putResource("picture", 2, new Uint8Array([0xff]));
    container.putResource(
      "view",
      1,
      new Uint8Array([0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 1, 0x0f, 0x21, 0x00]),
    );
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `if (!isset(f200)) {
           set(f200);
           load.view(1);
           animate.obj(o1);
           set.view(o1, 1);
           position(o1, 40, 80);
           return;
         }
         if (equaln(v80, 1)) {
           assignn(v80, 2);
           new.room(2);
         }
         return;`,
        { dictionary: DICT, profile },
      ).payload,
    );
    container.putResource(
      "logic",
      2,
      assembleLogic("return;", { dictionary: DICT, profile }).payload,
    );
    const engine = new Engine(container, new TestHost(), DICT, { profile });
    engine.execute(0);
    const o1 = engine.screenObjects[1]!;
    o1.newlyPositioned = true;
    o1.cycleDelay = true;
    o1.active = true;
    o1.update = true;
    engine.vars[80] = 1;
    engine.tick();
    assert.equal(engine.readState().room, 2, id);
    assert.equal(o1.newlyPositioned, true, `${id}: newlyPositioned across new.room`);
    assert.equal(o1.cycleDelay, true, `${id}: cycleDelay across new.room`);
    assert.equal(o1.active, false, `${id}: active cleared across new.room`);
    assert.equal(o1.update, false, `${id}: update cleared across new.room`);
  }
});

test("F-IN-15: DoMenu Home and End select disabled endpoints only on verified profile (2.936)", () => {
  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    const profile = PROFILES[id];
    if (profile.menuActions !== "full" || profile.menuInputAction !== "effect") continue;
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `if (!isset(f200)) {
           set(f200);
           set.menu("LeftDisabled");
           set.menu("MiddleEnabled");
           set.menu.item("ItemM1", c11);
           set.menu.item("ItemM2", c12);
           set.menu("RightDisabled");
           submit.menu();
           set(f14);
         }
         if (equaln(v80, 1)) { assignn(v80, 0); menu.input(); }
         return;`,
        { dictionary: DICT, profile },
      ).payload,
    );
    if (profile.menuInteractionGate) {
      // allow.menu(1) is enabled by default on v3
    }
    const host = new TestHost();
    const engine = new Engine(container, host, DICT, { profile });
    engine.tick();
    engine.vars[80] = 1;
    engine.tick();
    engine.tick();
    assert.equal(engine.modalKind, "menu", id);
    assert.equal(engine.readMenuState().heading, 1, id);
    const unconditional = id === "2.936";
    assert.equal(profile.menuHomeEndUnconditional, unconditional, id);
    engine.modalKey(0x4f00);
    assert.equal(engine.readMenuState().heading, unconditional ? 2 : 1, `${id}: End key`);
    engine.modalKey(0x4700);
    assert.equal(engine.readMenuState().heading, unconditional ? 0 : 1, `${id}: Home key`);
    if (unconditional) {
      engine.modalKey(0x4d00);
      assert.equal(engine.readMenuState().heading, 1, `${id}: Right arrow skips disabled`);
    }
  }
});

test("F-picture-04: show.pri.screen preserves the window state each profile's print leaves", () => {
  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    const profile = PROFILES[id];
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `#message 1 "Banner"
         set(f15);
         print(1);
         show.pri.screen();
         return;`,
        { dictionary: DICT, profile },
      ).payload,
    );
    const host = new TestHost();
    const engine = new Engine(container, host, DICT, { profile });
    host.engine = engine;
    engine.tick();
    // F-text-print-modes-early: early PC print blocks and closes on ack,
    // so show.pri.screen reaches an empty overlay on those profiles.
    const persistent = !["2.001", "2.089", "2.230", "2.272"].includes(id);
    assert.equal(
      engine.getPresentation().windowOverlay.some((b) => b !== 0),
      persistent,
      id,
    );
    assert.equal(host.showPriCalls, 1, id);
    engine.ackPrint();
    assert.equal(
      engine.getPresentation().windowOverlay.some((b) => b !== 0),
      persistent,
      `${id}: windowOverlay after show.pri.screen`,
    );
  }
});

test("F-VIEWS-03, F-VIEWS-04, F-VIEWS-09: add.to.pic relocation and byte packing apply across all 18 binary-verified profiles, and 2.001 keeps priority 0", () => {
  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    const profile = PROFILES[id];
    const container = createContainer();
    container.putResource("picture", 1, new Uint8Array([0xf0, 15, 0xf8, 0, 0, 0xff]));
    // 4x4 opaque cel of color 2, transparent 15
    container.putResource(
      "view",
      1,
      new Uint8Array([
        0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 4, 4, 0x0f, 0x24, 0x00, 0x24, 0x00, 0x24, 0x00, 0x24, 0x00,
      ]),
    );
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `assignn(v50, 1); load.pic(v50); draw.pic(v50);
         load.view(1);
         add.to.pic(1, 0, 0, 158, 1, 0, 1);
         add.to.pic(1, 0, 0, 20, 80, 69, 0);
         add.to.pic(1, 0, 0, 40, 80, 0, 4);
         show.pic();
         return;`,
        { dictionary: DICT, profile },
      ).payload,
    );
    const engine = new Engine(container, new TestHost(), DICT, { profile });
    engine.tick();

    // In 2.001, ObjInPic (0x532a) calls InsertObj directly without substituting
    // pri_tbl[y] when (pri & 0x0f) == 0, so pri=0 draws with priority 0 (which loses
    // to background priority 4); on 2.089+ and Amiga/IIgs, pri=0 substitutes pri_tbl[y].
    if (id === "2.001") {
      assert.equal(engine.surface.visual[3 * 160 + 156], 15, `${id}: pri=0 occluded by bg pri 4`);
      assert.equal(engine.surface.priority[80 * 160 + 40], 4, `${id}: pri=0 leaves bg pri 4`);
    } else {
      assert.equal(engine.surface.visual[3 * 160 + 156], 2, `${id}: relocated cel at (156,3)`);
      assert.equal(
        engine.surface.priority[80 * 160 + 40],
        7,
        `${id}: pri=0 substitutes pri_tbl[80]=7`,
      );
    }
    assert.equal(
      engine.surface.priority[3 * 160 + 156],
      1,
      `${id}: relocated control box at (156,3)`,
    );
    assert.equal(engine.surface.priority[80 * 160 + 20], 5, `${id}: packed 0x45 > 0x3f skips box`);
  }
});

test("F-VIEWS-04: add.to.pic takes the band for a zero priority only where ObjInPic substitutes pri_tbl[y]", () => {
  // The 2.001 ObjInPic (0x532a) calls InsertObj without the substitution;
  // every later build substitutes. The profile field decides, not the build id.
  for (const id of Object.keys(PROFILES) as ProfileId[])
    assert.equal(PROFILES[id].addToPicBandForZeroPriority, id !== "2.001", id);
  for (const band of [true, false]) {
    const profile = { ...PROFILES["2.936"], addToPicBandForZeroPriority: band };
    const container = createContainer();
    container.putResource("picture", 1, new Uint8Array([0xf0, 15, 0xf8, 0, 0, 0xff]));
    container.putResource(
      "view",
      1,
      new Uint8Array([
        0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 4, 4, 0x0f, 0x24, 0x00, 0x24, 0x00, 0x24, 0x00, 0x24, 0x00,
      ]),
    );
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `assignn(v50, 1); load.pic(v50); draw.pic(v50); load.view(1);
         add.to.pic(1, 0, 0, 40, 80, 0, 4); show.pic(); return;`,
        { dictionary: DICT, profile },
      ).payload,
    );
    const engine = new Engine(container, new TestHost(), DICT, { profile });
    engine.tick();
    // Row 80 lies in the band of priority 7; priority 0 loses to the background 4.
    assert.equal(engine.surface.priority[80 * 160 + 40], band ? 7 : 4, `band ${band}`);
    assert.equal(engine.surface.visual[80 * 160 + 40], band ? 2 : 15, `band ${band}`);
  }
});

test("F-VIEWS-05, F-VIEWS-07: in-place cel clipping and 4-bit depth mask apply across all 18 binary-verified profiles", () => {
  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    const profile = PROFILES[id];
    const container = createContainer();
    container.putResource("picture", 1, new Uint8Array([0xf0, 15, 0xf8, 0, 0, 0xff]));
    // 1x3 cel with colors [5, 6, 7], transparent 0
    container.putResource(
      "view",
      1,
      new Uint8Array([
        0, 0, 1, 0, 0, 7, 0, 1, 3, 0, 1, 3, 0x00, 0x51, 0x00, 0x61, 0x00, 0x71, 0x00,
      ]),
    );
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `if (!isset(f200)) {
           set(f200);
           assignn(v50, 1); load.pic(v50); draw.pic(v50);
           load.view(1);
           animate.obj(o1);
           set.view(o1, 1);
           ignore.horizon(o1);
           set.priority(o1, 23);
           draw(o1);
           show.pic();
         }
         return;`,
        { dictionary: DICT, profile },
      ).payload,
    );
    const engine = new Engine(container, new TestHost(), DICT, { profile });
    engine.tick();
    engine.advanceClock(1000); // the Amiga and IIgs dissolve the picture in first
    const o1 = engine.screenObjects[1]!;
    o1.x = 20;
    o1.y = 1;
    const frame = engine.getFrame();
    assert.equal(profile.originalCelBlitClippingAndPriorityMask, true, id);
    assert.equal(frame.visual[0 * 160 + 20], 6, `${id}: negative top clipped in place at x=20`);
    assert.equal(frame.visual[0 * 160 + 19], 15, `${id}: x=19 untouched`);
    assert.equal(frame.priority[0 * 160 + 20], 7, `${id}: priority 23 (0x17) masked to 7`);
  }
});

test("F-VIEWS-12: narrow add.to.pic cels wrap the top-row control-box counter in 8-bit CL on PC and skip on Amiga/IIgs", () => {
  const container = createContainer();
  container.putResource("picture", 1, new Uint8Array([0xf0, 15, 0xf2, 4, 0xf8, 0, 0, 0xff]));
  // Loop 0 cel 0: 1x2 cel (color 2); cel 1: 2x2 cel (color 3)
  container.putResource(
    "view",
    1,
    buildView({
      loops: [
        {
          cels: [
            { width: 1, height: 2, pixels: [2, 2] },
            { width: 2, height: 2, pixels: [3, 3, 3, 3] },
          ],
        },
      ],
    }),
  );
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         assignn(v50, 1); load.pic(v50); draw.pic(v50);
         load.view(1);
         add.to.pic(1, 0, 0, 20, 80, 15, 1);
         show.pic();
       }
       return;`,
      { dictionary: DICT },
    ).payload,
  );
  const engine = new Engine(container, new TestHost(), DICT);
  engine.tick();
  // 1x2 cel at (20,80), priority 15, margin 1: rows=2, topY=79, CL=(1-2)&0xff=255.
  // Stamps 1 from di = 79*160 + 21 (21,79) through 79*160 + 20 + 255 = 12915 (115,80).
  assert.equal(engine.surface.priority[79 * 160 + 20], 1, "(20,79) left column");
  assert.equal(engine.surface.priority[79 * 160 + 21], 1, "(21,79) first top-row overrun pixel");
  assert.equal(engine.surface.priority[80 * 160 + 115], 1, "(115,80) 255th top-row overrun pixel");
  assert.equal(engine.surface.priority[80 * 160 + 116], 4, "(116,80) untouched beyond 255 steps");

  // 2x2 cel at (20,80), priority 15, margin 2: CL=(2-2)&0xff=0 -> 65536 loop iterations.
  container.putResource(
    "logic",
    1,
    assembleLogic(`add.to.pic(1, 0, 1, 20, 80, 15, 2); return;`, { dictionary: DICT }).payload,
  );
  engine.execute(1);
  assert.equal(engine.surface.priority[0], 2, "65536-iteration wrap reaches pixel 0");
  assert.equal(engine.surface.priority[26879], 2, "65536-iteration wrap reaches last pixel");

  // All 15 PC builds (2.001..3.002.149) wrap the 8086 CL counter (`mov cl, al; sub cl, 2; loop`);
  // Amiga (`subq.w #2, d2; bmi`) and IIgs (`sbc #$0002; tax; bmi`) skip the top-row interior loop
  // when width <= 2.
  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    const profile = PROFILES[id];
    const c = createContainer();
    c.putResource("picture", 1, new Uint8Array([0xf0, 15, 0xf2, 4, 0xf8, 0, 0, 0xff]));
    c.putResource(
      "view",
      1,
      buildView({
        loops: [{ cels: [{ width: 2, height: 2, pixels: [3, 3, 3, 3] }] }],
      }),
    );
    c.putResource(
      "logic",
      0,
      assembleLogic(
        `if (!isset(f200)) {
           set(f200);
           assignn(v50, 1); load.pic(v50); draw.pic(v50);
           load.view(1);
           add.to.pic(1, 0, 0, 20, 80, 15, 1);
           show.pic();
         }
         return;`,
        { dictionary: DICT, profile },
      ).payload,
    );
    const e = new Engine(c, new TestHost(), DICT, { profile });
    e.tick();
    assert.equal(
      e.surface.priority[0],
      profile.presentation === "pc" ? 1 : 4,
      `${id}: pixel 0 priority after 2x2 add.to.pic with margin 1`,
    );
  }
});

test("F-motion-12: FindPosn raises y <= horizon to horizon + 1 before spiral and throws when exhausted", () => {
  const container = createContainer();
  container.putResource("picture", 1, new Uint8Array([0xf0, 15, 0xf2, 4, 0xf8, 0, 0, 0xff]));
  container.putResource(
    "view",
    1,
    buildView({ loops: [{ cels: [{ width: 2, height: 2, pixels: [1, 1, 1, 1] }] }] }),
  );
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         assignn(v50, 1); load.pic(v50); draw.pic(v50);
         load.view(1);
         animate.obj(o0);
         set.view(o0, 1);
         position(o0, 20, 10);
         draw(o0);
       }
       return;`,
      { dictionary: DICT },
    ).payload,
  );
  const engine = new Engine(container, new TestHost(), DICT);
  engine.tick();
  const ego = engine.screenObjects[0]!;
  assert.equal(ego.x, 20, "FindPosn starts at x=20 after raising y to horizon + 1");
  assert.equal(ego.y, 37, "FindPosn raises y <= horizon (36) to horizon + 1 (37) before spiral");

  // When no valid position exists anywhere on the surface, placeObject throws safely.
  const exhausted = createContainer();
  exhausted.putResource("picture", 1, new Uint8Array([0xf0, 15, 0xf2, 4, 0xf8, 0, 0, 0xff]));
  exhausted.putResource(
    "view",
    1,
    buildView({ loops: [{ cels: [{ width: 2, height: 2, pixels: [1, 1, 1, 1] }] }] }),
  );
  exhausted.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         assignn(v50, 1); load.pic(v50); draw.pic(v50);
         load.view(1);
         animate.obj(o0);
         set.view(o0, 1);
         position(o0, 20, 10);
         obj.on.water(o0);
         obj.on.land(o0);
         draw(o0);
       }
       return;`,
      { dictionary: DICT },
    ).payload,
  );
  const exhaustedEngine = new Engine(exhausted, new TestHost(), DICT);
  assert.throws(() => exhaustedEngine.tick(), /no acceptable position/);
  assert.equal(
    exhaustedEngine.screenObjects[0]!.y,
    37,
    "y <= horizon (36) raised to horizon + 1 (37) before spiral",
  );
});

test("F-VIEWS-11: show.obj on a descriptionless view (vdesc == 0) prints the raw view header prefix across all 18 binary-verified profiles", () => {
  // Raw view with header bytes [0x41 ('A'), 0x42 ('B'), 1 loop, vdesc=0x0000]
  const rawView = buildView({
    loops: [{ cels: [{ width: 1, height: 1, pixels: [2] }] }],
  });
  rawView[0] = 0x41;
  rawView[1] = 0x42;
  for (const id of Object.keys(PROFILES) as (keyof typeof PROFILES)[]) {
    const profile = PROFILES[id];
    const container = createContainer();
    container.putResource("view", 1, rawView);
    container.putResource(
      "logic",
      0,
      assembleLogic(`if (!isset(f200)) { set(f200); show.obj(1); } return;`, {
        dictionary: DICT,
        profile,
      }).payload,
    );
    const host = new TestHost();
    const engine = new Engine(container, host, DICT, { profile });
    engine.tick();
    assert.equal(engine.modalKind, "showObj", `${id}: opens showObj modal`);
    const expectedRow = profile.presentation === "amiga" ? 2 : 3;
    assert.equal(
      engine.textRow(expectedRow).trim(),
      "AB#",
      `${id}: formats raw header prefix at vdesc==0`,
    );
  }
});

test("F-Parser-09: word.to.string indexes parsedWordTexts 0-based and clears unpopulated and out-of-bounds slots (including 10 and 14)", () => {
  const dict = new Map([
    ["look", 10],
    ["around", 20],
  ]);
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         set.game.id(1);
         set.string(s1, "NONEMPTY");
         set.string(s2, "NONEMPTY");
         set.string(s4, "NONEMPTY");
         set.string(s5, "NONEMPTY");
         set.string(s3, "look around");
         parse(s3);
         word.to.string(s0, 0);
         word.to.string(s1, 1);
         word.to.string(s2, 2);
         word.to.string(s4, 10);
         word.to.string(s5, 14);
       }
       return;
       #message 1 "TESTID"`,
      { dictionary: dict },
    ).payload,
  );
  const engine = new Engine(container, new TestHost(), dict);
  engine.tick();
  assert.equal(engine.parserCount, 2);
  assert.equal(engine.strings[0], "look");
  assert.equal(engine.strings[1], "around");
  assert.equal(engine.strings[2], "");
  assert.equal(engine.strings[4], "", "index 10 on populated parser clears to empty string");
  assert.equal(engine.strings[5], "", "index 14 on populated parser clears to empty string");
});

test("F-motion-07: direction > 8 is stationary and preserves loop selection", () => {
  const container = createContainer();
  container.putResource("picture", 1, new Uint8Array([0xf0, 15, 0xf2, 4, 0xf8, 0, 0, 0xff]));
  container.putResource(
    "view",
    1,
    buildView({
      loops: [
        { cels: [{ width: 2, height: 1, pixels: [1, 1] }] },
        { cels: [{ width: 2, height: 1, pixels: [2, 2] }] },
      ],
    }),
  );
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         assignn(v50, 1); load.pic(v50); draw.pic(v50);
         load.view(1);
         animate.obj(o0);
         set.view(o0, 1);
         set.loop(o0, 1);
         position(o0, 20, 80);
         assignn(v60, 2);
         step.size(o0, v60);
         assignn(v62, 1);
         step.time(o0, v62);
         draw(o0);
         program.control();
         assignn(v61, 9);
         set.dir(o0, v61);
         show.pic();
       }
       return;`,
      { dictionary: DICT },
    ).payload,
  );
  const engine = new Engine(container, new TestHost(), DICT);
  engine.tick();
  const ego = engine.screenObjects[0]!;
  assert.equal(ego.direction, 9);
  assert.equal(ego.loop, 1);
  assert.equal(ego.x, 20);
  assert.equal(ego.y, 80);
});

test("F-motion-16: invalid set.loop and set.cel store requested indices without error recovery and mh2 Logic 192 draws after valid loop", () => {
  const container = createContainer();
  container.putResource("picture", 1, new Uint8Array([0xf0, 15, 0xf2, 4, 0xf8, 0, 0, 0xff]));
  container.putResource(
    "view",
    69,
    buildView({
      loops: [
        {
          cels: [
            { width: 2, height: 1, pixels: [1, 1] },
            { width: 4, height: 1, pixels: [1, 1, 1, 1] },
          ],
        },
        { cels: [{ width: 3, height: 1, pixels: [2, 2, 2] }] },
      ],
    }),
  );
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         assignn(v50, 1); load.pic(v50); draw.pic(v50);
         load.view(69);
         animate.obj(o2);
         set.view(o2, 69);
         set.loop(o2, 5);
         set.cel(o2, 4);
         animate.obj(o3);
         set.view(o3, 69);
         set.cel(o3, 1);
         set.loop(o3, 2);
         position(o3, 40, 100);
         animate.obj(o4);
         set.loop(o4, 3);
         set.cel(o4, 2);
         assignn(v100, 1);
         return;
       }
       if (!isset(f201)) {
         set(f201);
         set.loop(o3, 1);
         draw(o3);
       }
       return;`,
      { dictionary: DICT },
    ).payload,
  );
  const engine = new Engine(container, new TestHost(), DICT);
  assert.doesNotThrow(() => engine.tick());
  assert.equal(engine.vars[17], 0, "no runtime error code latched in v17");
  assert.equal(engine.vars[18], 0, "no runtime error value latched in v18");
  assert.equal(engine.vars[100], 1, "logic pass completes without error-recovery longjmp");
  assert.equal(engine.screenObjects[2]!.loop, 5, "loop > loopCount stores requested loop");
  assert.equal(engine.screenObjects[2]!.cel, 4, "cel >= celCount stores requested cel");
  assert.equal(engine.screenObjects[3]!.loop, 2, "loop == loopCount stores requested loop");
  assert.equal(engine.screenObjects[3]!.cel, 0, "set.loop clamps cel >= celCount to 0");
  assert.equal(engine.screenObjects[3]!.width, 4, "invalid loop preserves prior cel width");
  assert.equal(engine.screenObjects[4]!.loop, 3, "set.loop without loaded view stores loop");
  assert.equal(engine.screenObjects[4]!.cel, 2, "set.cel without loaded view stores cel");

  assert.doesNotThrow(() => engine.tick());
  assert.equal(engine.screenObjects[3]!.active, true);
  assert.equal(engine.screenObjects[3]!.loop, 1);
  assert.equal(engine.screenObjects[3]!.width, 3);
});

test("F-text-04: off-screen print.at wraps at column 39 to textLeft and caps newlines at row 24", () => {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         print.at("ABCDEF", 5, 37, 10);
       }
       return;`,
      { dictionary: DICT },
    ).payload,
  );
  const engine = new Engine(container, new TestHost(), DICT);
  engine.tick();
  assert.equal(engine.textRow(6).slice(37, 40), "ABC", "first 3 chars on row 6 cols 37..39");
  assert.equal(
    engine.textRow(7).slice(37, 40),
    "DEF",
    "column 39 wrap continues on row 7 at col 37",
  );
  engine.ackPrint();
  assert.equal(engine.textRow(6).slice(37, 40), "   ", "CloseWndw restores the 1-row window box");
  assert.equal(
    engine.textRow(7).slice(37, 40),
    "DEF",
    "wrapped row outside the window box persists after dismissal",
  );

  const container2 = createContainer();
  container2.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         print.at("Row1\\nRow2", 23, 5, 10);
       }
       return;`,
      { dictionary: DICT },
    ).payload,
  );
  const engine2 = new Engine(container2, new TestHost(), DICT);
  engine2.tick();
  assert.equal(engine2.textRow(24).slice(5, 9), "Row2", "newline at row 24 stays on row 24");
});
