import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentSessionState, buildObjectFile } from "../src/agent/tools.ts";
import { buildView } from "../src/view/view.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok, parseWordsTok } from "../src/logic/words.ts";
import { resourceRevision } from "../src/agent/authoringState.ts";
import { ROOM_TOOLS, executeRoomTool } from "../src/agent/roomTools.ts";
import { playtestRoom, validateGenesis } from "../src/agent/playtest.ts";

function setup() {
  const state = createAgentSessionState();
  state.container.putResource(
    "logic",
    0,
    assembleLogic("if (!isset(f200)) {set(f200);new.room(1);} call.v(v0);return;", {
      dictionary: new Map(),
    }).payload,
  );
  state.container.putResource("picture", 1, Uint8Array.of(0xf0, 2, 0xf8, 0, 0, 0xff));
  state.container.putResource(
    "view",
    0,
    buildView({
      loops: [
        {
          cels: [
            { width: 3, height: 2, transparentColor: 0, pixels: [1, 1, 1, 1, 1, 1] },
            { width: 3, height: 2, transparentColor: 0, pixels: [2, 2, 2, 2, 2, 2] },
          ],
        },
      ],
    }),
  );
  state.wordsPayload = buildWordsTok([
    { word: "take", id: 10 },
    { word: "get", id: 10 },
    { word: "the", id: 0 },
  ]);
  state.objectPayload = buildObjectFile([{ name: "Key", startingRoom: 1 }]);
  state.authoring.bindings["courtyard"] = { kind: "logic", num: 1 };
  state.authoring.bindings["courtyard_picture"] = { kind: "picture", num: 1 };
  state.authoring.bindings["hero"] = { kind: "view", num: 0 };
  return state;
}
function args() {
  return {
    room: "courtyard",
    picture: "courtyard_picture",
    egoView: "hero",
    title: "Courtyard",
    description: "A quiet courtyard.",
    expectedRevision: "absent",
    spawn: { x: 80, y: 120, horizon: 36 },
    exits: [
      {
        edge: "right",
        destination: 2,
        requiresFlag: "door_open",
        blockedResponse: "The gate is closed.",
      },
    ],
    interactions: [
      {
        commands: ["take the key", "get key"],
        response: "Taken — safely.",
        giveItem: 0,
        setFlag: "door_open",
      },
    ],
  };
}

test("write_room describes and compiles real room behavior with named references and vocabulary", () => {
  assert.ok(ROOM_TOOLS.some((tool) => tool.name === "write_room"));
  const state = setup();
  const boot = state.container.getResource("logic", 0)!;
  const result = executeRoomTool(state, "write_room", args())!;
  assert.equal(result.success, true, result.error ?? "");
  assert.deepEqual(state.container.getResource("logic", 0), boot);
  const words = new Map(parseWordsTok(state.wordsPayload!).map(({ word, id }) => [word, id]));
  assert.equal(words.get("take"), 10);
  assert.equal(words.get("get"), 10);
  assert.equal(words.get("the"), 0);
  assert.ok(words.has("key"));
  assert.equal(state.authoring.world.rooms["1"]?.exits["right"], 2);
  assert.ok(state.authoring.bindings["door_open"]?.kind === "flag");
  assert.equal(
    result.details?.["revision"],
    resourceRevision(state.container.getResource("logic", 1)),
  );
  assert.equal(validateGenesis(state).success, true);
  const played = playtestRoom(state, {
    room: 1,
    steps: [{ action: "command", command: "get key" }],
    expect: {
      carriedItems: [0],
      flags: [{ id: state.authoring.bindings["door_open"]!.num, value: true }],
    },
  });
  assert.equal(played.success, true, played.error ?? "");
  assert.ok((played.details?.["messages"] as string[]).includes("Taken -- safely."));
});

test("write_room accepts the new-room revision advertised to the model", () => {
  const description = ROOM_TOOLS.find((tool) => tool.name === "write_room")!.description;
  const advertised = description.match(/expectedRevision "([^"]+)" for a new room/)?.[1];
  assert.ok(advertised, "The new-room sentinel must be discoverable before writing resources.");
  const result = executeRoomTool(setup(), "write_room", {
    ...args(),
    expectedRevision: advertised,
  })!;
  assert.equal(result.success, true, result.error ?? "");
});

test("write_room allocates local pacing state and cycles ego only after real movement", () => {
  const state = setup();
  const result = executeRoomTool(state, "write_room", args())!;
  assert.equal(result.success, true, result.error ?? "");

  const names = [
    "room_picture_number",
    "room_ego_step_time",
    "room_ego_cycle_time",
    "room_ego_previous_x",
    "room_ego_previous_y",
    "room_ego_current_x",
    "room_ego_current_y",
  ];
  const ids = names.map((name) => state.authoring.bindings[name]?.num);
  assert.equal(
    ids.every((id) => id !== undefined && id >= 32),
    true,
  );
  assert.equal(new Set(ids).size, names.length);

  const source = state.sources.logics.get(1) ?? "";
  assert.doesNotMatch(source, /assignn\(v10,/);
  assert.match(source, new RegExp(`assignn\\(v${ids[1]}, 1\\); step.time\\(0, v${ids[1]}\\)`));
  assert.match(source, new RegExp(`assignn\\(v${ids[2]}, 3\\); cycle.time\\(0, v${ids[2]}\\)`));
  assert.match(source, /stop.cycling\(0\)/);
  assert.match(source, /get.posn\(0,/);

  const idle = playtestRoom(state, {
    room: 1,
    steps: [{ action: "wait", ticks: 10 }],
    expect: {},
  });
  assert.equal(idle.success, true, idle.error ?? "");
  const idleStep = (idle.details?.["steps"] as Record<string, unknown>[])[0]!;
  const idleEgo = (idleStep["objects"] as Record<string, unknown>[])[0]!;
  assert.equal(idleEgo["celChanges"], 0, "an idle generated ego holds its current cel");

  const moving = playtestRoom(state, {
    room: 1,
    steps: [{ action: "move", direction: "right", ticks: 10 }],
    expect: {},
  });
  assert.equal(moving.success, true, moving.error ?? "");
  const movingStep = (moving.details?.["steps"] as Record<string, unknown>[])[0]!;
  const movingEgo = (movingStep["objects"] as Record<string, unknown>[])[0]!;
  assert.equal((movingStep["movement"] as Record<string, unknown>)["moved"], true);
  assert.ok((movingEgo["celChanges"] as number) >= 2, "walking advances at a readable cadence");
  assert.equal(movingEgo["cycleTime"], 3);
  const finalEgo = (moving.details?.["objects"] as Record<string, unknown>[])[0]!;
  assert.equal(finalEgo["stepTime"], 1);
});

test("write_room protects replacements with a content revision and reports stale edits", () => {
  const state = setup();
  assert.equal(executeRoomTool(state, "write_room", args())!.success, true);
  const before = [...state.getFiles()].map(([name, bytes]) => [name, bytes.slice()]);
  const stale = executeRoomTool(state, "write_room", args())!;
  assert.equal(stale.success, false);
  assert.match(stale.error ?? "", /revision/i);
  assert.deepEqual([...state.getFiles()], before);
  const revision = resourceRevision(state.container.getResource("logic", 1));
  assert.equal(
    executeRoomTool(state, "write_room", {
      ...args(),
      expectedRevision: revision,
      title: "Garden",
    })!.success,
    true,
  );
  assert.equal(state.authoring.world.rooms["1"]?.title, "Garden");
});

test("invalid text or inventory effects leave resource bytes, words, bindings and sources unchanged", () => {
  for (const interaction of [
    { commands: ["take key"], response: "Invalid snowman ☃", setFlag: "new_flag" },
    { commands: ["take key"], response: "Taken", giveItem: 99, setFlag: "new_flag" },
  ]) {
    const state = setup();
    const before = [...state.getFiles()].map(([name, bytes]) => [name, bytes.slice()]);
    const authoring = JSON.stringify(state.authoring);
    const result = executeRoomTool(state, "write_room", {
      ...args(),
      interactions: [interaction],
    })!;
    assert.equal(result.success, false);
    assert.deepEqual([...state.getFiles()], before);
    assert.equal(JSON.stringify(state.authoring), authoring);
    assert.equal(state.sources.logics.size, 0);
  }
});

test("room interactions test carried inventory before applying effects", () => {
  const state = setup();
  const result = executeRoomTool(state, "write_room", {
    ...args(),
    exits: [],
    interactions: [
      { commands: ["open gate"], response: "Opened", requiresItem: 0, setFlag: "door_open" },
    ],
  })!;
  assert.equal(result.success, true, result.error ?? "");
  const flag = state.authoring.bindings["door_open"]!.num;
  const played = playtestRoom(state, {
    room: 1,
    steps: [{ action: "command", command: "open gate" }],
    expect: { flags: [{ id: flag, value: false }] },
  });
  assert.equal(played.success, true, played.error ?? "");
});

test("room scaffolds reject boot overrides and duplicate edge definitions", () => {
  const state = setup();
  assert.match(
    executeRoomTool(state, "write_room", { ...args(), room: 0 })?.error ?? "",
    /1.*255|boot/i,
  );
  const duplicated = {
    ...args(),
    exits: [
      { edge: "right", destination: 2 },
      { edge: "right", destination: 3 },
    ],
  };
  assert.match(executeRoomTool(state, "write_room", duplicated)?.error ?? "", /duplicate.*right/i);
});

test("failed container commits preserve all source and authoring state", () => {
  const state = setup();
  const originalPut = state.container.putResource;
  const before = [...state.getFiles()].map(([name, bytes]) => [name, bytes.slice()]);
  const authoring = JSON.stringify(state.authoring);
  state.container.putResource = () => {
    throw new Error("injected container capacity failure");
  };
  try {
    const result = executeRoomTool(state, "write_room", args())!;
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /capacity failure/);
    assert.deepEqual([...state.getFiles()], before);
    assert.equal(state.sources.logics.size, 0);
    assert.equal(JSON.stringify(state.authoring), authoring);
  } finally {
    state.container.putResource = originalPut;
  }
});

test("room command scaffolds retain existing multiword dictionary phrases and synonym IDs", () => {
  const state = setup();
  state.wordsPayload = buildWordsTok([
    { word: "pick up", id: 10 },
    { word: "take", id: 10 },
    { word: "key", id: 11 },
  ]);
  const result = executeRoomTool(state, "write_room", {
    ...args(),
    exits: [],
    interactions: [{ commands: ["pick up key"], response: "Taken", giveItem: 0 }],
  })!;
  assert.equal(result.success, true, result.error ?? "");
  const words = new Map(parseWordsTok(state.wordsPayload!).map(({ word, id }) => [word, id]));
  assert.equal(words.get("pick up"), 10);
  assert.equal(
    words.has("pick"),
    false,
    "the existing phrase should not allocate split-word aliases",
  );
  assert.equal(words.has("up"), false);
  assert.match(state.sources.logics.get(1) ?? "", /said\("pick up", "key"\)/);
  for (const command of ["pick up key", "take key"]) {
    const played = playtestRoom(state, {
      room: 1,
      steps: [{ action: "command", command }],
      expect: { carriedItems: [0] },
    });
    assert.equal(played.success, true, played.error ?? "");
  }
});
