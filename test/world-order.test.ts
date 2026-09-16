import assert from "node:assert/strict";
import { test } from "node:test";
// tools.ts must resolve before authoringTools.ts — the module spreads
// AUTHORING_TOOLS at top level while authoringTools back-imports tool helpers.
import {
  buildObjectFile,
  createAgentSessionState,
  executeAgentTool,
  executeAgentToolAsync,
  type AgentSessionState,
} from "../src/agent/tools.ts";
import { executeAuthoringTool } from "../src/agent/authoringTools.ts";
import { installBaseTemplate } from "../src/agent/baseTemplate.ts";
import { playtestRoom } from "../src/agent/playtest.ts";
import { verifyPlanConnections } from "../src/agent/roomMap.ts";
import { executeRoomTool } from "../src/agent/roomTools.ts";
import { openContainer } from "../src/container/container.ts";
import { buildView } from "../src/view/view.ts";

/**
 * The D3 generation-order proof (docs/rc12-plan.md): the same three-room
 * world is authored two ways — rooms 1→3→8 in story order, and room 8 before
 * room 3 with the key and the sign clue written into the earlier room last.
 * Both builds must satisfy the agreed inventory identity (item 0), the locked
 * door's flag prerequisite and the travel semantics — and must replay the
 * same after the game is exported and reimported.
 */

const WALKABLE = Uint8Array.of(0xf0, 2, 0xf8, 0, 0, 0xff);
const EGO = buildView({
  loops: [{ cels: [{ width: 3, height: 2, transparentColor: 0, pixels: [1, 1, 1, 1, 1, 1] }] }],
});

function newGame(): AgentSessionState {
  const state = createAgentSessionState();
  installBaseTemplate(state, state.profile);
  state.container.putResource("picture", 1, WALKABLE);
  state.container.putResource("view", 0, EGO);
  state.objectPayload = buildObjectFile([{ name: "Brass key", startingRoom: 1 }]);
  return state;
}

function writeRoom(state: AgentSessionState, args: Record<string, unknown>): void {
  const result = executeRoomTool(state, "write_room", args);
  assert.equal(result?.success, true, result?.error ?? "");
}

const NO_PREREQ = { requiresItem: null, requiresFlag: null, removeItem: null, destination: null };
const keyInteraction = {
  commands: ["take key"],
  response: "You take the brass key.",
  blockedResponse: null,
  ...NO_PREREQ,
  giveItem: 0,
  setFlag: "has_key",
};
const signInteraction = {
  commands: ["read sign"],
  response: "The sign reads: 'The east hall door wants a brass key.'",
  blockedResponse: null,
  ...NO_PREREQ,
  giveItem: null,
  setFlag: null,
};

const garden = (withClue: boolean, expectedRevision = "absent") => ({
  room: 1,
  picture: 1,
  egoView: 0,
  title: "The Garden",
  description: "A walled garden. A sign stands by the east path.",
  expectedRevision,
  spawn: { x: 80, y: 140, horizon: 36 },
  exits: [{ edge: "right", destination: 3, requiresFlag: null, blockedResponse: null }],
  interactions: withClue ? [keyInteraction, signInteraction] : [keyInteraction],
});
const hall = {
  room: 3,
  picture: 1,
  egoView: 0,
  title: "The Hall",
  description: "A long hall; a locked door stands east.",
  expectedRevision: "absent",
  spawn: { x: 30, y: 120, horizon: 36 },
  exits: [
    { edge: "left", destination: 1, requiresFlag: null, blockedResponse: null },
    {
      edge: "right",
      destination: 8,
      requiresFlag: "has_key",
      blockedResponse: "The door is locked.",
    },
  ],
  interactions: [],
};
const vault = {
  room: 8,
  picture: 1,
  egoView: 0,
  title: "The Vault",
  description: "The prize room.",
  expectedRevision: "absent",
  spawn: { x: 30, y: 120, horizon: 36 },
  exits: [{ edge: "left", destination: 3, requiresFlag: null, blockedResponse: null }],
  interactions: [],
};

/** Room 8 before room 3; the key and the sign clue land in room 1 last. */
function buildReversed(): AgentSessionState {
  const state = newGame();
  const declared = executeAuthoringTool(state, "update_world", {
    rooms: [
      {
        num: 1,
        title: "The Garden",
        description: "A walled garden. A sign stands by the east path.",
        exits: [{ name: "right", room: 3 }],
      },
      {
        num: 3,
        title: "The Hall",
        description: "A long hall; a locked door stands east.",
        exits: [
          { name: "left", room: 1 },
          { name: "right", room: 8 },
        ],
      },
      {
        num: 8,
        title: "The Vault",
        description: "The prize room.",
        exits: [{ name: "left", room: 3 }],
      },
    ],
    facts: [],
    quests: [],
  });
  assert.equal(declared?.success, true, declared?.error ?? "");

  writeRoom(state, vault);
  writeRoom(state, hall);
  // The plan leads the build: room 1's declared exit is intent, not a defect.
  const mid = verifyPlanConnections(collectLogics(state), state.authoring.world.rooms);
  assert.deepEqual(mid.pending, [{ from: 1, name: "right", to: 3 }]);
  assert.deepEqual(mid.missing, []);

  writeRoom(state, garden(false));
  const revision = executeAgentTool(state, "read_logic", { num: 1, offset: null, limit: null })
    .details?.["revision"];
  // The clue is added to the earlier room by rewriting it against its revision.
  writeRoom(state, garden(true, String(revision)));
  return state;
}

function buildForward(): AgentSessionState {
  const state = newGame();
  writeRoom(state, garden(true));
  writeRoom(state, hall);
  writeRoom(state, vault);
  return state;
}

function collectLogics(state: AgentSessionState): Map<number, Uint8Array> {
  const logics = new Map<number, Uint8Array>();
  for (let num = 0; num <= 255; num++) {
    const payload = state.container.getResource("logic", num);
    if (payload) logics.set(num, payload);
  }
  return logics;
}

function hasKeyFlag(state: AgentSessionState): number {
  const binding = state.authoring.bindings["has_key"];
  assert.equal(binding?.kind, "flag");
  return binding!.num;
}

/** take the key, walk garden→hall→vault→hall→garden; assert rooms as we go. */
function playthrough(state: AgentSessionState, hasKey: number) {
  const played = playtestRoom(state, {
    room: 1,
    cycleBudget: 900,
    steps: [
      { action: "command", command: "take key" },
      { action: "move", direction: "right", ticks: 90 },
      { action: "move", direction: "right", ticks: 140 },
      { action: "move", direction: "left", ticks: 45 },
      { action: "move", direction: "left", ticks: 140 },
    ],
    expect: {
      room: 1,
      carriedItems: [0],
      flags: [{ id: hasKey, value: true }],
    },
  });
  assert.equal(played.success, true, played.error ?? "");
  const steps = played.details?.["steps"] as Record<string, unknown>[];
  assert.deepEqual(
    steps.map((s) => s["roomAfter"]),
    [1, 3, 8, 3, 1],
    "the whole loop crosses both doors both ways",
  );
  // Arrival is the authored spawn: entering room 3 from the garden lands ego
  // at (30,120), and the vault's west exit returns to the same point.
  assert.equal(steps[1]!["xAfter"], 30);
  assert.equal(steps[1]!["yAfter"], 120);
  assert.equal(steps[3]!["xAfter"], 30);
  assert.equal(steps[3]!["yAfter"], 120);
  return played;
}

test("declared connections verify and walk in either build order", () => {
  for (const state of [buildForward(), buildReversed()]) {
    const report = verifyPlanConnections(
      collectLogics(state),
      state.authoring.world.rooms,
      state.profile,
    );
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.pending, []);
    assert.equal(report.verified.length, 4, JSON.stringify(report));
    playthrough(state, hasKeyFlag(state));
  }
});

test("the locked door holds without the key, in either build order", () => {
  for (const state of [buildForward(), buildReversed()]) {
    const blocked = playtestRoom(state, {
      room: 3,
      spawnX: 140,
      cycleBudget: 120,
      steps: [{ action: "move", direction: "right", ticks: 30 }],
      expect: { room: 3, printed: "The door is locked." },
    });
    assert.equal(blocked.success, true, blocked.error ?? "");
    const step = (blocked.details?.["steps"] as Record<string, unknown>[])[0]!;
    assert.equal(step["roomAfter"], 3);
  }
});

test("both orders produce the same declared world", () => {
  const forward = buildForward();
  const reversed = buildReversed();
  assert.deepEqual(reversed.authoring.world.rooms, forward.authoring.world.rooms);
  assert.equal(hasKeyFlag(forward), hasKeyFlag(reversed));
  assert.ok(
    (reversed.sources.logics.get(1) ?? "").includes("read sign".split(" ")[0]!),
    "the reversed build's earlier room carries the clue",
  );
});

test("stored tests replay and handover validates, then survive export/reimport", () => {
  const state = buildForward();
  const hasKey = hasKeyFlag(state);
  const written = executeAgentTool(state, "write_game_tests", {
    mode: null,
    names: null,
    tests: [
      {
        name: "the key opens the east door",
        room: 1,
        spawnX: null,
        spawnY: null,
        steps: [
          { action: "command", command: "take key" },
          { action: "move", direction: "right", ticks: 90 },
          { action: "move", direction: "right", ticks: 140 },
        ],
        expect: {
          room: 8,
          carriedItems: [0],
          flags: [{ id: hasKey, value: true }],
        },
        cycleBudget: 300,
      },
    ],
  });
  assert.equal(written.success, true, written.error ?? "");
  const run = executeAgentTool(state, "run_game_tests", { names: null });
  assert.equal(run.success, true, run.error ?? "");

  const handover = executeAgentTool(state, "handover", { notes: null });
  assert.equal(handover.success, true, handover.error ?? "");
  const connections = handover.details?.["connections"] as {
    verified: unknown[];
    missing: unknown[];
  };
  assert.equal(connections.verified.length, 4);
  assert.equal(connections.missing.length, 0);

  // The exported image carries the same contract: replay through a fresh
  // session built from the shipped files.
  const reimported = createAgentSessionState(openContainer(state.getFiles()));
  playthrough(reimported, hasKey);
  const rerun = executeAgentTool(reimported, "run_game_tests", { names: null });
  assert.equal(rerun.success, true, rerun.error ?? "");
});

test("handover accepts declared exits whose source room is not built yet", () => {
  // The plan leads the build: room 5 is declared with an exit but has no
  // logic — pending intent, not a defect. Handover must not reject it.
  const state = newGame();
  const declared = executeAuthoringTool(state, "update_world", {
    rooms: [
      { num: 1, title: "The Garden", description: "", exits: [] },
      { num: 5, title: "The Vault", description: "", exits: [{ name: "out", room: 1 }] },
    ],
    facts: [],
    quests: [],
  });
  assert.equal(declared?.success, true, declared?.error ?? "");
  writeRoom(state, garden(false));
  state.genesisComplete = true;
  const handover = executeAgentTool(state, "handover", { notes: null });
  assert.equal(handover.success, true, handover.error ?? "");
  const connections = handover.details?.["connections"] as {
    pending: { from: number; name: string; to: number }[];
    missing: unknown[];
  };
  assert.deepEqual(connections.missing, []);
  assert.deepEqual(connections.pending, [{ from: 5, name: "out", to: 1 }]);
});

test("Ask mode withholds the authored plan from the assistant context", async () => {
  const state = buildForward();
  const readOnly = { readOnly: true };

  // The plan query itself is refused — intent is creator context.
  const bible = await executeAgentToolAsync(
    state,
    "inspect_world_bible",
    { filter: "intent", section: "rooms", name: null, offset: null, kind: null },
    readOnly,
  );
  assert.equal(bible.success, false);
  assert.match(bible.error ?? "", /not available in Ask/);

  // The default overview drops the intent index (room counts and keys are
  // plan shape — a spoiler even without the entries).
  const overview = await executeAgentToolAsync(
    state,
    "inspect_world_bible",
    { filter: null, section: null, name: null, offset: null, kind: null },
    readOnly,
  );
  assert.equal(overview.success, true, overview.error ?? "");
  assert.equal(Object.hasOwn(overview.details ?? {}, "authoredIntent"), false);

  // read_room_context no longer attaches the room's plan entry — its exits
  // can name rooms not yet built.
  const room = await executeAgentToolAsync(
    state,
    "read_room_context",
    { room: 3, state: null, frames: null },
    readOnly,
  );
  assert.equal(room.success, true, room.error ?? "");
  assert.equal(Object.hasOwn(room.details ?? {}, "intent"), false);

  // The creator path keeps the full plan — the authoring agent needs it.
  const creator = executeAgentTool(state, "inspect_world_bible", {
    filter: "intent",
    section: "rooms",
  });
  assert.equal(creator.success, true, creator.error ?? "");
  assert.ok(
    Object.keys((creator.details?.["entries"] as Record<string, unknown> | undefined) ?? {})
      .length > 0,
  );
  const creatorRoom = await executeAgentToolAsync(state, "read_room_context", {
    room: 3,
    state: null,
    frames: null,
  });
  assert.ok(
    Object.hasOwn(creatorRoom.details ?? {}, "intent"),
    "creator context keeps the room's plan entry",
  );
});

test("a rewrite that drops a declared exit warns, and handover rejects it", () => {
  const state = buildForward();
  const picVar = state.authoring.bindings["room_picture_number"]!.num;
  // Room 3 keeps its west return but loses the east door transition.
  const rewritten = executeAgentTool(state, "write_logic_source", {
    room: 3,
    source: `if (isset(f5)) {
  assignn(v${picVar}, 1); load.pic(v${picVar}); draw.pic(v${picVar}); show.pic();
  set.horizon(36);
  load.view(0); animate.obj(0); set.view(0,0); position(0,30,120); draw(0);
  normal.motion(0); normal.cycle(0); stop.cycling(0);
  assignn(v6, 0); player.control(); accept.input();
}
if (equaln(v2, 4)) { new.room(1); }
return;`,
  });
  assert.equal(rewritten.success, true, rewritten.error ?? "");
  assert.deepEqual(rewritten.details?.["droppedPlanExits"], [{ from: 3, name: "right", to: 8 }]);
  const handover = executeAgentTool(state, "handover", { notes: null });
  assert.equal(handover.success, false);
  assert.match(handover.error ?? "", /room 3 declares exit "right" to room 8/);
});

test("a rewrite that moves a declared exit to the wrong edge warns, and handover rejects it", () => {
  const state = buildForward();
  const picVar = state.authoring.bindings["room_picture_number"]!.num;
  // Room 3 still reaches room 8, but the transition leaves the bottom edge —
  // the plan says the east door goes east.
  const rewritten = executeAgentTool(state, "write_logic_source", {
    room: 3,
    source: `if (isset(f5)) {
  assignn(v${picVar}, 1); load.pic(v${picVar}); draw.pic(v${picVar}); show.pic();
  set.horizon(36);
  load.view(0); animate.obj(0); set.view(0,0); position(0,30,120); draw(0);
  normal.motion(0); normal.cycle(0); stop.cycling(0);
  assignn(v6, 0); player.control(); accept.input();
}
if (equaln(v2, 4)) { new.room(1); }
if (equaln(v2, 3)) { new.room(8); }
return;`,
  });
  assert.equal(rewritten.success, true, rewritten.error ?? "");
  assert.deepEqual(rewritten.details?.["mismatchedPlanExits"], [
    { from: 3, name: "right", to: 8, declared: "right", compiled: "bottom" },
  ]);
  const handover = executeAgentTool(state, "handover", { notes: null });
  assert.equal(handover.success, false);
  assert.match(handover.error ?? "", /room 3 declares exit "right" to room 8/);
  assert.match(handover.error ?? "", /leaves the bottom edge instead/);
});
