import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { prepareRoomPatch } from "../src/agent/roomPatch.ts";
import { StubAgent } from "../app/src/agent/stubAgent.ts";

const dictionary = new Map([["look", 100]]);
const logic = Array.from(assembleLogic("return;", { dictionary }).payload);
const picture = [0xff];
const response = {
  room: 7,
  resources: [
    { kind: "logic", num: 7, data: logic },
    { kind: "picture", num: 7, data: picture },
  ],
  words: [
    ["look", 100],
    ["gate", 101],
  ],
};

test("room patches validate complete resources and vocabulary without changing the live container", () => {
  const container = createContainer();
  const before = [...container.files].map(([name, bytes]) => [name, bytes.slice()]);
  const patch = prepareRoomPatch(container, 7, JSON.stringify(response), dictionary);
  assert.deepEqual(
    patch.resources.map((r) => [r.kind, r.num, Array.from(r.payload)]),
    [
      ["logic", 7, logic],
      ["picture", 7, picture],
    ],
  );
  assert.deepEqual(patch.words, [
    ["look", 100],
    ["gate", 101],
  ]);
  assert.deepEqual([...container.files], before);
});

for (const [name, bad, error] of [
  ["wrong destination", { ...response, room: 8 }, /Invalid room authoring/],
  [
    "missing picture",
    { ...response, resources: response.resources.slice(0, 1) },
    /logic and picture/,
  ],
  [
    "invalid bytes after valid logic",
    { ...response, resources: [response.resources[0], { kind: "picture", num: 7, data: [256] }] },
    /Invalid room resource/,
  ],
  ["vocabulary reassignment", { ...response, words: [["look", 101]] }, /existing vocabulary/],
  [
    "duplicate resource",
    { ...response, resources: [...response.resources, response.resources[0]] },
    /Duplicate room resource/,
  ],
] as const) {
  test(`room patches reject ${name} without a partial write`, () => {
    const container = createContainer();
    assert.throws(() => prepareRoomPatch(container, 7, JSON.stringify(bad), dictionary), error);
    assert.equal(container.getResource("logic", 7), null);
  });
}

test("room patches cannot overwrite another room", () => {
  const container = createContainer();
  container.putResource("logic", 1, new Uint8Array(logic));
  const bad = {
    ...response,
    resources: [...response.resources, { kind: "logic", num: 1, data: logic }],
  };
  assert.throws(() => prepareRoomPatch(container, 7, JSON.stringify(bad), dictionary), /overwrite/);
});

test("a fresh stub session authors the requested room number after a reload", async () => {
  const agent = new StubAgent(() => {});
  const raw = await agent.handle({ op: "room", context: { room: 7, from: 6 } });
  const patch = prepareRoomPatch(createContainer(), 7, raw, dictionary);
  assert.deepEqual(
    patch.resources.map((r) => [r.kind, r.num]),
    [
      ["logic", 7],
      ["picture", 7],
    ],
  );
});

test("room inventory extends existing item identities without changing the live table", async () => {
  const { buildObjectFile } = await import("../src/agent/tools.ts");
  const container = createContainer();
  const previous = buildObjectFile([{ name: "Old key", startingRoom: 1 }]);
  container.putFile("OBJECT", previous);
  const objects = buildObjectFile([
    { name: "Old key", startingRoom: 1 },
    { name: "Letter", startingRoom: 255 },
  ]);
  const patch = prepareRoomPatch(
    container,
    7,
    JSON.stringify({ ...response, objects: [...objects] }),
    dictionary,
  );
  assert.deepEqual(patch.objects, objects);
  assert.deepEqual(container.files.get("OBJECT"), previous);
  const replacement = buildObjectFile([{ name: "Letter", startingRoom: 255 }]);
  assert.throws(
    () =>
      prepareRoomPatch(
        container,
        7,
        JSON.stringify({ ...response, objects: [...replacement] }),
        dictionary,
      ),
    /existing inventory/,
  );
});
