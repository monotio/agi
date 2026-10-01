import assert from "node:assert/strict";
import { test } from "node:test";
import { recordPlayerSentence, resolvePlayerSentence } from "../src/project/playerSentences.ts";
test("local player sentences count per room and resolve individually", () => {
  const first = recordPlayerSentence([], { text: "pick flower", room: 1, unknown: "pick" });
  const rows = recordPlayerSentence(
    recordPlayerSentence(first, { text: "pick flower", room: 1, unknown: "pick" }),
    { text: "pick flower", room: 2, unknown: "pick" },
  );
  assert.deepEqual(
    rows.map((r) => [r.room, r.count]),
    [
      [1, 2],
      [2, 1],
    ],
  );
  assert.deepEqual(
    resolvePlayerSentence(rows, rows[0]!).map((r) => r.room),
    [2],
  );
});

test("each unresolved sentence remains available until the builder resolves it", () => {
  let rows = [] as ReturnType<typeof recordPlayerSentence>;
  for (let index = 0; index < 201; index++)
    rows = recordPlayerSentence(rows, { text: `command ${index}`, room: 1, unknown: "command" });
  rows = recordPlayerSentence(rows, { text: "command 0", room: 1, unknown: "command" });
  assert.equal(rows.length, 201);
  assert.equal(rows[0]?.count, 2);
});
