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
import { createAgentSessionState } from "../../src/agent/tools.ts";
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
  doorStatus,
  edgeAt,
  entrySpot,
  outcomeTitle,
  refusedCell,
  walkDoors,
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
    assert.equal(doors[3]!.label, "Planned exit by a command or script");
  });

  it("words where a door leads and its two sides", () => {
    assert.equal(destinationLabel(2, ROOMS), "→ Green room");
    assert.equal(destinationLabel(7, ROOMS), "→ Room 7");
    const none = new Set<number>();
    assert.deepEqual(doorStatus({ destination: 2, contract: contract({}) }, none), {
      wayBack: "One-way",
      tested: "Not tested yet",
      testedOk: false,
    });
    const back = contract({
      wayBack: ["right", null, "right"],
      status: "tested",
      testedBy: ["route"],
    });
    assert.deepEqual(doorStatus({ destination: 2, contract: back }, none), {
      wayBack: "Way back: yes, via the east edge or a door or command",
      tested: "Tested ✓ (route)",
      testedOk: true,
    });
    // A test walk that went to the room covers the door this session.
    assert.equal(
      doorStatus({ destination: 2, contract: contract({}) }, new Set([2])).tested,
      "Tested ✓ (test walk)",
    );
    assert.equal(
      doorStatus({ destination: 2, contract: null }, none).wayBack,
      "Not in the room's logic until you Keep",
    );
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
    assert.equal(words("start_blocked"), "The player can't stand at the start");
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
    assert.deepEqual(
      toShown({ x1: 120, y1: 120, x2: 131, y2: 126 }, "doorway", rig.kept, moved.document),
      toShown(
        toStored({ x1: 100, y1: 120, x2: 111, y2: 126 }, "doorway", rig.kept, moved.document),
        "doorway",
        rig.kept,
        moved.document,
      ),
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
    scope.stop();
  });
});
