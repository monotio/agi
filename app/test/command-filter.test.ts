import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyFilter } from "../src/shell/commands/fuzzyFilter.ts";

test("fuzzy filtering matches subsequences, ranks exact and contiguous matches, and preserves ties", () => {
  const entries = [
    { title: "ROOM 1 Meadow" },
    { title: "ROOM 2 Mill" },
    { title: "SOUND 1" },
    { title: "ROOM 3 Marsh" },
  ];
  assert.deepEqual(
    fuzzyFilter(entries, "r1m", (e) => e.title),
    [entries[0]],
  );
  assert.deepEqual(
    fuzzyFilter(entries, "  ROOM  ", (e) => e.title),
    [entries[0], entries[1], entries[3]],
  );
  assert.deepEqual(
    fuzzyFilter(entries, "zz", (e) => e.title),
    [],
  );
  assert.deepEqual(
    fuzzyFilter(entries, "", (e) => e.title),
    entries,
  );
  assert.deepEqual(
    fuzzyFilter(["Step into", "Stop debugging", "Step"], "step", (e) => e),
    ["Step", "Step into"],
  );
});
