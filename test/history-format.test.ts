/**
 * The recording contract's version gate. Version 1 is the released format;
 * version 2 adds the "debugger" end reason a segment sealed for a debugger
 * hiatus carries. The reader accepts both versions and preserves the
 * record's own stamp — reading is not a migration — while applying the
 * reason rules of the version the record was written under: a v1 tape
 * cannot smuggle a reason its released reader never knew, and an unknown
 * version is refused outright instead of being rewritten.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HISTORY_FORMAT_READ_VERSIONS,
  HISTORY_FORMAT_VERSION,
  stampBoot,
  validateHistoryRecording,
  type HistoryEndReason,
} from "../src/agent/history.ts";
import { requireProjectId, requireResourceRevision } from "../src/gameIdentity.ts";

const IDENTITY = {
  project: requireProjectId("format-history"),
  revision: requireResourceRevision("1".repeat(64)),
};

const BOOT = stampBoot({
  files: { "VOL.0": "eA==" },
  dictionary: [],
  authorRooms: false,
  rng: 7,
  soundDevice: 1,
  resourceSet: "rev-1",
  requestSerial: 0,
});

/**
 * A minimal well-formed recording: one segment, an optional end event and
 * optional end metadata, each carrying the given reason verbatim.
 */
function endedRecording(version: unknown, reasons: { event?: unknown; end?: unknown } = {}) {
  return {
    version,
    identity: IDENTITY,
    profile: "2.936",
    resourceSet: "rev-1",
    startedAt: 42,
    segments: [
      {
        id: "s1",
        boot: BOOT,
        anchors: [],
        events:
          reasons.event === undefined
            ? []
            : [{ seq: 0, tick: 1, cycle: 1, cause: { kind: "end", reason: reasons.event } }],
        marks: [],
        sync: [],
        ...(reasons.end === undefined
          ? {}
          : { end: { seq: 1, tick: 1, cycle: 1, reason: reasons.end } }),
      },
    ],
  };
}

test("the writer stamps version 2; the reader accepts the released 1 and the current 2", () => {
  assert.equal(HISTORY_FORMAT_VERSION, 2);
  assert.deepEqual(HISTORY_FORMAT_READ_VERSIONS, [1, 2]);
});

test("a version 1 recording validates unchanged and keeps its own version stamp", () => {
  const input = endedRecording(1, { event: "quit", end: "quit" });
  const before = structuredClone(input);
  const recording = validateHistoryRecording(input);
  assert.equal(recording.version, 1);
  assert.deepEqual(input, before, "validation must not mutate its input");
  // A record built from known fields re-serializes byte-exact — the
  // released archive's untouched re-export rests on this normalization.
  assert.equal(JSON.stringify(recording), JSON.stringify(input));
});

test("a version 2 recording validates and keeps its own version stamp", () => {
  const input = endedRecording(2, { event: "eject", end: "eject" });
  const recording = validateHistoryRecording(input);
  assert.equal(recording.version, 2);
  assert.equal(JSON.stringify(recording), JSON.stringify(input));
});

test("version 2 admits the debugger end reason in the event stream and the segment end", () => {
  const recording = validateHistoryRecording(
    endedRecording(2, { event: "debugger", end: "debugger" }),
  );
  assert.deepEqual(recording.segments[0]?.events[0]?.cause, {
    kind: "end",
    reason: "debugger",
  });
  assert.equal(recording.segments[0]?.end?.reason, "debugger");
});

test("version 1 rejects the debugger reason in the event stream and the segment end", () => {
  for (const input of [
    endedRecording(1, { event: "debugger", end: "quit" }),
    endedRecording(1, { event: "quit", end: "debugger" }),
    endedRecording(1, { event: "debugger", end: "debugger" }),
  ]) {
    const before = structuredClone(input);
    assert.throws(() => validateHistoryRecording(input), /end reason is invalid/);
    assert.deepEqual(input, before, "a refused read must not mutate its input");
  }
});

test("version 2 still admits every released end reason", () => {
  const released: HistoryEndReason[] = ["boot", "walkthrough", "resume", "quit", "budget", "eject"];
  for (const reason of released) {
    const recording = validateHistoryRecording(endedRecording(2, { event: reason, end: reason }));
    assert.equal(recording.segments[0]?.end?.reason, reason);
    assert.deepEqual(recording.segments[0]?.events[0]?.cause, { kind: "end", reason });
  }
});

test("both versions reject a reason no contract knows", () => {
  for (const version of [1, 2]) {
    assert.throws(
      () => validateHistoryRecording(endedRecording(version, { end: "hibernate" })),
      /end reason is invalid/,
    );
  }
});

test("an unknown recording version is refused without rewriting the record", () => {
  for (const version of [0, 3, -1, 1.5, "2", null, undefined]) {
    const input = endedRecording(version, {});
    const before = structuredClone(input);
    assert.throws(() => validateHistoryRecording(input), /unsupported version/);
    assert.deepEqual(input, before);
  }
});
