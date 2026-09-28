/**
 * Room Studio's Walk view below the canvas: the pure door and outcome
 * helpers (walkView.ts), the room logic draft (useRoomLogicDraft.ts), the
 * shared undo order (useUndoOrder.ts) and the Walk composable
 * (useStudioWalk.ts) driving real kernels: the walkable estimate, rule
 * edits, and test walks through the real `testRoute` on the tutorial.
 * Expected coordinates and outcomes are worked out by hand in each case.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectScope, shallowRef } from "vue";
import { buildTutorial } from "../../games/adventure-department/game.ts";
import { createAgentSessionState } from "../../src/agent/agentState.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { applyEdit } from "../../src/studio/editOperations.ts";
import { compileEditDocument } from "../../src/studio/editValidation.ts";
import { parsePictureDocument, type PictureDocument } from "../../src/studio/pictureDocument.ts";
import { testRoute, type RouteTestResult } from "../../src/studio/route.ts";
import { parseLogicDocument } from "../../src/studio/rules/logicDocument.ts";
import { readRules } from "../../src/studio/rules/ruleModel.ts";
import type { ExitContract } from "../../src/studio/rules/ruleUsage.ts";
import { buildView } from "../../src/view/view.ts";
import type { RouteWorkerInbound } from "../src/studio/routeRunner.ts";
import { toShown, toStored, useRoomLogicDraft } from "../src/studio/useRoomLogicDraft.ts";
import {
  DEFAULT_EGO,
  useStudioWalk,
  type EgoShape,
  type LiveGameState,
} from "../src/studio/useStudioWalk.ts";
import { useUndoOrder } from "../src/studio/useUndoOrder.ts";
import type { StudioNotice } from "../src/studio/useStudioNotice.ts";
import {
  destinationLabel,
  doorAtGoal,
  doorStatus,
  doorTestNote,
  edgeAt,
  entrySpot,
  outcomeTitle,
  playTarget,
  refusedCell,
  resultPlace,
  walkDoors,
  WALK_STATE_LABEL,
  walkStateText,
} from "../src/studio/walkView.ts";
import { studioRoomSource, type StudioRoomSource } from "../src/world/studioSource.ts";

const at = (x: number, y: number) => y * 160 + x;
const ROOMS = [
  { room: 1, title: "Door hall" },
  { room: 2, title: "Green room" },
];

function contract(over: Partial<ExitContract>): ExitContract {
  return {
    edge: null,
    destination: 2,
    status: "compiled",
    planned: false,
    compiled: true,
    testedBy: [],
    rule: null,
    wayBack: [],
    twoSided: false,
    reciprocal: false,
    arrival: { source: "kept" },
    ...over,
  };
}

describe("walkView: doors and words", () => {
  const LOGIC = [
    '// @rule door-1 "Door to room 2" exit item=doorway',
    "if (posn(o0, 120, 124, 133, 130)) {",
    "  new.room(2);",
    "}",
    "// @end",
    '// @rule exit-south-1 "South edge" exit',
    "if (equaln(v2, 3)) {",
    "  new.room(3);",
    "}",
    "// @end",
    "if (equaln(v2, 4)) { new.room(5); }",
    "return;",
  ].join("\n");
  const rules = readRules(parseLogicDocument(LOGIC).document);

  it("lists annotated rules as editable doors and compiled exits as native ones", () => {
    const doors = walkDoors(rules, [
      contract({ rule: "door-1", destination: 2, wayBack: ["left"], twoSided: true }),
      contract({ rule: "exit-south-1", edge: "bottom", destination: 3 }),
      contract({ edge: "left", destination: 5 }),
      contract({ destination: 4, compiled: false, planned: true, status: "planned" }),
    ]);
    assert.deepEqual(
      doors.map((d) => [d.id, d.shape, d.edge, d.destination, d.editable, d.planned, d.item]),
      [
        ["door-1", "box", null, 2, true, false, "doorway"],
        ["exit-south-1", "edge", "bottom", 3, true, false, null],
        ["native-1", "edge", "left", 5, false, false, null],
        ["native-2", "other", null, 4, false, true, null],
      ],
    );
    assert.deepEqual(doors[0]!.box, { x1: 120, y1: 124, x2: 133, y2: 130 });
    assert.equal(doors[0]!.line, 1);
    assert.equal(doors[2]!.label, "Leaves by the west edge");
    assert.equal(doors[3]!.label, "Planned exit by the room's script");
  });

  it("words where a door leads and its two sides", () => {
    assert.equal(destinationLabel(2, ROOMS), "→ Green room");
    assert.equal(destinationLabel(7, ROOMS), "→ Room 7");
    const none = false;
    assert.deepEqual(doorStatus({ destination: 2, contract: contract({}) }, none), {
      wayBack: "One way: nothing there leads back",
      tested: "Not tested yet",
      testedOk: false,
    });
    const back = contract({
      wayBack: ["right", null, "right"],
      status: "tested",
      testedBy: ["route"],
    });
    assert.deepEqual(doorStatus({ destination: 2, contract: back }, none), {
      wayBack: "Way back from there: the east edge or a door or the script",
      tested: "Tested ✓ (route)",
      testedOk: true,
    });
    // A test walk attributed to this door, on the draft as it is, covers it.
    assert.equal(
      doorStatus({ destination: 2, contract: contract({}) }, true).tested,
      "Tested ✓ (test walk)",
    );
    assert.equal(
      doorStatus({ destination: 2, contract: null }, none).wayBack,
      "Written into the room when you Keep",
    );
  });

  it("says plainly what a test walk carries over from the game", () => {
    assert.equal(WALK_STATE_LABEL, "Use my game state");
    assert.equal(walkStateText("live"), "Fresh room entry with your flags and variables");
    assert.equal(walkStateText("fresh"), "Fresh room entry from a new game");
  });

  it("plays from where a walk ended, in the room it ended in", () => {
    const walked = (over: Partial<RouteTestResult>): RouteTestResult => ({
      reached: false,
      outcome: "reached",
      end: { x: 30, y: 140 },
      room: 1,
      steps: 1,
      cycles: 1,
      reason: "",
      ...over,
    });
    const goal = { x: 50, y: 150 };
    assert.deepEqual(playTarget(walked({ reached: true }), 1, goal), { room: 1, x: 30, y: 140 });
    // Through a door: ego ended in room 2, at room 2's coordinates.
    assert.deepEqual(
      playTarget(walked({ outcome: "room_changed", room: 2, end: { x: 20, y: 150 } }), 1, goal),
      { room: 2, x: 20, y: 150 },
    );
    assert.equal(playTarget(walked({ outcome: "start_blocked" }), 1, goal), null);
  });

  it("picks the nearest edge, counting a column twice", () => {
    assert.equal(edgeAt({ x: 3, y: 100 }, 36), "left");
    assert.equal(edgeAt({ x: 150, y: 100 }, 36), "right");
    // 10 rows below the horizon beats 20 columns (40 on screen) from the left.
    assert.equal(edgeAt({ x: 20, y: 46 }, 36), "top");
    assert.equal(edgeAt({ x: 60, y: 165 }, 36), "bottom");
  });

  it("starts a walk where the destination's way back puts the player", () => {
    const mask = new Uint8Array(160 * 168).fill(1);
    // The destination's init block positions ego at 18,151 for this origin.
    assert.deepEqual(
      entrySpot(
        { edge: "left", box: null },
        contract({ arrival: { source: "logic", x: 18, y: 151, conditional: false } }),
        mask,
        36,
      ),
      { x: 18, y: 151 },
    );
    // No position(o0): the interpreter's placement on the arrival side, just inside.
    assert.deepEqual(
      entrySpot(
        { edge: null, box: null },
        contract({ arrival: { source: "edge", side: "right" } }),
        mask,
        36,
      ),
      { x: 151, y: 102 },
    );
    // A spot the estimate refuses moves to the nearest standable cell.
    const blocked = mask.slice();
    blocked[at(18, 151)] = 0;
    assert.deepEqual(
      entrySpot(
        { edge: "left", box: null },
        contract({ arrival: { source: "logic", x: 18, y: 151, conditional: false } }),
        blocked,
        36,
      ),
      { x: 18, y: 150 },
    );
  });

  it("names the control cell that refused the next step toward the goal", () => {
    const priority = new Uint8Array(160 * 168).fill(4);
    // A barrier row at y 121 from x 47 to 110.
    priority.fill(0, at(47, 121), at(110, 121) + 1);
    const input = {
      priority,
      egoWidth: 3,
      egoHeight: 6,
      observeBlocks: true,
      waterGate: null,
      horizon: 36,
    };
    // Ego at 60,122 walking up: its footprint 60..62 at row 121 is the barrier.
    assert.deepEqual(refusedCell(input, { x: 60, y: 122 }, { x: 60, y: 100 }), { x: 60, y: 121 });
    // Straight up from 45,122: the footprint 45..47 meets the rope only at its right cell.
    assert.deepEqual(refusedCell(input, { x: 45, y: 122 }, { x: 45, y: 100 }), { x: 47, y: 121 });
    // Up and to the left from 48,122: the diagonal step's footprint 47..49 meets the rope's end.
    assert.deepEqual(refusedCell(input, { x: 48, y: 122 }, { x: 30, y: 100 }), { x: 47, y: 121 });
    // Nothing refuses a step on open floor.
    assert.equal(refusedCell(input, { x: 20, y: 140 }, { x: 30, y: 140 }), null);
  });

  it("words every engine outcome", () => {
    const words = (outcome: RouteTestResult["outcome"], room = 1, blocked: string | null = null) =>
      outcomeTitle({ outcome, room }, blocked, ROOMS);
    assert.equal(words("reached"), "Reached");
    assert.equal(words("blocked", 1, "Rope barrier"), "Blocked at Rope barrier");
    assert.equal(words("blocked"), "Blocked at a barrier");
    assert.equal(words("room_changed", 2), "Went to room 2 (Green room)");
    assert.equal(words("room_changed", 9), "Went to room 9");
    assert.equal(words("modal"), "A message stopped the walk");
    assert.equal(words("start_blocked"), "The start is not a spot the player can stand on");
  });

  it("a goal on a door box or against an edge exit aims the walk at that door", () => {
    const doors = walkDoors(rules, [
      contract({ rule: "door-1", destination: 2 }),
      contract({ rule: "exit-south-1", edge: "bottom", destination: 3 }),
      contract({ edge: "left", destination: 5 }),
    ]);
    const aimed = (x: number, y: number) => doorAtGoal(doors, { x, y }, 36)?.id ?? null;
    assert.equal(aimed(125, 127), "door-1", "inside the box");
    assert.equal(aimed(0, 130), "native-1", "on the west edge");
    assert.equal(aimed(2, 90), "native-1", "within two columns of it");
    assert.equal(aimed(3, 130), null);
    assert.equal(aimed(80, 166), "exit-south-1");
    assert.equal(aimed(159, 130), null, "no exit leaves by the east edge");
    assert.equal(aimed(60, 140), null);
  });

  it("words a walk aimed at a door that did not go through it", () => {
    const aimed = (outcome: RouteTestResult["outcome"], blocked: string | null = null) =>
      outcomeTitle({ outcome, room: 1 }, blocked, ROOMS, false, "the west edge");
    assert.equal(
      aimed("blocked", "Rope barrier"),
      "Couldn't reach the west edge from here: blocked at Rope barrier",
    );
    assert.equal(aimed("blocked"), "Couldn't reach the west edge from here");
    assert.equal(
      aimed("budget"),
      "Couldn't reach the west edge from here: the walk ran out of time",
    );
    assert.equal(aimed("stayed"), "Reached the west edge, but the game stayed in this room");
    assert.equal(aimed("reached"), "Reached the west edge, but the game stayed in this room");
    assert.equal(aimed("room_changed"), "Went to room 1 (Door hall)");
    assert.equal(aimed("modal"), "A message stopped the walk");
  });

  it("says how to test a door, or why the last walk did not", () => {
    const edge = { shape: "edge" as const };
    assert.equal(doorTestNote(edge, true, null), null);
    assert.equal(
      doorTestNote(edge, false, null),
      "To test it: set a start with the test walk tool (T), then click this door as the goal.",
    );
    assert.equal(
      doorTestNote(
        edge,
        false,
        "Last test walk from 30,140: Couldn't reach the west edge from here.",
      ),
      "Last test walk from 30,140: Couldn't reach the west edge from here.",
    );
    assert.equal(
      doorTestNote({ shape: "other" }, false, null),
      "Exits made by the room's script run in play: play the game to test this one.",
    );
  });

  it("places a walk where it ended, or at the start it asked for when the engine refused it", () => {
    const from = { x: 80, y: 60 };
    const run = (outcome: RouteTestResult["outcome"], room = 1) => ({
      outcome,
      end: { x: 18, y: 151 },
      room,
    });
    assert.deepEqual(resultPlace(from, run("reached"), 1), { term: "Ended at", text: "18,151" });
    assert.deepEqual(resultPlace(from, run("room_changed", 2), 1), {
      term: "Ended at",
      text: "18,151 in room 2",
    });
    // The engine put ego at the room's entry (18,151); the card names the start asked for.
    assert.deepEqual(resultPlace(from, run("start_blocked"), 1), {
      term: "Asked start",
      text: "80,60",
    });
  });
});

describe("useUndoOrder", () => {
  /** A counter history: each edit adds a step. */
  function history() {
    const past = shallowRef(0);
    const future = shallowRef(0);
    const log: string[] = [];
    return {
      log,
      edit: () => {
        past.value++;
        future.value = 0;
      },
      past: () => past.value,
      future: () => future.value,
      undo: () => {
        if (past.value === 0) return false;
        past.value--;
        future.value++;
        log.push("undo");
        return true;
      },
      redo: () => {
        if (future.value === 0) return false;
        future.value--;
        past.value++;
        log.push("redo");
        return true;
      },
    };
  }

  it("undoes the newest change of either history and redoes in reverse", () => {
    const scope = effectScope();
    scope.run(() => {
      const picture = history();
      const logic = history();
      const order = useUndoOrder([picture, logic]);
      picture.edit();
      logic.edit();
      picture.edit();
      const trail: string[] = [];
      const mark = () => trail.push(`${picture.past()}${logic.past()}`);
      order.undo();
      mark();
      order.undo();
      mark();
      order.undo();
      mark();
      assert.equal(order.undo(), false);
      assert.deepEqual(trail, ["11", "10", "00"]);
      order.redo();
      mark();
      order.redo();
      mark();
      // A new edit after an undo clears only that history's redo.
      logic.undo();
      logic.edit();
      assert.equal(logic.future(), 0);
      order.undo();
      mark();
      assert.deepEqual(trail.slice(3), ["10", "11", "10"]);
    });
    scope.stop();
  });
});

// ---- The room logic draft and the Walk composable ------------------------

/** Room 1: a floor, a red doorway item, a rope barrier across y 121; ego 3x6 enters at 40,140. */
const PICTURE = [
  '# @item floor "Floor" art',
  "vis 8",
  "fill 80,80",
  "# @end",
  '# @item doorway "Doorway" art',
  "vis 4",
  "rect 120,100 135,130",
  "# @end",
  '# @item rope "Rope" walk',
  "pri 0",
  "line 0,121 159,121",
  "# @end",
  "end",
].join("\n");
const ROOM_1 = [
  "if (isset(f5)) {",
  "  load.pic(v0); draw.pic(v0); show.pic(); load.view(0);",
  "  animate.obj(o0); set.view(o0, 0); position(o0, 40, 140); draw(o0);",
  "}",
  "return;",
  "",
].join("\n");
const ROOM_2 = [
  "if (isset(f5)) {",
  "  load.pic(v0); draw.pic(v0); show.pic(); load.view(0);",
  "  animate.obj(o0); set.view(o0, 0); position(o0, 20, 150); draw(o0);",
  "}",
  "if (equaln(v2, 4)) { new.room(1); }",
  "return;",
  "",
].join("\n");

function roomGame(): ReadonlyMap<string, Uint8Array> {
  const game = createContainer();
  const logic = (source: string) => assembleLogic(source, { dictionary: new Map() }).payload;
  game.putResource("logic", 0, logic("if (equaln(v0, 0)) { new.room(1); } call.v(v0); return;"));
  game.putResource("logic", 1, logic(ROOM_1));
  game.putResource("logic", 2, logic(ROOM_2));
  const pic = compileEditDocument(parsePictureDocument(PICTURE).document, DEFAULT_V2_PROFILE);
  game.putResource("picture", 1, pic.bytes);
  game.putResource("picture", 2, pic.bytes);
  game.putResource(
    "view",
    0,
    buildView({ loops: [{ cels: [{ width: 3, height: 6, pixels: new Array(18).fill(15) }] }] }),
  );
  return game.files;
}

function walkRig(
  options: {
    runner?: (input: RouteWorkerInbound) => Promise<RouteTestResult>;
    liveState?: () => Promise<LiveGameState | null>;
  } = {},
) {
  const files = roomGame();
  const resources = { files: Object.fromEntries(files), profile: DEFAULT_V2_PROFILE };
  const source: StudioRoomSource = studioRoomSource(resources, 1, ROOMS, undefined, {
    authoring: { version: 1, bindings: {}, world: { rooms: {}, facts: {}, quests: {} } },
    sources: { logics: [[1, ROOM_1]] },
  });
  const kept = parsePictureDocument(PICTURE).document;
  const shown = shallowRef<PictureDocument>(kept);
  const notices: StudioNotice[] = [];
  const runs: RouteWorkerInbound[] = [];
  const scope = effectScope();
  const made = scope.run(() => {
    const session = () => {
      const state = createAgentSessionState(openContainer(new Map(files)), DEFAULT_V2_PROFILE);
      state.authoring = structuredClone(source.authoring);
      return state;
    };
    const logic = useRoomLogicDraft({
      base: () =>
        source.logicSource ? { source: source.logicSource, bytes: source.logicBytes! } : null,
      session,
    });
    const ego: EgoShape = { ...DEFAULT_EGO, width: 3, height: 6 };
    const walk = useStudioWalk({
      walk: () => source,
      files: () => files,
      profile: () => DEFAULT_V2_PROFILE,
      pictureNumber: () => 1,
      keptPicture: () => kept,
      shownPicture: () => shown.value,
      pictureBytes: () => compileEditDocument(shown.value, DEFAULT_V2_PROFILE).bytes,
      priority: () => compileEditDocument(shown.value, DEFAULT_V2_PROFILE).priority,
      logic,
      labelAt: (x, y) => `the cell at ${x},${y}`,
      itemLabel: (id) => (id === "doorway" ? "Doorway" : id),
      ego: () => ego,
      say: (notice) => void (notice && notices.push(notice)),
      frozen: () => false,
      liveState: options.liveState,
      runner: async (input) => {
        runs.push(input);
        return options.runner
          ? options.runner(input)
          : testRoute({ ...input, game: new Map(Object.entries(input.files)) });
      },
    });
    return { logic, walk };
  })!;
  return { ...made, source, files, kept, shown, notices, runs, stop: () => scope.stop() };
}

describe("the room logic draft", () => {
  it("trusts the room's authored text and edits it one rule at a time, with undo", () => {
    const rig = walkRig();
    const { logic, walk } = rig;
    assert.equal(rig.source.logicSource, ROOM_1, "the stored text assembles to the booted bytes");
    assert.equal(logic.editable.value, true);
    assert.equal(walk.addDoor({ x1: 122, y1: 124, x2: 133, y2: 130 }), true);
    assert.equal(logic.dirty.value, true);
    assert.equal(logic.changes.value, 1);
    assert.match(
      logic.source.value,
      /\/\/ @rule door-1 "Door to room 2" exit\nif \(posn\(o0, 122, 124, 133, 130\)\) \{\n {2}new\.room\(2\);\n\}\n\/\/ @end\nreturn;/,
    );
    assert.equal(walk.selectedDoorId.value, "door-1");
    assert.equal(walk.selectedDoor.value?.contract?.status, "compiled");

    // A refused edit (a box off the picture) changes nothing and says why.
    const before = logic.source.value;
    assert.equal(walk.moveDoor("door-1", { x1: 150, y1: 124, x2: 170, y2: 130 }), false);
    assert.equal(logic.source.value, before);
    assert.match(rig.notices.at(-1)!.detail ?? "", /inside the 160x168 picture/);

    assert.equal(logic.undo(), true);
    assert.equal(logic.source.value, ROOM_1);
    assert.equal(logic.dirty.value, false);
    assert.equal(logic.redo(), true);
    assert.equal(logic.source.value, before);
    logic.discard();
    assert.equal(logic.source.value, ROOM_1);
    rig.stop();
  });

  it("stores a box following moved art in the kept frame, and the Keep moves it for real", () => {
    const rig = walkRig();
    const { logic, walk } = rig;
    walk.addDoor({ x1: 122, y1: 124, x2: 133, y2: 130 });
    assert.equal(walk.setFollows("door-1", "doorway"), true);
    // The doorway moves 20 px west in the draft picture.
    const moved = applyEdit(rig.kept, { type: "moveItem", itemId: "doorway", dx: -20, dy: 0 });
    assert.ok(!("error" in moved));
    rig.shown.value = moved.document;
    assert.deepEqual(walk.selectedDoor.value?.box, { x1: 102, y1: 124, x2: 113, y2: 130 });
    assert.match(logic.source.value, /posn\(o0, 122, 124, 133, 130\)/, "stored unmoved");
    const keep = logic.forKeep(rig.kept, moved.document);
    assert.ok(keep.ok && "bytes" in keep);
    assert.match(keep.source, /posn\(o0, 102, 124, 113, 130\)/);
    // Placing the box on screen stores it back in the kept frame.
    walk.moveDoor("door-1", { x1: 100, y1: 120, x2: 111, y2: 126 });
    assert.match(logic.source.value, /posn\(o0, 120, 120, 131, 126\)/);
    // The doorway moved 20 px west: the kept frame is 20 px east of the shown one.
    assert.deepEqual(
      toStored({ x1: 100, y1: 120, x2: 111, y2: 126 }, "doorway", rig.kept, moved.document),
      { x1: 120, y1: 120, x2: 131, y2: 126 },
    );
    assert.deepEqual(
      toShown({ x1: 120, y1: 120, x2: 131, y2: 126 }, "doorway", rig.kept, moved.document),
      { x1: 100, y1: 120, x2: 111, y2: 126 },
    );
    // Unbound, the box stays where it shows.
    walk.setFollows("door-1", null);
    assert.match(logic.source.value, /posn\(o0, 100, 120, 111, 126\)/);
    rig.stop();
  });

  it("adds an edge exit once per edge and never over a native one", () => {
    const rig = walkRig();
    const { walk } = rig;
    assert.equal(walk.addEdge("bottom"), true);
    assert.equal(walk.selectedDoor.value?.edge, "bottom");
    assert.equal(walk.addEdge("bottom"), false);
    assert.equal(rig.notices.at(-1)!.text, "The south edge already has an exit: change it here.");
    assert.equal(walk.setDestination("exit-south-1", 2), true);
    assert.match(rig.logic.source.value, /if \(equaln\(v2, 3\)\) \{\n {2}new\.room\(2\);\n\}/);
    assert.equal(walk.setFlag("exit-south-1", "cellar_open"), true);
    assert.deepEqual(rig.logic.reserved.value, { cellar_open: { kind: "flag", num: 32 } });
    rig.stop();
  });

  it("exposes broken rule annotations and refuses edits while they stand", () => {
    // Two rules named door-1: the second is dead text the editor cannot see.
    const duplicated = ROOM_1.replace(
      "return;",
      [
        '// @rule door-1 "West door" exit',
        "if (posn(o0, 122, 124, 133, 130)) { new.room(2); }",
        "// @end",
        '// @rule door-1 "West door again" exit',
        "if (posn(o0, 10, 124, 20, 130)) { new.room(2); }",
        "// @end",
        "return;",
      ].join("\n"),
    );
    const files = roomGame();
    const scope = effectScope();
    const logic = scope.run(() =>
      useRoomLogicDraft({
        base: () => ({
          source: duplicated,
          bytes: assembleLogic(duplicated, { dictionary: new Map() }).payload,
        }),
        session: () => createAgentSessionState(openContainer(new Map(files)), DEFAULT_V2_PROFILE),
      }),
    )!;
    assert.equal(logic.diagnostics.value.length, 1);
    assert.equal(logic.diagnostics.value[0]!.code, "duplicate-id");
    // Removing the first rule would resurrect the second under the same id:
    // every edit is refused and nothing changes.
    const before = logic.source.value;
    const refused = logic.apply({ op: "removeRule", id: "door-1" }, "Remove a door");
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok && refused.error.includes("'door-1'"), refused.ok ? "" : refused.error);
    assert.equal(logic.source.value, before);
    assert.equal(logic.past.value, 0);
    scope.stop();
  });
});

describe("test walks", () => {
  it("runs the engine on the draft with the estimate's path, and names what stopped it", async () => {
    const rig = walkRig({
      runner: async () => ({
        reached: false,
        outcome: "blocked",
        end: { x: 60, y: 122 },
        room: 1,
        steps: 18,
        cycles: 20,
        reason: "Blocked: …",
      }),
    });
    const { walk } = rig;
    walk.clickWalk({ x: 40, y: 140 });
    assert.equal(walk.prompt.value, "Click the goal.");
    walk.aim.value = { x: 60, y: 130 };
    assert.ok(walk.estimate.value?.path, "the estimate follows the aim");
    walk.addDoor({ x1: 122, y1: 124, x2: 133, y2: 130 });
    walk.clickWalk({ x: 60, y: 100 });
    assert.equal(walk.running.value, true);
    assert.equal(walk.prompt.value, "Walking…");
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(walk.running.value, false);
    const run = rig.runs[0]!;
    assert.deepEqual([run.room, run.from, run.to], [1, { x: 40, y: 140 }, { x: 60, y: 100 }]);
    // The throwaway copy carries the draft logic with the new door.
    const logic = openContainer(new Map(Object.entries(run.files))).getResource("logic", 1)!;
    assert.deepEqual(logic, rig.logic.bytes.value);
    // Ego stopped at 60,122 walking up: its footprint meets the rope at 60,121.
    assert.equal(walk.result.value?.title, "Blocked at the cell at 60,121");
    rig.stop();
  });

  it("walks with the live game's flags: a door gated by a flag is shut, then opens", async () => {
    let live: LiveGameState | null = null;
    const rig = walkRig({ liveState: async () => live });
    const { walk } = rig;
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      while (walk.running.value) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    // A door box just below the rope, open only while door_open (reserved as f32) is set.
    walk.addDoor({ x1: 60, y1: 122, x2: 72, y2: 127 });
    assert.equal(walk.setFlag("door-1", "door_open"), true);
    const flags = new Array<number>(256).fill(0);
    const vars = new Array<number>(256).fill(0);
    live = { flags, vars };
    // Straight up from 65,150: through the box at y 127..122, then the rope at y 121.
    walk.clickWalk({ x: 65, y: 150 });
    walk.clickWalk({ x: 65, y: 110 });
    await settle();
    assert.equal(walk.result.value?.title, "Blocked at the cell at 65,121");
    assert.equal(walk.result.value?.state, "live");
    const shut = rig.runs.at(-1)!;
    assert.deepEqual(
      shut.flags?.find((flag) => flag.id === 32),
      { id: 32, value: false },
    );
    // Only the game's own state: flags from f16, variables from v27.
    assert.equal(shut.flags?.length, 240);
    assert.equal(shut.flags?.[0]?.id, 16);
    assert.equal(shut.vars?.length, 229);
    assert.equal(shut.vars?.[0]?.id, 27);

    // The live game sets the flag: the same walk goes through the door.
    flags[32] = 1;
    vars[40] = 7;
    walk.again();
    await settle();
    assert.equal(walk.result.value?.title, "Went to room 2 (Green room)");
    assert.equal(walk.result.value?.state, "live");
    assert.deepEqual(
      rig.runs.at(-1)!.vars?.find((v) => v.id === 40),
      { id: 40, value: 7 },
    );
    assert.equal(walk.selectedDoor.value?.id, "door-1");

    // Switched off, or with no live game, the walk starts fresh: the door is shut again.
    walk.setUseLiveState(false);
    walk.again();
    await settle();
    assert.equal(walk.result.value?.state, "fresh");
    assert.equal(walk.result.value?.title, "Blocked at the cell at 65,121");
    assert.equal(rig.runs.at(-1)!.flags, undefined);
    walk.setUseLiveState(true);
    live = null;
    walk.again();
    await settle();
    assert.equal(walk.result.value?.state, "fresh");
    rig.stop();
  });

  it("certifies only the door a walk went through, on the draft and state it ran on", async () => {
    let release: () => void = () => {};
    let hold = false;
    const rig = walkRig({
      liveState: async () => ({ flags: new Array(256).fill(0), vars: new Array(256).fill(0) }),
      runner: async () => {
        if (hold) await new Promise<void>((resolve) => (release = resolve));
        return {
          reached: false,
          outcome: "room_changed",
          end: { x: 20, y: 150 },
          room: 2,
          steps: 30,
          cycles: 40,
          reason: "Changed room",
        };
      },
    });
    const { walk } = rig;
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      while (walk.running.value) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const tested = (id: string) =>
      doorStatus(
        walk.doors.value.find((door) => door.id === id)!,
        walk.tested.value.has(id),
      ).testedOk;
    // Two doors to the same room: the walk from 65,150 up to 65,110 crosses only door-1.
    walk.addDoor({ x1: 60, y1: 122, x2: 72, y2: 127 });
    walk.addDoor({ x1: 120, y1: 140, x2: 132, y2: 146 });
    assert.deepEqual(
      walk.doors.value.map((door) => door.destination),
      [2, 2],
    );
    walk.clickWalk({ x: 65, y: 150 });
    walk.clickWalk({ x: 65, y: 110 });
    await settle();
    assert.equal(walk.result.value?.title, "Went to room 2 (Green room)");
    assert.equal(walk.result.value?.door, "door-1");
    assert.equal(tested("door-1"), true);
    assert.equal(tested("door-2"), false, "a door to the same room is not certified");

    // Another walk mode is another state preset: the evidence does not carry over.
    walk.setUseLiveState(false);
    assert.equal(tested("door-1"), false);
    walk.setUseLiveState(true);
    assert.equal(tested("door-1"), true);

    // An edit makes a new draft: the result is stale and certifies nothing.
    assert.equal(walk.setDestination("door-2", 1), true);
    assert.equal(tested("door-1"), false);
    assert.equal(walk.resultStale.value, true);
    rig.logic.undo();
    assert.equal(tested("door-1"), true, "back on the walked draft, its evidence holds");

    // Clear forgets it.
    walk.clearWalk();
    assert.equal(tested("door-1"), false);

    // A walk still running when the draft changes lands stale: it certifies nothing now.
    hold = true;
    walk.clickWalk({ x: 65, y: 150 });
    walk.clickWalk({ x: 65, y: 110 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(walk.setDestination("door-2", 1), true);
    release();
    await settle();
    assert.equal(walk.result.value?.door, "door-1");
    assert.equal(walk.resultStale.value, true);
    assert.equal(tested("door-1"), false);
    rig.stop();
  });

  it("a room change no door explains reaches the room and certifies no door", async () => {
    const rig = walkRig({
      runner: async () => ({
        reached: false,
        outcome: "room_changed",
        end: { x: 20, y: 150 },
        room: 2,
        steps: 3,
        cycles: 5,
        reason: "Changed room",
      }),
    });
    const { walk } = rig;
    walk.addDoor({ x1: 120, y1: 140, x2: 132, y2: 146 });
    // From 40,140 to 60,150: nowhere near the door box.
    walk.clickWalk({ x: 40, y: 140 });
    walk.clickWalk({ x: 60, y: 150 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    while (walk.running.value) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(walk.result.value?.title, "Reached room 2 (Green room)");
    assert.equal(walk.result.value?.door, null);
    assert.equal(walk.tested.value.size, 0);
    rig.stop();
  });

  it("a goal against an edge exit walks to that edge and steps across it", async () => {
    let outcome: RouteTestResult = {
      reached: true,
      outcome: "room_changed",
      end: { x: 150, y: 140 },
      room: 2,
      steps: 40,
      cycles: 42,
      reason: "Crossed",
    };
    const rig = walkRig({ runner: async () => outcome });
    const { walk } = rig;
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      while (walk.running.value) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    assert.equal(walk.addEdge("left"), true);
    walk.selectDoor(null);
    walk.clickWalk({ x: 40, y: 140 });
    walk.aim.value = { x: 1, y: 135 };
    assert.deepEqual(
      walk.estimate.value?.path?.at(-1),
      { x: 0, y: 135 },
      "the estimate ends on the edge",
    );
    walk.clickWalk({ x: 1, y: 135 });
    await settle();
    const run = rig.runs.at(-1)!;
    assert.deepEqual([run.to, run.cross], [{ x: 0, y: 135 }, "left"]);
    assert.equal(walk.result.value?.title, "Went to room 2 (Green room)");
    assert.equal(walk.result.value?.door, "exit-west-1");
    assert.equal(walk.tested.value.has("exit-west-1"), true);

    // A walk that does not get there says so, and the door says why it is untested.
    walk.clearWalk();
    outcome = { ...outcome, reached: false, outcome: "blocked", end: { x: 20, y: 122 }, room: 1 };
    walk.clickWalk({ x: 40, y: 140 });
    walk.clickWalk({ x: 0, y: 150 });
    await settle();
    // It stopped at 20,122, just under the rope (y 121). Every step on toward
    // the goal down at the west edge — 19,123, 19,122, 20,123 — is floor, so
    // nothing refused it there and the card names no blocker.
    assert.equal(walk.result.value?.title, "Couldn't reach the west edge from here");
    assert.equal(walk.tested.value.has("exit-west-1"), false);
    assert.equal(
      walk.doorNote("exit-west-1"),
      "Last test walk from 40,140: Couldn't reach the west edge from here.",
    );
    rig.stop();
  });

  it("a goal on a door box aims at the floor inside it, or says no floor reaches it", async () => {
    const rig = walkRig({
      runner: async () => ({
        reached: false,
        outcome: "room_changed",
        end: { x: 20, y: 150 },
        room: 2,
        steps: 20,
        cycles: 22,
        reason: "Changed room",
      }),
    });
    const { walk } = rig;
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      while (walk.running.value) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    // A box straddling the rope (y 121): its centre is on the wall, its floor from y 122.
    walk.addDoor({ x1: 60, y1: 110, x2: 72, y2: 125 });
    walk.clickWalk({ x: 66, y: 150 });
    walk.clickWalk({ x: 66, y: 115 });
    await settle();
    assert.deepEqual(rig.runs.at(-1)!.to, { x: 66, y: 122 });
    assert.equal(rig.runs.at(-1)!.cross, undefined);
    assert.equal(walk.tested.value.has("door-1"), true);

    // A box wholly beyond the rope: no floor in reach, no walk, and it says so.
    walk.addDoor({ x1: 60, y1: 60, x2: 72, y2: 100 });
    walk.clickWalk({ x: 66, y: 150 });
    walk.clickWalk({ x: 66, y: 80 });
    await settle();
    assert.equal(rig.runs.length, 1, "no engine walk without a floor cell to aim at");
    assert.equal(
      walk.failure.value,
      "Couldn't reach the door box from here: no floor in or at it is in reach of the start.",
    );
    assert.equal(walk.doorNote("door-2"), `Last test walk from 66,150: ${walk.failure.value}`);
    rig.stop();
  });

  it("walks the tutorial lab for real: from the west door to the lever plate", async () => {
    const tutorial = buildTutorial();
    const files = new Map(Object.entries(tutorial.files));
    const resources = { files: tutorial.files, profile: DEFAULT_V2_PROFILE };
    const source = studioRoomSource(
      resources,
      2,
      [],
      undefined,
      tutorial.project!.authoringState as Record<string, unknown>,
    );
    assert.ok(source.logicSource, "the tutorial's lab logic text is trusted");
    const kept = parsePictureDocument(
      (
        tutorial.project!.authoringState as { sources: { pictures: [number, string][] } }
      ).sources.pictures.find(([num]) => num === 2)![1],
    ).document;
    const compiled = compileEditDocument(kept, DEFAULT_V2_PROFILE);
    const scope = effectScope();
    const walk = scope.run(() => {
      const logic = useRoomLogicDraft({
        base: () => ({ source: source.logicSource!, bytes: source.logicBytes! }),
        session: () => {
          const state = createAgentSessionState(openContainer(new Map(files)), DEFAULT_V2_PROFILE);
          state.authoring = structuredClone(source.authoring);
          return state;
        },
      });
      return useStudioWalk({
        walk: () => source,
        files: () => files,
        profile: () => DEFAULT_V2_PROFILE,
        pictureNumber: () => 2,
        keptPicture: () => kept,
        shownPicture: () => kept,
        pictureBytes: () => compiled.bytes,
        priority: () => compiled.priority,
        logic,
        labelAt: () => undefined,
        itemLabel: (id) => id,
        ego: () => DEFAULT_EGO,
        say: () => {},
        frozen: () => false,
        runner: async (input) =>
          testRoute({ ...input, game: new Map(Object.entries(input.files)) }),
      });
    })!;
    // The lab's west exit is native: it leads to the gallery, and the gallery leads back.
    const west = walk.doors.value.find((door) => door.edge === "left")!;
    assert.equal(west.editable, false);
    assert.equal(west.destination, 1);
    walk.startFromDoor(west.id);
    assert.deepEqual(walk.start.value, { x: 18, y: 151 }, "the gallery's else-branch arrival");
    walk.clickWalk({ x: 30, y: 140 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    while (walk.running.value) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(walk.result.value?.title, "Reached", walk.result.value?.result.reason ?? "");
    assert.deepEqual(walk.result.value?.result.end, { x: 30, y: 140 });

    // A goal on the west edge: the engine walks there, steps across, and the
    // room's own v2 check sends ego to the gallery. That certifies the door.
    assert.equal(walk.tested.value.has(west.id), false);
    walk.clickWalk({ x: 30, y: 140 });
    walk.clickWalk({ x: 0, y: 130 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    while (walk.running.value) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      walk.result.value?.title,
      "Went to room 1 (Picture Gallery)",
      walk.result.value?.result.reason ?? "",
    );
    assert.equal(walk.result.value?.door, west.id);
    assert.equal(walk.tested.value.has(west.id), true);
    scope.stop();
  });
});
