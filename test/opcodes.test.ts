import { test } from "node:test";
import assert from "node:assert/strict";
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
});

test("F-motion-10: new.room preserves newlyPositioned and cycleDelay only on verified profiles (2.936, 3.002.149)", () => {
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
    const expected = id === "2.936" || id === "3.002.149";
    assert.equal(profile.newRoomPreservesReposAndCycleDelay, expected, id);
    assert.equal(o1.newlyPositioned, expected, `${id}: newlyPositioned across new.room`);
    assert.equal(o1.cycleDelay, expected, `${id}: cycleDelay across new.room`);
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

test("F-picture-04: show.pri.screen preserves text window only on verified profiles (2.936, 3.002.086)", () => {
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
    assert.equal(host.showPriCalls, 1, id);
    engine.ackPrint();
    const expected = id === "2.936" || id === "3.002.086";
    assert.equal(profile.showPriScreenPreservesWindow, expected, id);
    assert.equal(
      engine.getPresentation().windowOverlay.some((b) => b !== 0),
      expected,
      `${id}: windowOverlay after show.pri.screen`,
    );
  }
});

test("F-VIEWS-03, F-VIEWS-04, F-VIEWS-09: add.to.pic relocation (2.936, 3.002.086) and byte packing (2.440, 2.936, 3.002.086) apply on their verified profiles", () => {
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
         show.pic();
         return;`,
        { dictionary: DICT, profile },
      ).payload,
    );
    const engine = new Engine(container, new TestHost(), DICT, { profile });
    engine.tick();

    const verifiedReloc = id === "2.936" || id === "3.002.086";
    const verifiedPacking = id === "2.440" || id === "2.936" || id === "3.002.086";
    assert.equal(profile.addToPicRelocation, verifiedReloc, `${id}.addToPicRelocation`);
    assert.equal(profile.addToPicPacking, verifiedPacking, `${id}.addToPicPacking`);
    if (verifiedReloc) {
      assert.equal(engine.surface.visual[3 * 160 + 156], 2, `${id}: relocated cel at (156,3)`);
      assert.equal(
        engine.surface.priority[3 * 160 + 156],
        1,
        `${id}: relocated control box at (156,3)`,
      );
    } else {
      assert.equal(engine.surface.priority[3 * 160 + 156], 4, `${id}: no relocation to y=3`);
      assert.equal(
        engine.surface.priority[1 * 160 + 158],
        1,
        `${id}: control box at un-relocated (158,1)`,
      );
    }
    if (verifiedPacking) {
      assert.equal(
        engine.surface.priority[80 * 160 + 20],
        5,
        `${id}: packed 0x45 > 0x3f skips box`,
      );
    } else {
      assert.equal(
        engine.surface.priority[80 * 160 + 20],
        0,
        `${id}: margin 0 < 4 stamps control box 0`,
      );
    }
  }
});

test("F-VIEWS-05, F-VIEWS-07: in-place cel clipping and 4-bit priority mask apply only on verified profile (2.936)", () => {
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
    const o1 = engine.screenObjects[1]!;
    o1.x = 20;
    o1.y = 1;
    const frame = engine.getFrame();
    const verified = id === "2.936";
    assert.equal(profile.originalCelBlitClippingAndPriorityMask, verified, id);
    if (verified) {
      assert.equal(frame.visual[0 * 160 + 20], 6, `${id}: negative top clipped in place at x=20`);
      assert.equal(frame.visual[0 * 160 + 19], 15, `${id}: x=19 untouched`);
      assert.equal(frame.priority[0 * 160 + 20], 7, `${id}: priority 23 (0x17) masked to 7`);
    } else {
      assert.equal(frame.visual[0 * 160 + 19], 5, `${id}: negative top shifted left to x=19`);
      assert.equal(frame.priority[0 * 160 + 19], 23, `${id}: priority 23 unmasked`);
    }
  }
});

test("F-VIEWS-12: narrow add.to.pic cels wrap the top-row control-box counter in 8-bit CL", () => {
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
});

test("F-motion-12: placement exhaustion raises y to horizon+1 and stalls visibly without throwing", () => {
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
         obj.on.water(o0);
         obj.on.land(o0);
         draw(o0);
         assignn(v51, 99);
       }
       assignn(v52, 77);
       return;`,
      { dictionary: DICT },
    ).payload,
  );
  const engine = new Engine(container, new TestHost(), DICT);
  assert.doesNotThrow(() => engine.tick());
  const ego = engine.screenObjects[0]!;
  assert.equal(ego.y, 37, "FindPosn raises y <= horizon (36) to horizon + 1 (37) before spiral");
  assert.equal(ego.active, false, "draw stalled inside FindPosn before marking object active");
  assert.equal(engine.vars[51], 0, "instructions after stalled draw do not run");
  assert.equal(engine.vars[52], 0, "logic does not continue past stalled draw");
  assert.doesNotThrow(() => engine.tick());
  assert.equal(engine.vars[52], 0, "subsequent ticks remain visibly stalled");
});

test("F-VIEWS-11: show.obj on a descriptionless view (vdesc == 0) prints the raw view header prefix", () => {
  const container = createContainer();
  // Raw view with header bytes [0x41 ('A'), 0x42 ('B'), 1 loop, vdesc=0x0000]
  const rawView = buildView({
    loops: [{ cels: [{ width: 1, height: 1, pixels: [2] }] }],
  });
  rawView[0] = 0x41;
  rawView[1] = 0x42;
  container.putResource("view", 1, rawView);
  container.putResource(
    "logic",
    0,
    assembleLogic(`if (!isset(f200)) { set(f200); show.obj(1); } return;`, {
      dictionary: DICT,
    }).payload,
  );
  const host = new TestHost();
  const engine = new Engine(container, host, DICT);
  engine.tick();
  assert.equal(engine.modalKind, "showObj");
  assert.equal(engine.textRow(3).trim(), "AB#");
});

test("F-Parser-09: word.to.string writes empty string on unpopulated slots 0..9 and reads DS+numWords on slot 10", () => {
  const dict = new Map([
    ["look", 10],
    ["around", 20],
    ["room", 30],
  ]);
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `if (!isset(f200)) {
         set(f200);
         set.game.id("KQ3");
         set.string(s1, "NONEMPTY");
         set.string(s2, "NONEMPTY");
         set.string(s3, "look");
         parse(s3);
         word.to.string(s1, 1);
         word.to.string(s2, 10);
         set.string(s4, "look around");
         parse(s4);
         word.to.string(s5, 10);
         set.string(s6, "look around room");
         parse(s6);
         word.to.string(s7, 10);
       }
       return;`,
      { dictionary: dict },
    ).payload,
  );
  const engine = new Engine(container, new TestHost(), dict);
  engine.tick();
  assert.equal(engine.strings[1], "", "unpopulated slot 1 reads DS:0x0000 == 0x00 -> empty");
  assert.equal(engine.strings[2], "", "slot 10 with numWords=1 reads DS:0x0001 == 0x00 -> empty");
  assert.equal(engine.strings[5], "KQ3", "slot 10 with numWords=2 reads DS:0x0002 (gameID)");
  assert.equal(engine.strings[7], "Q3", "slot 10 with numWords=3 reads DS:0x0003 (gameID+1)");
});

test("F-motion-07: direction > 8 is stationary in ChkBlock and indexes adjacent AGIDATA.OVL tables in Animate and MoveObjs", () => {
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
         block(10, 70, 30, 90);
         observe.blocks(o0);
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
  // Animate indexes twoLoop[9] == 0, switching loop from 1 to 0.
  // MoveObjs indexes xs[9] = ys[0] = 0 and ys[9] = moveObjDir[0] = 8, moving y by 2 * 8 = +16.
  assert.equal(ego.direction, 9);
  assert.equal(ego.loop, 0, "twoLoop[9] == 0 selects loop 0");
  assert.equal(ego.x, 20, "xs[9] == 0 leaves x at 20");
  assert.equal(ego.y, 96, "ys[9] == 8 moves y from 80 to 80 + 2*8 = 96");
  // Next tick runs pre-logic ChkBlock with direction 9 and stepCount 1:
  // ChkBlock checks 1..8 so direction 9 is not zeroed by the block boundary.
  engine.tick();
  assert.equal(ego.direction, 9, "ChkBlock ignores direction > 8");
  assert.equal(ego.y, 112, "second pass moves y by another +16 to 112");
});

test("F-motion-16: set.loop and set.cel bounds and Error(errNum, errVal) re-entry into Logic 0", () => {
  // 1. set.loop without a loaded view -> Error(6, objIndex); set.cel without view -> Error(10, objIndex)
  // 2. set.loop(o0, loop > loopCnt) -> Error(5, objIndex); set.cel(o0, cel >= celCnt) -> Error(8, objIndex)
  for (const [action, expectedErr, expectedObj] of [
    ["set.loop(o1, 0);", 6, 1],
    ["set.cel(o1, 0);", 10, 1],
    ["set.loop(o0, 3);", 5, 0],
    ["set.cel(o0, 2);", 8, 0],
  ] as const) {
    const container = createContainer();
    container.putResource(
      "view",
      1,
      buildView({
        loops: [
          {
            cels: [
              { width: 2, height: 1, pixels: [1, 1] },
              { width: 3, height: 2, pixels: [2, 2, 2, 2, 2, 2] },
            ],
          },
          { cels: [{ width: 4, height: 1, pixels: [3, 3, 3, 3] }] },
        ],
      }),
    );
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `if (greatern(v17, 0)) {
           assignv(v50, v17);
           assignv(v51, v18);
           assignn(v17, 0);
           return;
         }
         if (!isset(f200)) {
           set(f200);
           load.view(1);
           animate.obj(o0);
           set.view(o0, 1);
           ${action}
           assignn(v52, 99);
         }
         return;`,
        { dictionary: DICT },
      ).payload,
    );
    const engine = new Engine(container, new TestHost(), DICT);
    engine.tick();
    assert.equal(engine.vars[50], expectedErr, `${action}: v17 error number`);
    assert.equal(engine.vars[51], expectedObj, `${action}: v18 object index`);
    assert.equal(engine.vars[52], 0, `${action}: longjmp aborted post-error instructions`);
    assert.equal(engine.vars[8], 255, `${action}: ResetHeap sets v8=255`);
  }

  // 3a. set.loop(o0, loopCnt) passes `cmp loopCnt, loop; jnc`, reads 1 word past the loop table
  // (offset 7..8 = [20, 0] -> loopOffset 20 with [1 cel, rel 3, width 5, height 3]), clamps cel to 0,
  // and clips position using width=5, height=3 without raising Error(5).
  {
    const container = createContainer();
    container.putResource(
      "view",
      1,
      new Uint8Array([
        1, 1, 1, 0, 0, 9, 0, 20, 0, 2, 5, 0, 5, 0, 2, 1, 0, 0x12, 0, 0, 1, 3, 0, 5, 3, 0, 0x15, 0,
      ]),
    );
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `if (!isset(f200)) {
           set(f200);
           load.view(1);
           animate.obj(o0);
           set.view(o0, 1);
           position(o0, 158, 1);
           set.cel(o0, 1);
           set.loop(o0, 1);
           current.loop(o0, v53);
           current.cel(o0, v54);
           get.posn(o0, v55, v56);
         }
         return;`,
        { dictionary: DICT },
      ).payload,
    );
    const engine = new Engine(container, new TestHost(), DICT);
    engine.tick();
    assert.equal(engine.vars[17], 0, "loop == loopCnt with celCnt=1 at loopOffset does not fault");
    assert.equal(engine.vars[53], 1, "current.loop is 1");
    assert.equal(engine.vars[54], 0, "cel clamped from 1 to 0");
    assert.equal(engine.vars[55], 155, "clipped right using width=5 (160 - 5)");
    assert.equal(engine.vars[56], 37, "clipped top (y=1 < height-1=2 -> 2 <= horizon 36 -> 37)");
  }

  // 3b. When the word 1 past the loop table points to celCnt == 0 (offset 7..8 = [19, 0] -> 0),
  // SetLoop passes Error(5) and SetCel faults with Error(8, 0).
  {
    const container = createContainer();
    container.putResource(
      "view",
      1,
      new Uint8Array([1, 1, 1, 0, 0, 9, 0, 19, 0, 1, 3, 0, 2, 1, 0, 0x12, 0, 0, 0, 0]),
    );
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `if (!isset(f200)) {
           set(f200);
           load.view(1);
           animate.obj(o0);
           set.view(o0, 1);
           set.loop(o0, 1);
         }
         return;`,
        { dictionary: DICT },
      ).payload,
    );
    const engine = new Engine(container, new TestHost(), DICT);
    engine.tick();
    assert.equal(
      engine.vars[17],
      8,
      "loop == loopCnt with celCnt=0 at loopOffset faults in SetCel with Error(8)",
    );
    assert.equal(engine.vars[18], 0);
  }
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
