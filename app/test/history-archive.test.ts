import assert from "node:assert/strict";
import { stampBoot } from "../../src/agent/history.ts";
import { test } from "node:test";
import { readHistoryArchive } from "../src/historyArchive.ts";
import { testProjectId, testRevision } from "./identity.ts";

const recording = {
  version: 1,
  identity: { project: testProjectId("archive"), revision: testRevision("archive") },
  profile: "2.936",
  resourceSet: "archive",
  startedAt: 1,
  segments: [],
};
const branch = {
  boot: stampBoot({
    files: {},
    dictionary: [],
    authorRooms: false,
    rng: 7,
    soundDevice: 1,
    resourceSet: "archive",
    requestSerial: 0,
  }),
  from: null,
  retainedAt: 1,
};
function read(extra: Record<string, unknown>) {
  return readHistoryArchive(
    new TextEncoder().encode(
      JSON.stringify({
        format: "monotio.agi.history",
        version: 1,
        recording,
        ...extra,
      }),
    ),
  );
}

test("history archives reject branches without IDs instead of backfilling", () => {
  assert.throws(() => read({ branches: [branch] }), /retained branch is invalid/);
  assert.equal(read({ branches: [{ ...branch, id: "kept" }] }).branches?.[0]?.id, "kept");
});
