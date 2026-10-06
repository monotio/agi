import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceParts, workspaceOpenParts } from "../src/studio/host/workspaceParts.ts";

test("rooms own their pictures; shared logic and unowned resources stay reachable", () => {
  const groups = workspaceParts({
    keys: [
      "logic:0",
      "logic:1",
      "logic:255",
      "picture:3",
      "picture:9",
      "view:0",
      "sound:1",
      "inventory",
      "words",
    ],
    rooms: [{ room: 1, title: "Meadow", pictures: [3] }],
    names: { "view:0": "Hero" },
    currentRoom: 1,
  });
  assert.deepEqual(
    groups.map((g) => g.label),
    ["GAME STATE", "ROOMS", "SHARED LOGIC", "PICTURES", "VIEWS", "SOUNDS", "OBJECTS", "WORDS"],
  );
  assert.deepEqual(
    groups[0]?.entries.map((entry) => [entry.label, entry.key]),
    [
      ["Game state", "state"],
      ["Problems", "problems"],
      ["Messages", "messages"],
      ["Notes", "notes"],
    ],
  );
  assert.deepEqual(
    groups[1]?.entries.map((e) => [e.label, e.key, e.live]),
    [
      ["Meadow · ROOM 1", "logic:1", true],
      ["PICTURE 3", "picture:3", false],
      ["LOGIC 1", "logic:1", false],
    ],
  );
  assert.deepEqual(
    groups[2]?.entries.map((e) => e.label),
    ["Start-up and menus · LOGIC 0", "Game over · LOGIC 255"],
  );
  assert.deepEqual(
    groups[3]?.entries.map((e) => e.key),
    ["picture:9"],
  );
  assert.equal(groups[4]?.entries[0]?.label, "Hero · VIEW 0");
});

test("a picture shared by rooms remains listed in each room and appears once in quick open", () => {
  const groups = workspaceParts({
    keys: ["logic:1", "logic:2", "picture:4"],
    rooms: [
      { room: 1, pictures: [4] },
      { room: 2, pictures: [4] },
    ],
    currentRoom: 2,
  });
  assert.equal(groups[1]?.entries.filter((e) => e.key === "picture:4").length, 2);
  assert.equal(groups[3]?.entries.length, 0);
  const quick = workspaceOpenParts(groups);
  assert.equal(quick.filter((row) => row.key === "picture:4").length, 1);
  assert.equal(quick.find((row) => row.key === "logic:1")?.label, "ROOM 1 · LOGIC 1");
  assert.equal(groups[1]?.entries.find((e) => e.label === "ROOM 2")?.live, true);
});
