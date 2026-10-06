import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

// Regression identities for the reviewed node/route sets. The hash orders
// room numbers and directed route records exactly as the graph contract does.
for (const [name, rooms, routes, identity] of [
  ["PQ1", 73, 1046, "2b804049d4bb2143d4cf509018930498a71378e228ac60f87f2c0fdab5a1b00b"],
  ["KQ1", 81, 272, "7d806e87cad1c8837dc7dff5e05babc7341294a36265c918d80267ecf84e0ced"],
  ["SQ1", 74, 278, "4204df2c35e918f5d30eb3b94809b905d4920ab177c09ef71ce5d4b6825d8044"],
  ["LSL1", 33, 142, "ae03ab839c42b90389bb25c2c6c549c27ff51a67a7c60dab5bc02c9385c228a4"],
] as const) {
  test(
    `${name} retains its ${rooms} rooms and ${routes} directed routes`,
    { skip: fixtureSkip(KNOWN_GAME_HASH[name]) },
    () => {
      const { container, files } = loadGame(KNOWN_GAME_HASH[name], { interpreterFiles: true });
      const logics = new Map<number, Uint8Array>();
      for (let n = 0; n < 256; n++) {
        const payload = container.getResource("logic", n);
        if (payload) logics.set(n, payload);
      }
      const analysis = scanContainerExits(logics, detectProfile(files), { main: true });
      const graph = mergeRoomGraph({ ...analysis, experience: "create", journal: [] });
      assert.equal(graph.nodes.length, rooms);
      assert.equal(graph.edges.length, routes);
      const canonical = JSON.stringify({
        rooms: graph.nodes.map((node) => node.room),
        routes: graph.edges.map((edge) => [edge.from, edge.to, edge.label ?? ""]),
      });
      assert.equal(createHash("sha256").update(canonical).digest("hex"), identity);
    },
  );
}
