import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSessionState, buildObjectFile } from "../src/agent/tools.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { buildView } from "../src/view/view.ts";
import { playtestRoom, validateGenesis } from "../src/agent/playtest.ts";

function world(extra = "", room = 1) {
  const state = createAgentSessionState();
  const dictionary = new Map([
    ["take", 10],
    ["key", 11],
    ["leave", 12],
  ]);
  state.wordsPayload = buildWordsTok([...dictionary].map(([word, id]) => ({ word, id })));
  state.objectPayload = buildObjectFile([{ name: "Key", startingRoom: 1 }]);
  state.container.putResource(
    "view",
    0,
    buildView({
      loops: [{ cels: [{ width: 3, height: 2, transparentColor: 0, pixels: [1, 1, 1, 1, 1, 1] }] }],
    }),
  );
  state.container.putResource("picture", room, Uint8Array.of(0xf0, 2, 0xf8, 0, 0, 0xff));
  state.container.putResource(
    "logic",
    0,
    assembleLogic(`if (!isset(f200)) {set(f200);new.room(${room});} call.v(v0); return;`, {
      dictionary,
    }).payload,
  );
  state.container.putResource(
    "logic",
    room,
    assembleLogic(
      `
if (isset(f5)) {
 assignn(v10, ${room}); load.pic(v10); draw.pic(v10); show.pic();
 load.view(0); animate.obj(0); set.view(0,0); position(0,80,120); draw(0); accept.input();
}
if (said("take", "key")) {get(0);set(f30);}
${extra}
return;`,
      { dictionary },
    ).payload,
  );
  return state;
}

test("playtest runs commands and assertions in a detached real interpreter", () => {
  const state = world();
  const before = [...state.getFiles()].map(([name, bytes]) => [name, bytes.slice()]);
  const result = playtestRoom(state, {
    room: 1,
    steps: [{ action: "command", command: "take key" }],
    expect: { room: 1, carriedItems: [0], flags: [{ id: 30, value: true }] },
  });
  assert.equal(result.success, true, result.error ?? "");
  assert.equal(result.details?.["simulation"], "passed");
  assert.equal(result.details?.["spawnClear"], true);
  assert.equal(result.images?.length, 1);
  assert.deepEqual(
    Array.from(result.images![0]!.png.slice(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.deepEqual([...state.getFiles()], before);
  assert.equal(state.genesisComplete, false);
});

test("spawn checks the entire initialized ego baseline instead of one priority pixel", () => {
  const state = world();
  state.container.putResource("picture", 1, Uint8Array.of(0xf2, 0, 0xf6, 82, 120, 82, 120, 0xff));
  const result = playtestRoom(state, { room: 1, spawnX: 80, spawnY: 120 });
  assert.equal(result.success, false);
  assert.equal(result.details?.["spawnClear"], false);
  assert.match(result.error ?? "", /82.*120|baseline/);
});

test("movement reaches authored rooms and reports future missing rooms separately", () => {
  const state = world("if (equaln(v2,2)) {new.room(2);}");
  const missing = playtestRoom(state, {
    room: 1,
    spawnX: 156,
    spawnY: 120,
    steps: [{ action: "move", direction: "right", ticks: 8 }],
    expect: { room: 2 },
  });
  assert.equal(missing.success, false);
  assert.equal(missing.details?.["simulation"], "needs_authoring");
  assert.deepEqual(missing.details?.["missingRooms"], [2]);
  const dictionary = new Map([
    ["take", 10],
    ["key", 11],
    ["leave", 12],
  ]);
  state.container.putResource("picture", 2, Uint8Array.of(0xff));
  state.container.putResource(
    "logic",
    2,
    assembleLogic(
      "if (isset(f5)) {assignn(v10,2);load.pic(v10);draw.pic(v10);show.pic();load.view(0);animate.obj(0);set.view(0,0);position(0,10,120);draw(0);accept.input();} return;",
      { dictionary },
    ).payload,
  );
  const entered = playtestRoom(state, {
    room: 1,
    spawnX: 156,
    spawnY: 120,
    steps: [{ action: "move", direction: "right", ticks: 8 }],
    expect: { room: 2 },
  });
  assert.equal(entered.success, true, entered.error ?? "");
  assert.equal((entered.details?.["state"] as { room: number }).room, 2);
});

test("failed expected flags and carried items are reported with observed values", () => {
  const result = playtestRoom(world(), {
    room: 1,
    steps: [{ action: "wait", ticks: 1 }],
    expect: { flags: [{ id: 30, value: true }], carriedItems: [0] },
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /flag 30.*false/i);
  assert.match(result.error ?? "", /item 0.*room 1/i);
});

test("scripted Enter acknowledges a real modal before the next command", () => {
  const state = world('if (!isset(f31)) {set(f31);print("Welcome");}');
  const result = playtestRoom(state, {
    room: 1,
    steps: [{ action: "enter" }, { action: "command", command: "take key" }],
    expect: { carriedItems: [0] },
  });
  assert.equal(result.success, true, result.error ?? "");
  assert.ok((result.details?.["messages"] as string[]).includes("Welcome"));
});

test("genesis executes actual boot logic and accepts a start room other than one", () => {
  const state = world("", 7);
  const result = validateGenesis(state);
  assert.equal(result.success, true, result.error ?? "");
  assert.equal((result.details?.["state"] as { room: number }).room, 7);
  assert.equal(
    state.genesisComplete,
    false,
    "caller owns genesis completion, validator is read-only",
  );
});

test("genesis rejects missing runtime dependencies despite existing expected resource numbers", () => {
  const state = world();
  state.container.putResource(
    "logic",
    0,
    assembleLogic("load.view(99);return;", { dictionary: new Map() }).payload,
  );
  const result = validateGenesis(state);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /view.*99/i);
});

test("playtests stop at unsupported blocking host services", () => {
  const state = world('get.string(1,"Name?",0,0,10);');
  const result = playtestRoom(state, { room: 1 });
  assert.equal(result.success, false);
  assert.equal(result.details?.["simulation"], "needs_host");
  assert.match(result.error ?? "", /get.string/);
});

test("runaway bytecode and recursive room transitions fail within the instruction budget", () => {
  for (const source of ["forever: goto forever;", "new.room(1);return;"]) {
    const state = world();
    state.container.putResource(
      "logic",
      0,
      assembleLogic(source, { dictionary: new Map() }).payload,
    );
    const result = validateGenesis(state);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /instruction budget exceeded/i);
  }
});

test("simulation rejects oversized scripts and stops a bounded-cycle scenario", () => {
  assert.match(
    playtestRoom(world(), { room: 1, steps: Array(257).fill({ action: "wait" }) }).error ?? "",
    /at most 256/,
  );
  const result = playtestRoom(world(), {
    room: 1,
    steps: Array(6).fill({ action: "wait", ticks: 120 }),
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /cycle limit/);
});

test("candidate spawn honors horizon, dimensions, and AGI object baseline collisions", () => {
  const state = world(
    "if (!isset(f40)) {set(f40);animate.obj(1);set.view(1,0);position(1,84,120);draw(1);}",
  );
  for (const [spawnX, spawnY, pattern] of [
    [158, 120, /outside/],
    [80, 20, /horizon/],
    [83, 120, /overlaps object 1/],
  ] as const) {
    const result = playtestRoom(state, { room: 1, spawnX, spawnY });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", pattern);
  }
});

test("a room-only check does not claim a tested route and can enter a later authored room", () => {
  const state = world();
  const room = state.container.getResource("logic", 1)!;
  state.container.putResource("logic", 7, room);
  const result = playtestRoom(state, { room: 7 });
  assert.equal(result.success, true, result.error ?? "");
  assert.equal(result.details?.["enteredDirectly"], true);
  assert.equal(result.details?.["simulation"], "not_requested");
});

test("genesis rejects a static room that never enables player input", () => {
  const state = world();
  const dictionary = new Map([
    ["take", 10],
    ["key", 11],
    ["leave", 12],
  ]);
  state.container.putResource(
    "logic",
    1,
    assembleLogic(
      "if (isset(f5)) {assignn(v10,1);load.pic(v10);draw.pic(v10);show.pic();load.view(0);animate.obj(0);set.view(0,0);position(0,80,120);draw(0);} return;",
      { dictionary },
    ).payload,
  );
  const result = validateGenesis(state);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /enabled parser/);
});

test("a barrier-blocked exit fails the expected room assertion instead of claiming reachability", () => {
  const state = world("if (equaln(v2,2)) {new.room(2);}");
  state.container.putResource("picture", 1, Uint8Array.of(0xf2, 0, 0xf6, 156, 0, 156, 167, 0xff));
  const result = playtestRoom(state, {
    room: 1,
    spawnX: 153,
    spawnY: 120,
    steps: [{ action: "move", direction: "right", ticks: 20 }],
    expect: { room: 2 },
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Expected room 2; observed room 1/);
  assert.deepEqual(result.details?.["missingRooms"], []);
  assert.equal((result.details?.["state"] as { egoX: number }).egoX, 153);
});

test("waiting behind a modal does not claim an animation test passed", () => {
  const state = world('if (!isset(f31)) {set(f31);print("Welcome");}');
  const result = playtestRoom(state, {
    room: 1,
    steps: [{ action: "wait", ticks: 24 }],
    expect: { room: 1 },
  });
  assert.equal(result.success, false);
  assert.equal(result.details?.["simulation"], "needs_input");
  assert.match(result.error ?? "", /enter/i);
});

test("animation observations count every cel transition rather than comparing only endpoints", () => {
  const state = world();
  state.container.putResource(
    "view",
    0,
    buildView({
      loops: [
        {
          cels: [1, 2, 3].map((color) => ({
            width: 3,
            height: 2,
            transparentColor: 0,
            pixels: Array(6).fill(color),
          })),
        },
      ],
    }),
  );
  const result = playtestRoom(state, { room: 1, steps: [{ action: "wait", ticks: 24 }] });
  assert.equal(result.success, true, result.error ?? "");
  const steps = result.details?.["steps"] as {
    objects: { num: number; celChanges: number; celBefore: number; celAfter: number }[];
  }[];
  const ego = steps[0]!.objects.find((object) => object.num === 0)!;
  assert.equal(ego.celChanges, 24);
  assert.equal(ego.celBefore, ego.celAfter);
});

test("failed outcomes return targeted investigation steps for exits, inventory and flags", () => {
  const result = playtestRoom(world(), {
    room: 1,
    steps: [{ action: "wait", ticks: 1 }],
    expect: { room: 2, carriedItems: [0], flags: [{ id: 30, value: true }] },
  });
  assert.equal(result.success, false);
  const advice = JSON.stringify(result.details?.["nextSteps"]);
  assert.match(advice, /v2/);
  assert.match(advice, /get/);
  assert.match(advice, /f30/);
  assert.match(advice, /read_room_context/);
});

test("playtest can request longer sequences while retaining an execution budget", () => {
  const result = playtestRoom(world(), {
    room: 1,
    cycleBudget: 1200,
    instructionBudget: 100000,
    steps: [{ action: "wait", ticks: 900 }],
  });
  assert.equal(result.success, true, result.error ?? "");
  const limited = playtestRoom(world(), {
    room: 1,
    cycleBudget: 200,
    steps: [{ action: "wait", ticks: 900 }],
  });
  assert.equal(limited.success, false);
  assert.match(limited.error!, /cycle limit/);
});
