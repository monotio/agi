import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_RECORDED_BYTES,
  OperationRecorder,
  type RecordedHostCall,
} from "../src/agent/recordedReplay.ts";

function serialized(recorder: OperationRecorder): number {
  // The validator's exact limit: JSON.stringify(operations).length.
  return JSON.stringify(recorder.operations).length;
}

function tickWith(recorder: OperationRecorder, ...calls: RecordedHostCall[]) {
  recorder.run("tick", () => {
    for (const call of calls) recorder.host(call);
  });
}

test("recorder charges outer brackets and operation separators like the validator", () => {
  // 4865 ticks serialize to 180006 bytes; the pre-fix counter charged 35 bytes
  // per tick and accepted the whole tape.
  const accepted = new OperationRecorder();
  for (let i = 0; i < 4864; i++) tickWith(accepted, ["line", null], ["keys", []]);
  assert.equal(accepted.error, null);
  assert.equal(serialized(accepted), 179969);

  const rejected = new OperationRecorder();
  for (let i = 0; i < 4865; i++) tickWith(rejected, ["line", null], ["keys", []]);
  assert.equal(rejected.error, "Recording reached its size limit; record a shorter scenario.");
  assert.ok(serialized(rejected) <= MAX_RECORDED_BYTES);
});

test("recorder charges separators between nested host calls up to the exact limit", () => {
  // One tick of ["keys",[]] calls: 2 brackets + 11 for ["tick",[]] + 11 for the
  // first call + 12 per later call. 14999 calls serialize to exactly the limit.
  const exact = new OperationRecorder();
  tickWith(exact, ...Array.from({ length: 14999 }, (): RecordedHostCall => ["keys", []]));
  assert.equal(exact.error, null);
  assert.equal(serialized(exact), MAX_RECORDED_BYTES);

  const overflow = new OperationRecorder();
  tickWith(overflow, ...Array.from({ length: 15000 }, (): RecordedHostCall => ["keys", []]));
  assert.equal(overflow.error, "Recording reached its size limit; record a shorter scenario.");
  assert.ok(serialized(overflow) <= MAX_RECORDED_BYTES);
});

test("escaped text counts toward the limit exactly as JSON.stringify does", () => {
  // A line of 89988 quote characters escapes to 179978 JSON bytes; the tape
  // reaches exactly MAX_RECORDED_BYTES and must be accepted.
  const recorder = new OperationRecorder();
  tickWith(recorder, ["line", '"'.repeat(89988)]);
  assert.equal(recorder.error, null);
  assert.equal(serialized(recorder), MAX_RECORDED_BYTES);

  // One more host call crosses the limit and is rejected, leaving a valid tape.
  recorder.run("tick", () => recorder.host(["clock", 1]));
  assert.equal(recorder.error, "Recording reached its size limit; record a shorter scenario.");
  assert.ok(serialized(recorder) <= MAX_RECORDED_BYTES);
});

test("engine execution continues after recording stops at the size limit", () => {
  const recorder = new OperationRecorder();
  tickWith(recorder, ...Array.from({ length: 15000 }, (): RecordedHostCall => ["keys", []]));
  assert.notEqual(recorder.error, null);
  const before = recorder.operations.length;

  let executed = 0;
  recorder.run("tick", () => {
    executed++;
    recorder.host(["clock", 1]);
  });
  recorder.record(["ack"]);
  assert.equal(executed, 1);
  assert.equal(recorder.operations.length, before);
  assert.ok(serialized(recorder) <= MAX_RECORDED_BYTES);
});
