import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import type { AuthoringState } from "../src/agent/authoringState.ts";
import type { RoomObservation } from "../src/agent/roomMap.ts";
import { parseLogicDocument } from "../src/studio/rules/logicDocument.ts";
import { readRules } from "../src/studio/rules/ruleModel.ts";
import { roomExitContracts, type ExitContract } from "../src/studio/rules/ruleUsage.ts";
import { TUTORIAL_GAME_TESTS } from "../games/adventure-department/tests.ts";
import { buildTutorial } from "../games/adventure-department/game.ts";

function tutorialLogics(): Map<number, Uint8Array> {
  const game = buildTutorial();
  const container = openContainer(new Map(Object.entries(game.files)));
  const logics = new Map<number, Uint8Array>();
  for (const num of [0, 1, 2, 3]) logics.set(num, container.getResource("logic", num)!);
  return logics;
}

/** The tutorial's shipped world plan: east 2 from room 1, west 1 and east 3 from room 2, west 2 from room 3. */
const PLAN = (
  buildTutorial().project!.authoringState as {
    authoring: { world: { rooms: AuthoringState["world"]["rooms"] } };
  }
).authoring.world.rooms;

/** The fields a contract pins, compactly. */
const exit = (
  edge: ExitContract["edge"],
  destination: number,
  wayBack: ExitContract["wayBack"],
  at: [number, number],
  testedBy: string[] = [],
): ExitContract => ({
  edge,
  destination,
  status: testedBy.length ? "tested" : "compiled",
  planned: true,
  compiled: true,
  testedBy,
  rule: null,
  wayBack,
  twoSided: true,
  // Every tutorial doorway returns through the opposite edge.
  reciprocal: edge !== null,
  arrival: { source: "logic", x: at[0], y: at[1], conditional: false },
});

describe("exit contracts", () => {
  it("finds every tutorial exit two-sided, with its arrival spot", () => {
    const logics = tutorialLogics();
    const contracts = (room: number) =>
      roomExitContracts({ room, logics, plan: PLAN, tests: TUTORIAL_GAME_TESTS });
    const connects = ['test "the exhibits connect east and west"'];
    // Room 2 places ego at (132,151) when it comes from room 3, else (18,151);
    // room 1 at (132,151) from room 2; room 3 always at (18,151).
    assert.deepEqual(contracts(1), [
      exit(null, 2, [null, "left"], [18, 151], connects),
      exit("right", 2, [null, "left"], [18, 151], connects),
    ]);
    assert.deepEqual(contracts(2), [
      exit(null, 1, [null, "right"], [132, 151]),
      exit(null, 3, [null, "left"], [18, 151]),
      exit("left", 1, [null, "right"], [132, 151]),
      exit("right", 3, [null, "left"], [18, 151]),
    ]);
    assert.deepEqual(contracts(3), [
      exit(null, 2, [null, "right"], [132, 151]),
      exit("left", 2, [null, "right"], [132, 151]),
    ]);
    for (const room of [1, 2, 3])
      for (const contract of contracts(room))
        assert.ok(contract.twoSided, `room ${room} ${contract.edge} exit has no way back`);
  });

  it("reports one-way edge and door exits, a plan-only exit, arrivals and a route", () => {
    const logics = tutorialLogics();
    // Room 4 has an exit to room 5 but room 5 never returns; room 5 has no position().
    const dictionary = new Map<string, number>();
    const source = [
      '// @rule east "East" exit',
      "if (equaln(v2, 2)) {",
      "  new.room(5);",
      "}",
      "// @end",
      '// @rule cellar "Cellar door" exit',
      "if (posn(o0, 10, 140, 20, 150)) {",
      "  new.room(5);",
      "}",
      "// @end",
      "return;",
    ].join("\n");
    logics.set(4, assembleLogic(source, { dictionary }).payload);
    logics.set(5, assembleLogic("return;", { dictionary }).payload);
    const document = parseLogicDocument(source).document;
    const observed: RoomObservation[] = [
      {
        seq: 1,
        session: 1,
        from: 4,
        to: 5,
        cause: "edge",
        edge: "right",
        cycle: 9,
        resourceSet: "x",
        scoreDelta: 0,
        gained: [],
        lost: [],
      },
    ];
    assert.deepEqual(
      roomExitContracts({
        room: 4,
        logics,
        plan: { "4": { title: "", description: "", exits: { north: 6 } } },
        observed,
        rules: readRules(document),
      }),
      [
        {
          edge: "right",
          destination: 5,
          status: "tested",
          planned: false,
          compiled: true,
          testedBy: ["route"],
          rule: "east",
          wayBack: [],
          twoSided: false,
          reciprocal: false,
          arrival: { source: "edge", side: "left" },
        },
        {
          // A door is an edgeless transition: ego keeps its x,y in a room that does not place it.
          edge: null,
          destination: 5,
          status: "compiled",
          planned: false,
          compiled: true,
          testedBy: [],
          rule: "cellar",
          wayBack: [],
          twoSided: false,
          reciprocal: false,
          arrival: { source: "kept" },
        },
        {
          edge: "top",
          destination: 6,
          status: "planned",
          planned: true,
          compiled: false,
          testedBy: [],
          rule: null,
          wayBack: [],
          twoSided: false,
          reciprocal: false,
          arrival: { source: "missing" },
        },
      ],
    );
  });
});
