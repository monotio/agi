import assert from "node:assert/strict";
import { test } from "node:test";
import { stampBoot, validateHistoryRecording } from "../../src/agent/history.ts";
import { historyArchiveData, readHistoryArchive } from "../src/archive/historyArchive.ts";
import { testProjectId, testRevision } from "./identity.ts";

function debuggerTail(version: number) {
  return {
    version,
    identity: { project: testProjectId("debug-history"), revision: testRevision("debug-history") },
    profile: "2.936",
    resourceSet: "debug-history",
    startedAt: 1,
    segments: [
      {
        id: "s1",
        boot: stampBoot({
          files: {},
          dictionary: [],
          authorRooms: false,
          rng: 1,
          soundDevice: 1,
          resourceSet: "debug-history",
          requestSerial: 0,
        }),
        anchors: [],
        marks: [],
        sync: [],
        events: [{ seq: 0, tick: 0, cycle: 0, cause: { kind: "end", reason: "debugger" } }],
        end: { seq: 1, tick: 0, cycle: 0, reason: "debugger" },
      },
    ],
  };
}

test("version 2 history retains an explicit debugger hiatus through archive roundtrip", () => {
  const input = debuggerTail(2);
  const before = structuredClone(input);
  const recording = validateHistoryRecording(input);
  const encoded = historyArchiveData({ recording });
  const decoded = readHistoryArchive(new TextEncoder().encode(encoded));
  assert.equal(decoded.recording.version, 2);
  assert.equal(decoded.recording.segments[0]?.end?.reason, "debugger");
  assert.deepEqual(decoded.recording.segments[0]?.events[0]?.cause, {
    kind: "end",
    reason: "debugger",
  });
  assert.equal(historyArchiveData(decoded), encoded);
  assert.deepEqual(input, before, "reading must not modify the supplied recording");
});

test("a version 1 recording cannot smuggle a debugger reason in either end location", () => {
  for (const location of ["event", "metadata"] as const) {
    const input = debuggerTail(1);
    if (location === "event") input.segments[0]!.end.reason = "eject";
    else input.segments[0]!.events[0]!.cause.reason = "eject";
    const before = structuredClone(input);
    assert.throws(() => validateHistoryRecording(input), /reason|version|debugger/i);
    assert.deepEqual(input, before);
  }
});
