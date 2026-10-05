import assert from "node:assert/strict";
import { test } from "node:test";
import { scanContainerExits, mergeRoomGraph } from "../src/agent/roomMap.ts";
import { detectProfile } from "../src/runtime/profile.ts";
import { loadGame } from "./game-fixture.ts";
import { fixtureSkip, KNOWN_GAME_HASH } from "./fixtures.ts";

// Independently enumerated picture/ego entry LOGICs and incoming targets in
// LSL1, AGI 2.440. Its rooms set v76; LOGIC 0 performs the transition.
const ROOMS = [
  1, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 21, 22, 23, 24, 25, 31, 32, 33, 34, 35, 36,
  37, 38, 40, 41, 42, 43, 44, 45,
];

test(
  "LSL1 map includes 33 rooms and 142 known directed exits",
  {
    skip: fixtureSkip(KNOWN_GAME_HASH.LSL1),
  },
  () => {
    const { container, files } = loadGame(KNOWN_GAME_HASH.LSL1, { interpreterFiles: true });
    const logics = new Map<number, Uint8Array>();
    for (let n = 0; n < 256; n++) {
      const payload = container.getResource("logic", n);
      if (payload) logics.set(n, payload);
    }
    const analysis = scanContainerExits(logics, detectProfile(files), { main: true });
    const graph = mergeRoomGraph({ ...analysis, experience: "create", journal: [] });
    assert.equal(graph.nodes.length, 33);
    assert.deepEqual(
      graph.nodes.map((node) => node.room),
      ROOMS,
    );
    // 76 room routes plus the two shared menu destinations from all 33 rooms.
    assert.equal(graph.edges.length, 142);
    const exits = new Set(graph.edges.map((edge) => `${edge.from}->${edge.to}`));
    for (const route of [
      "11->12",
      "12->17",
      "21->22",
      "22->23",
      "31->38",
      "38->31",
      "44->45",
      "45->44",
    ])
      assert.ok(exits.has(route), route);
    assert.ok(ROOMS.every((room) => !analysis.shared.has(room)));
    assert.ok(graph.nodes.some((node) => node.variableExit));
    assert.ok(graph.nodes.find((node) => node.room === 6)?.unknownCalls);
  },
);
