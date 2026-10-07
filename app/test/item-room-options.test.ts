import { test } from "node:test";
import assert from "node:assert/strict";
import { itemRoomOptions } from "../src/studio/workspace/itemRoomOptions.ts";

test("item locations keep special meanings and numeric room order with shared names", () => {
  assert.deepEqual(
    itemRoomOptions({
      rooms: [
        { room: 8, title: "Garden" },
        { room: 3 },
        { room: 1, title: "Meadow" },
        { room: 255, title: "Reserved" },
        { room: 0, title: "Reserved" },
      ],
    }),
    [
      { num: 255, label: "Carried by the player" },
      { num: 0, label: "Nowhere" },
      { num: 1, label: "Meadow · Room 1" },
      { num: 3, label: "Room 3" },
      { num: 8, label: "Garden · Room 8" },
    ],
  );
});
