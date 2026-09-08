import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSessionState, buildObjectFile } from "../src/agent/tools.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { buildView } from "../src/view/view.ts";
import { playtestRoom, validateGenesis } from "../src/agent/playtest.ts";
import { decodePng } from "../scripts/sheet-to-view.ts";

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

test("playtest automatically acknowledges open modal before sending a command without requiring enter", () => {
  const state = world('if (!isset(f31)) {set(f31);print("Welcome");}');
  const result = playtestRoom(state, {
    room: 1,
    steps: [{ action: "command", command: "take key" }],
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

test("genesis warns about a static room that never enables player input", () => {
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
  assert.equal(result.success, true, result.error ?? "");
  assert.match((result.details?.["warnings"] as string[]).join(" "), /parser was not enabled/);
});

test("genesis fails a boot that shows nothing", () => {
  const state = world();
  state.container.putResource(
    "logic",
    1,
    assembleLogic("return;", { dictionary: new Map() }).payload,
  );
  const result = validateGenesis(state);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /showed nothing/);
});

test("genesis passes a text-only intro and an ego-less scene with warnings", () => {
  const dictionary = new Map([["take", 10]]);
  const textOnly = world();
  textOnly.container.putResource(
    "logic",
    1,
    assembleLogic('display(10, 5, "The archive is closed today."); return;', { dictionary })
      .payload,
  );
  const intro = validateGenesis(textOnly);
  assert.equal(intro.success, true, intro.error ?? "");
  assert.match((intro.details?.["warnings"] as string[]).join(" "), /no picture/i);

  const egoless = world();
  egoless.container.putResource(
    "logic",
    1,
    assembleLogic(
      "if (isset(f5)) { assignn(v10,1); load.pic(v10); draw.pic(v10); show.pic(); accept.input(); } return;",
      { dictionary },
    ).payload,
  );
  const scene = validateGenesis(egoless);
  assert.equal(scene.success, true, scene.error ?? "");
  assert.match((scene.details?.["warnings"] as string[]).join(" "), /active ego/);
  assert.equal(scene.details?.["genesisValidated"], true);
});

test("genesis dismisses a long intro and a key-wait title before the first room", () => {
  const dictionary = new Map([["take", 10]]);
  const state = world();
  state.container.putResource(
    "logic",
    1,
    assembleLogic(
      `
if (lessn(v40, 10)) { increment(v40); print("Long ago, in a kingdom of pixels..."); return; }
if (!isset(f41)) {
  display(10, 5, "Press any key");
title: if (!have.key()) { goto title; }
  set(f41);
  assignn(v10,1); load.pic(v10); draw.pic(v10); show.pic();
  load.view(0); animate.obj(0); set.view(0,0); position(0,80,120); draw(0); accept.input();
}
return;`,
      { dictionary },
    ).payload,
  );
  const result = validateGenesis(state);
  assert.equal(result.success, true, result.error ?? "");
  assert.equal(result.details?.["acknowledgements"], 11, "ten messages and one key press");
  assert.equal(result.details?.["warnings"], undefined);
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
  const step = (result.details?.["steps"] as Record<string, unknown>[])[0]!;
  assert.deepEqual(step["movement"], {
    moved: false,
    deltaX: 0,
    deltaY: 0,
    positionChanges: 0,
    finalDirection: 3,
    blockedAtEnd: true,
    attemptedBaseline: { x0: 154, x1: 156, y: 120, values: [0, 4] },
    blockingControls: [{ value: 0, x0: 156, x1: 156 }],
    issue: "No movement in 20 cycles; the next baseline intersects barrier priority 0 at x156.",
  });
  assert.equal(step["egoCompletelyOccluded"], false);
  assert.equal(step["estimatedDurationMs"], 1000, "timing starts after room setup with v10=1");
});

test("movement diagnostics report a barrier reached after making partial progress", () => {
  const state = world();
  state.container.putResource("picture", 1, Uint8Array.of(0xf2, 0, 0xf6, 158, 0, 158, 167, 0xff));
  const result = playtestRoom(state, {
    room: 1,
    spawnX: 153,
    spawnY: 120,
    steps: [{ action: "move", direction: "right", ticks: 20 }],
  });
  assert.equal(result.success, true, result.error ?? "");
  const movement = (result.details?.["steps"] as { movement: Record<string, unknown> }[])[0]!
    .movement;
  assert.equal(movement["moved"], true);
  assert.equal(movement["deltaX"], 2);
  assert.equal(movement["blockedAtEnd"], true);
  assert.deepEqual(movement["attemptedBaseline"], {
    x0: 156,
    x1: 158,
    y: 120,
    values: [0, 4],
  });
  assert.match(String(movement["issue"]), /Moved 2 pixels.*barrier priority 0 at x158/);
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

test("playtest checkpoints preserve distinct intermediate frames when a cycle returns to its endpoint", () => {
  const state = world();
  state.container.putResource(
    "view",
    0,
    buildView({
      loops: [
        {
          cels: [1, 2, 3, 4].map((color) => ({
            width: 3,
            height: 2,
            transparentColor: 0,
            pixels: Array(6).fill(color),
          })),
        },
      ],
    }),
  );
  const result = playtestRoom(state, {
    room: 1,
    steps: [{ action: "wait", ticks: 4, captureTicks: [1, 2, 3, 4] }],
  });
  assert.equal(result.success, true, result.error ?? "");
  assert.equal(
    result.images?.length,
    2,
    "the final screenshot remains first and one sheet follows",
  );

  const checkpoints = result.details?.["checkpoints"] as {
    tile: number;
    row: number;
    col: number;
    stepIndex: number;
    tick: number;
    cycle: number;
    estimatedGameTimeMs: number;
    room: number;
    objects: {
      num: number;
      view: number;
      loop: number;
      cel: number;
      x: number;
      y: number;
      width: number;
      height: number;
      priority: number;
    }[];
  }[];
  assert.deepEqual(
    checkpoints.map(({ tile, row, col, stepIndex, tick, cycle, estimatedGameTimeMs, room }) => ({
      tile,
      row,
      col,
      stepIndex,
      tick,
      cycle,
      estimatedGameTimeMs,
      room,
    })),
    [
      {
        tile: 0,
        row: 0,
        col: 0,
        stepIndex: 0,
        tick: 1,
        cycle: 2,
        estimatedGameTimeMs: 50,
        room: 1,
      },
      {
        tile: 1,
        row: 0,
        col: 1,
        stepIndex: 0,
        tick: 2,
        cycle: 3,
        estimatedGameTimeMs: 100,
        room: 1,
      },
      {
        tile: 2,
        row: 1,
        col: 0,
        stepIndex: 0,
        tick: 3,
        cycle: 4,
        estimatedGameTimeMs: 150,
        room: 1,
      },
      {
        tile: 3,
        row: 1,
        col: 1,
        stepIndex: 0,
        tick: 4,
        cycle: 5,
        estimatedGameTimeMs: 200,
        room: 1,
      },
    ],
  );
  assert.deepEqual(
    checkpoints.map(({ objects }) => objects),
    [2, 3, 0, 1].map((cel) => [
      { num: 0, view: 0, loop: 0, cel, x: 80, y: 120, width: 3, height: 2, priority: 11 },
    ]),
  );

  const final = decodePng(result.images![0]!.png);
  const sheet = decodePng(result.images![1]!.png);
  assert.deepEqual({ width: sheet.width, height: sheet.height }, { width: 644, height: 404 });
  const rgbAt = (image: typeof final, x: number, y: number): number[] =>
    Array.from(image.rgba.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));
  assert.deepEqual(rgbAt(final, 160, 127), [0, 170, 0], "final frame returned to its starting cel");
  assert.deepEqual(
    [
      rgbAt(sheet, 160, 127),
      rgbAt(sheet, 324 + 160, 127),
      rgbAt(sheet, 160, 204 + 127),
      rgbAt(sheet, 324 + 160, 204 + 127),
    ],
    [
      [0, 170, 170],
      [170, 0, 0],
      [0, 0, 170],
      [0, 170, 0],
    ],
    "the contact sheet contains all intermediate composed frames in row-major order",
  );
});

test("playtest rejects invalid checkpoint requests before simulation", () => {
  for (const [captureTicks, ticks, pattern] of [
    [[2, 1], 2, /strictly increasing/i],
    [[1, 3], 2, /integer from 1 to 2/i],
    [[1.5], 2, /integer from 1 to 2/i],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10, /at most 9/i],
  ] as const) {
    const result = playtestRoom(world(), {
      room: 1,
      steps: [{ action: "wait", ticks, captureTicks }],
    });
    assert.equal(result.success, false);
    assert.match(result.error ?? "", pattern);
    assert.equal(result.images, undefined, "validation runs before the isolated interpreter boots");
  }
  const total = playtestRoom(world(), {
    room: 1,
    steps: [
      { action: "wait", ticks: 5, captureTicks: [1, 2, 3, 4, 5] },
      { action: "wait", ticks: 5, captureTicks: [1, 2, 3, 4, 5] },
    ],
  });
  assert.equal(total.success, false);
  assert.match(total.error ?? "", /at most 9.*scenario/i);
  assert.equal(total.images, undefined);
});

test("checkpoint timing remains unknown while v10 is host-rate-dependent", () => {
  const result = playtestRoom(world("assignn(v10,0);"), {
    room: 1,
    steps: [{ action: "wait", ticks: 1, captureTicks: [1] }],
  });
  assert.equal(result.success, true, result.error ?? "");
  assert.equal(result.details?.["estimatedGameTimeMs"], null);
  assert.equal(
    (result.details?.["checkpoints"] as { estimatedGameTimeMs: number | null }[])[0]!
      .estimatedGameTimeMs,
    null,
  );
  assert.equal(
    (result.details?.["steps"] as Record<string, unknown>[])[0]!["estimatedDurationMs"],
    null,
  );
});

test("each playtest step reports engine occlusion plus the scenery depth over ego", () => {
  const state = world();
  state.container.putResource("picture", 1, Uint8Array.of(0xf0, 2, 0xf2, 12, 0xf8, 0, 0, 0xff));
  const result = playtestRoom(state, { room: 1, steps: [{ action: "wait", ticks: 1 }] });
  assert.equal(result.success, true, result.error ?? "");
  const step = (result.details?.["steps"] as Record<string, unknown>[])[0]!;
  assert.equal(step["egoCompletelyOccluded"], true);
  assert.deepEqual(step["occlusion"], {
    actorPriority: 11,
    actorBoxCells: 6,
    sceneCellsAboveActorPriority: 6,
    completelyOccluded: true,
  });
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
